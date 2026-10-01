/* Candidate dispatch kernel. No timers, global state changes or game-code
 * patches. The native adapter must call this BEFORE a simulation step.
 * Unit/native-engine fixtures are not a certificate for a loaded PVG save. */
(function (root, factory) {
  const exports = factory();
  if (typeof module === "object" && module.exports) module.exports = exports;
  root.PVGDispatchCore = exports;
})(globalThis, function () {
  "use strict";

  const priority = route => ({ local: 1, rapid: 2, express: 3 }[route?.pvgOperatingMode] || 1);
  const directedKey = part => part.trackId + (part.reversed ? ":reverse" : ":forward");
  const comboFor = (train, route) => train.stComboOverrides?.[train.currentStComboInfo?.index] || route?.stCombos?.[train.currentStComboInfo?.index];
  const zonesFor = track => [...new Set([track?.pvgConflictZone, ...(track?.pvgConflictZones || [])].filter(Boolean))];
  // One decision frame only: do not retain occupations, reservations, mutable
  // route paths or train windows between native steps or save loads. Sharing
  // these indexes within the frame avoids a full-network scan per request.
  function decisionContext(state) {
    const tracks = new Map((state.tracks || []).map(t=>[t.id,t]));
    const routes = new Map((state.routes || []).map(r=>[r.id,r]));
    const trains = new Map((state.trains || []).map(t=>[t.id,t]));
    const stations = new Map((state.stations || []).flatMap(s=>(s.stNodeIds || []).map(id=>[id,s])));
    const zoneTracks = new Map(), conflictTracks = new Set(), owners = new Map(), paths = new Map();
    const addOwner = (id, owner) => {
      if (!owners.has(id)) owners.set(id,new Set());
      owners.get(id).add(owner);
    };
    for (const track of tracks.values()) for (const zone of zonesFor(track)) {
      if (!zoneTracks.has(zone)) zoneTracks.set(zone,new Set());
      zoneTracks.get(zone).add(track.id);
    }
    for (const train of trains.values()) for (const part of windowTracks(train)) addOwner(part.trackId,train.id);
    const now = state.timeConfig.elapsedSeconds;
    for (const signal of state.signals || []) {
      const ids = (signal.signalTracks || []).map(p=>p.trackId);
      if (["v-merge","diamond","scissors-crossover"].includes(signal.type)) for (const id of ids) conflictTracks.add(id);
      // Occupation history ages out, but a native reservation does not. A
      // waiting train can retain a reservation without refreshing its time.
      // Even an orphan reservation is a blocked resource, not permission to
      // bypass the native interlocking or silently clear it.
      const live = (signal.status?.occupations || []).filter(o=>o && o.timeVerified>=now-1);
      if(signal.status?.reservedBy)live.push(signal.status.reservedBy);
      for (const id of ids) for (const owner of live) addOwner(id,owner.trainId);
    }
    return {tracks,routes,trains,stations,zoneTracks,conflictTracks,owners,paths};
  }
  function indexedPath(combo, context) {
    if (!combo) return [];
    if (!context.paths.has(combo)) context.paths.set(combo,pathWithOffsets(combo));
    return context.paths.get(combo);
  }
  function conflictResources(ids, context) {
    const wanted = new Set(ids), zones = new Set(ids.flatMap(id=>zonesFor(context.tracks.get(id))));
    for (const zone of zones) for (const id of context.zoneTracks.get(zone) || []) wanted.add(id);
    return [...wanted];
  }
  function pathWithOffsets(combo) {
    let offset = 0;
    return (combo?.path || []).map(part => {
      const start = offset; offset += part.length;
      return { ...part, start, end: offset };
    });
  }
  const dwelling = train => train.motion?.speed === 0 && Number.isFinite(train.currentStComboInfo?.timeAtStop) && train.currentStComboInfo.timeAtStopEnd === null;
  const stopToken = train => [train.id, train.currentStComboInfo.index, train.currentStComboInfo.timeAtStop].join(":");
  function windowTracks(train) { return train.windows?.train?.tracks || []; }
  const comboAt = (train,route,index) => train.stComboOverrides?.[index] || route?.stCombos?.[index];
  const pathFingerprint = combo => JSON.stringify([combo?.startStNodeId,combo?.endStNodeId,
    (combo?.path || []).map(p=>[p.trackId,Boolean(p.reversed),p.length])]);

  // A native arrival changes the progress origin to the next leg's platform.
  // Count its overlapping platform only once. Support ONE forward leg, never
  // a reversal, cycle wrap, invented continuation or skipped native index.
  function exitClearance(fast,route,combo,path,merge,context) {
    const margin=25, required=fast.length+margin, end=path.at(-1)?.end || 0;
    const exitParts=path.filter(p=>p.start>=merge.end);
    const base={fastRouteId:route.id,fastComboIndex:fast.currentStComboInfo.index,
      fastPath:pathFingerprint(combo),clearAt:merge.end+margin};
    if(end-merge.end>=required) return {...base,exitTrackIds:[...new Set(exitParts.filter(p=>p.start<merge.end+required).map(p=>p.trackId))]};
    const nextIndex=fast.currentStComboInfo.index+1,nextCombo=comboAt(fast,route,nextIndex);
    if(!nextCombo || combo.endStNodeId!==nextCombo.startStNodeId) return null;
    const next=indexedPath(nextCombo,context);
    let overlap=0;
    for(let n=1;n<=Math.min(path.length,next.length);n++) {
      const tail=path.slice(-n),head=next.slice(0,n);
      if(tail.every((p,i)=>directedKey(p)===directedKey(head[i]) && p.length===head[i].length))overlap=n;
    }
    if(!overlap || overlap===next.length) return null;
    const suffix=path.slice(-overlap), mergeIndex=suffix.findIndex(p=>directedKey(p)===directedKey(merge));
    if(mergeIndex<0 || suffix.some(p=>context.tracks.get(p.trackId)?.type!=="station"))return null;
    const nextMerge=next[mergeIndex],nextEnd=next.at(-1).end;
    if(nextEnd-nextMerge.end<required || new Set(next.map(directedKey)).size!==next.length)return null;
    const nextExit=next.filter(p=>p.start>=nextMerge.end && p.start<nextMerge.end+required);
    return {...base,fastNextComboIndex:nextIndex,fastNextPath:pathFingerprint(nextCombo),
      transitionStNodeId:combo.endStNodeId,nextClearAt:nextMerge.end+margin,
      exitTrackIds:[...new Set(nextExit.map(p=>p.trackId))]};
  }

  function overtakeProgress(fast,route,hold) {
    if(!fast || !route || route.id!==hold.fastRouteId ||
      pathFingerprint(comboAt(fast,route,hold.fastComboIndex))!==hold.fastPath ||
      (hold.fastNextPath && pathFingerprint(comboAt(fast,route,hold.fastNextComboIndex))!==hold.fastNextPath))return "invalid";
    const index=fast.currentStComboInfo?.index;
    let clearAt;
    if(index===hold.fastComboIndex)clearAt=hold.clearAt;
    else if(index===hold.fastNextComboIndex && !fast.currentStComboInfo.reversesAtStop &&
      fast.timings?.some(t=>t.stNodeIndex===hold.fastNextComboIndex && t.stNodeId===hold.transitionStNodeId &&
        Number.isFinite(t.arrivalTime) && t.arrivalTime>=hold.startedAt))clearAt=hold.nextClearAt;
    else return "invalid";
    const tail=fast.windows?.train?.tailStComboProgress,body=windowTracks(fast);
    // Empty/missing windows cannot certify a vanished or relocated train.
    if(!Number.isFinite(tail) || !body.length)return "invalid";
    return tail>clearAt && !body.some(p=>hold.protectedTrackIds.includes(p.trackId)) ? "cleared" : "waiting";
  }

  // Native occupations and reservations remain authoritative. An empty list
  // of occupations is NOT proof of vacancy when a physical train spans it.
  function resourceOwners(state, trackIds, context = decisionContext(state)) {
    const owners = new Set();
    for (const id of trackIds) for (const owner of context.owners.get(id) || []) owners.add(owner);
    return owners;
  }

  // One complete throat + its exit berth is granted atomically. No partial
  // claims, expired-by-ETA release, or clearing native status is permitted.
  // The returned grants are decisions; a validated native adapter is still
  // required before they can control movement.
  function arbitrateThroats(state, requests, previous = [], context = decisionContext(state)) {
    const byTrain = context.trains, tracks = context.tracks;
    const grants = [], waiting = [], owners = new Map();
    const resources = request => [...new Set([...(request.throatTrackIds || []), ...(request.exitTrackIds || [])])];
    const claim = request => {
      const ids = resources(request);
      const zones = [...new Set(ids.flatMap(id => {
        const t = tracks.get(id);
        return zonesFor(t);
      }))];
      return [...ids.map(id => "track:" + id), ...zones.map(id => "zone:" + id)];
    };
    for (const held of previous) {
      // Release only following observed entry AND a full tail-clear report.
      // A vanished train cancels the claim; it is not counted as a traversal.
      const train = byTrain.get(held.trainId);
      if (!train) continue;
      const onThroat = windowTracks(train).some(p => held.throatTrackIds.includes(p.trackId));
      const onExit = windowTracks(train).some(p => held.exitTrackIds.includes(p.trackId));
      const entered = held.entered || onThroat;
      const exitSeen = held.exitSeen || onExit;
      if (entered && exitSeen && !onThroat && !onExit) continue;
      const grant = { ...held, entered, exitSeen };
      grants.push(grant);
      for (const key of claim(grant)) owners.set(key, grant.trainId);
    }
    const pending = [...requests].sort((a,b) => a.requestedAt-b.requestedAt || a.trainId.localeCompare(b.trainId));
    for (const request of pending) {
      if (grants.some(g => g.trainId === request.trainId)) continue;
      const train = byTrain.get(request.trainId), ids = resources(request);
      const exits = [...new Set(request.exitTrackIds || [])];
      const exitLength = exits.reduce((sum,id) => sum + (tracks.get(id)?.length || 0), 0);
      const invalid = !train || !Number.isFinite(train.length) || !Number.isFinite(request.requestedAt) || !request.throatTrackIds?.length || !exits.length ||
        exits.some(id=>(request.throatTrackIds || []).includes(id)) ||
        ids.some(id => !tracks.has(id) || tracks.get(id).buildType === "blueprint") || exitLength < train.length + 25;
      if (invalid) { waiting.push({ trainId: request.trainId, reason: "unusable-throat-or-exit" }); continue; }
      const heldBy = claim(request).map(key => owners.get(key)).filter(id => id && id !== request.trainId);
      const physical = [...resourceOwners(state, conflictResources(ids,context),context)].filter(id => id !== request.trainId);
      if (heldBy.length || physical.length) {
        waiting.push({ trainId: request.trainId, reason: "occupied-or-reserved", blockers: [...new Set([...heldBy, ...physical])] }); continue;
      }
      const grant = { ...request, entered: false, exitSeen: false };
      grants.push(grant);
      for (const key of claim(grant)) owners.set(key, train.id);
    }
    return { grants, waiting };
  }

  // Stage departure at an existing platform before ALL conflict rails in the
  // current native leg. Do not stop a moving train, invent an exit, or claim
  // that this replaces native interlocking. Claims extend through a real exit
  // berth and remain until the train's whole body has left it.
  function planThroatDepartures(state, previous = {}, excludedTrainIds = [], context = decisionContext(state)) {
    const now=state.timeConfig.elapsedSeconds, {tracks,routes,stations}=context;
    const excluded=new Set(excludedTrainIds), requests=[], diagnostics=[];
    const liveTokens=new Set(state.trains.filter(dwelling).map(stopToken));
    const completed=new Set((previous.completedStops || []).filter(token=>liveTokens.has(token)));
    const oldHolds=new Map((previous.holds || []).map(h=>[h.stopToken,h]));
    const signalTracks=context.conflictTracks;
    for(const train of state.trains) {
      if(!dwelling(train) || excluded.has(train.id) || completed.has(stopToken(train)) || train.currentStComboInfo.reversesAtStop) continue;
      const route=routes.get(train.routeId), combo=comboFor(train,route), station=stations.get(combo?.startStNodeId);
      const node=route?.stNodes?.find(n=>n.id===combo?.startStNodeId);
      if(!combo || route.disruption || !station || station.buildType==="blueprint" || !node?.trackIds?.length) continue;
      const platform=new Set(node.trackIds);
      if(windowTracks(train).some(p=>!platform.has(p.trackId))) continue;
      const path=combo.path || [], conflicts=path.flatMap((p,i)=>!platform.has(p.trackId) &&
        (zonesFor(tracks.get(p.trackId)).length || signalTracks.has(p.trackId)) ? [i] : []);
      if(!conflicts.length) continue;
      const first=conflicts[0],last=conflicts.at(-1), exits=[];let length=0;
      for(const p of path.slice(last+1)) {
        if(exits.includes(p.trackId)) break;
        exits.push(p.trackId);length+=tracks.get(p.trackId)?.length || 0;
        if(length>=train.length+25) break;
      }
      if(length<train.length+25) { diagnostics.push({trainId:train.id,reason:"no-native-exit-berth"});continue; }
      const token=stopToken(train),old=oldHolds.get(token);
      if(old && now>=old.deadline) {completed.add(token);diagnostics.push({trainId:train.id,reason:"bounded-admission-wait-expired"});continue;}
      requests.push({trainId:train.id,throatTrackIds:[...new Set(path.slice(first,last+1).map(p=>p.trackId))],exitTrackIds:exits,
        requestedAt:old?.startedAt ?? now,stopToken:token,stationId:station.id,stNodeId:combo.startStNodeId,
        arrivalTime:train.currentStComboInfo.timeAtStop,deadline:old?.deadline ?? now+180});
    }
    const arbitration=arbitrateThroats(state,requests,previous.grants || [],context);
    const holds=arbitration.waiting.flatMap(w=>{
      const r=requests.find(r=>r.trainId===w.trainId);
      return r ? [{...r,slowId:r.trainId,kind:"throat-admission",startedAt:r.requestedAt,blockers:w.blockers || []}] : [];
    });
    const events=holds.filter(h=>!oldHolds.has(h.stopToken)).map(h=>({type:"throat-wait",slowId:h.slowId,blockers:h.blockers}));
    for(const h of previous.holds || []) if(!holds.some(next=>next.stopToken===h.stopToken))
      events.push({type:"throat-release",slowId:h.slowId,reason:completed.has(h.stopToken)?"bounded-wait-expired":"recheck-or-granted"});
    return {...arbitration,holds,completedStops:[...completed],events,diagnostics};
  }

  // Bounded to the current leg plus at most one verified forward native leg.
  // Both services must rejoin the SAME directed physical rail. Exit vacancy
  // includes a full train + 25m, and release requires the actual tail + 25m.
  function planOvertakes(state, previous = { holds: [], completedStops: [] }, options = {}, context = decisionContext(state)) {
    const now = state.timeConfig.elapsedSeconds, {tracks,routes,trains}=context;
    const stationByNode = context.stations;
    const maxWait = Math.min(180, Math.max(1, options.maxWaitSeconds || 120));
    const maxApproach = Math.min(120, Math.max(1, options.lookaheadSeconds || 90));
    const diagnostics = options.diagnostics ? {dwellingTrains:0,eligiblePlatforms:0,priorityPairs:0,rejections:{}} : null;
    const reject = reason => { if(diagnostics) diagnostics.rejections[reason]=(diagnostics.rejections[reason] || 0)+1; };
    const holds = [], events = [], completed = new Set(previous.completedStops || []);
    const liveTokens = new Set(state.trains.filter(dwelling).map(stopToken));
    for (const token of completed) if (!liveTokens.has(token)) completed.delete(token);
    for (const held of previous.holds || []) {
      const slow = trains.get(held.slowId), fast = trains.get(held.fastId);
      let reason = null;
      if (!slow || !dwelling(slow) || stopToken(slow) !== held.stopToken) reason = "stop-ended";
      else if (!fast || !routes.has(fast.routeId)) reason = "fast-service-missing";
      else if (now >= held.deadline) reason = "bounded-wait-expired";
      else {
        // Missing/mutated paths are not a successful overtake. Cancellation
        // returns control to the original native interlocking.
        const progress=overtakeProgress(fast,routes.get(fast.routeId),held);
        if(progress==="invalid")reason="path-changed-or-unobserved-exit";
        else if(progress==="cleared")reason="tail-cleared";
      }
      if (reason) { events.push({ type: "release", reason, slowId: held.slowId, fastId: held.fastId }); completed.add(held.stopToken); }
      else holds.push(held);
    }
    const holding = new Set(holds.map(h => h.slowId)), expedited = new Set(holds.map(h => h.fastId));
    const candidates = state.trains.filter(dwelling).sort((a,b) => a.currentStComboInfo.timeAtStop-b.currentStComboInfo.timeAtStop || a.id.localeCompare(b.id));
    if(diagnostics) diagnostics.dwellingTrains=candidates.length;
    for (const slow of candidates) {
      if (holding.has(slow.id) || expedited.has(slow.id) || completed.has(stopToken(slow))) continue;
      const route = routes.get(slow.routeId), combo = route && comboFor(slow,route);
      if (!combo || slow.currentStComboInfo.reversesAtStop || route.disruption) {reject("unusable-local-leg");continue;}
      const station = stationByNode.get(combo.startStNodeId);
      const node = route.stNodes?.find(n => n.id === combo.startStNodeId);
      if (!station || station.buildType === "blueprint" || !node?.trackIds?.length) {reject("missing-native-platform");continue;}
      const platformIds = new Set(node.trackIds), slowParts = indexedPath(combo,context);
      const platformLength = node.trackIds.reduce((sum,id) => sum + (tracks.get(id)?.length || 0),0);
      if (platformLength < slow.length + 10 || windowTracks(slow).some(p => !platformIds.has(p.trackId))) {reject("body-not-within-usable-platform");continue;}
      if(diagnostics) diagnostics.eligiblePlatforms++;
      const slowByKey = new Map(slowParts.filter(p => !platformIds.has(p.trackId)).map(p => [directedKey(p),p]));
      const choices = [];
      for (const fast of state.trains) {
        const fastRoute = routes.get(fast.routeId);
        if (fast.id === slow.id || holding.has(fast.id) || expedited.has(fast.id) || !fastRoute || fastRoute.disruption ||
          priority(fastRoute) <= priority(route) || !(fast.motion?.speed > 0)) continue;
        if(diagnostics) diagnostics.priorityPairs++;
        const fastCombo=comboFor(fast,fastRoute),path = indexedPath(fastCombo,context);
        const head = fast.windows?.train?.headStComboProgress;
        if (!Number.isFinite(head)) {reject("missing-native-window");continue;}
        const merge = path.find(p => p.start > head && slowByKey.has(directedKey(p)));
        if (!merge) {reject("no-forward-shared-reconnection");continue;}
        const approach = path.filter(p => p.end > head && p.start < merge.start);
        // A label alone is insufficient: an independent constructed bypass
        // and an actual native reconnection to the outgoing rail are required.
        const bypass=approach.find(p=>tracks.get(p.trackId)?.pvgRole === "express-bypass");
        if (!bypass ||
          approach.some(p => platformIds.has(p.trackId) || tracks.get(p.trackId)?.buildType === "blueprint")) {reject("no-independent-constructed-bypass");continue;}
        // Approach is to ENTRY, not the downstream merge. A long connected
        // bypass is already a safe independent running path; charging its
        // whole length to lookahead made real station holds unreachable.
        // Exit admission and observed tail-clear remain separate gates.
        const entryDistance=Math.max(0,bypass.start-head);
        if(entryDistance/fast.motion.speed>maxApproach || entryDistance>3000) {reject("outside-approach-window");continue;}
        const localApproach = slowParts.filter(p => p.start < slowByKey.get(directedKey(merge)).start);
        const localKeys = new Set(localApproach.map(directedKey));
        if (approach.some(p => localKeys.has(directedKey(p)))) {reject("approach-still-shared-with-local");continue;}
        const protectedTrackIds = [...new Set([...approach.map(p => p.trackId), merge.trackId])];
        if ([...resourceOwners(state, protectedTrackIds,context)].some(id => id !== fast.id)) {reject("protected-rail-occupied-or-reserved");continue;}
        const clearance=exitClearance(fast,fastRoute,fastCombo,path,merge,context);
        if(!clearance || clearance.exitTrackIds.some(id=>!tracks.has(id) || tracks.get(id).buildType==="blueprint")) {reject("insufficient-native-exit");continue;}
        if([...resourceOwners(state,conflictResources(clearance.exitTrackIds,context),context)].some(id=>id!==fast.id)) {reject("native-exit-occupied-or-reserved");continue;}
        const exitTiming=fastRoute.stComboTimings?.find(t=>t.stNodeIndex===clearance.fastNextComboIndex);
        const exitDwell=exitTiming && Number.isFinite(exitTiming.arrivalTime) && Number.isFinite(exitTiming.departureTime)?
          Math.max(0,exitTiming.departureTime-exitTiming.arrivalTime):0;
        const estimatedClearSeconds=(merge.end+fast.length+25-head)/fast.motion.speed+exitDwell;
        // A forecast may reject a futile request, NEVER release a hold. Actual
        // native tail/body/timing evidence still decides successful release.
        if(estimatedClearSeconds>maxWait) {reject("clearance-outside-wait-budget");continue;}
        choices.push({ fast, clearance, protectedTrackIds, eta: (merge.start-head)/fast.motion.speed });
      }
      choices.sort((a,b) => a.eta-b.eta || a.fast.id.localeCompare(b.fast.id));
      if (!choices.length) continue;
      const { fast, clearance, protectedTrackIds } = choices[0];
      const held = { slowId: slow.id, fastId: fast.id, stationId: station.id, stNodeId: combo.startStNodeId, stopToken: stopToken(slow),
        arrivalTime: slow.currentStComboInfo.timeAtStop, startedAt: now, deadline: now+maxWait,
        ...clearance, protectedTrackIds };
      holds.push(held); holding.add(slow.id); expedited.add(fast.id);
      events.push({ type: "hold", slowId: slow.id, fastId: fast.id, stationId: station.id });
    }
    return { holds, completedStops: [...completed], events, ...(diagnostics ? {diagnostics} : {}) };
  }

  function planDispatch(state, previousOvertakes, previousThroats, options = {}) {
    const context = decisionContext(state);
    const overtaking = planOvertakes(state,previousOvertakes,options,context);
    const throats = options.throatAdmission === false ? {} : planThroatDepartures(state,previousThroats,
      overtaking.holds.flatMap(h=>[h.slowId,h.fastId]),context);
    return {overtaking,throats};
  }

  // Native-engine adapter: preserve real arrival/departure timings, motion,
  // passenger state and signals. Only extra station dwell is supplied during
  // this synchronous step. Original type definitions and IDs survive even on
  // errors. Apply to the directed platform lookup, NOT the whole station:
  // opposite-direction trains at the same station must keep their own dwell.
  // The caller must not persist or asynchronously retain the lookup.
  function withNativeDwell(state, plan, stationTypes, trainTypes, step) {
    const temporary = new Map();
    const stNodeIdToStationMap = new Map(state.stations.flatMap(s => s.stNodeIds.map(id => [id,s])));
    try {
      for (const hold of plan.holds) {
      const train = state.trains.find(t => t.id === hold.slowId);
      const station = state.stations.find(s => s.id === hold.stationId);
      if (!train || !station || !dwelling(train) || stopToken(train) !== hold.stopToken) continue;
      const baseId = station.stationType || "standard", base = stationTypes[baseId];
      const stats = trainTypes[train.trainType]?.stats;
      if (!base || !stats || !Number.isFinite(stats.stopTimeSeconds)) throw Error("Native station/train dwell definitions unavailable");
      const id = "pvg-dispatch-transient:" + hold.stNodeId;
      if (stationTypes[id]) throw Error("Transient dispatch type collision");
      const extraDwellTime = Math.max(base.extraDwellTime || 0, hold.deadline-hold.arrivalTime-stats.stopTimeSeconds);
      stationTypes[id] = { ...base, id, extraDwellTime };
      temporary.set(id, baseId);
      stNodeIdToStationMap.set(hold.stNodeId, { ...station, stationType: id });
      }
      const result = step({ stations: state.stations, stNodeIdToStationMap });
      if (result?.then) throw Error("Asynchronous simulation adapter is unsupported");
      if (result?.newStations) result.newStations = result.newStations.map(s => temporary.has(s.stationType) ? { ...s, stationType: temporary.get(s.stationType) } : s);
      return result;
    } finally {
      for (const id of temporary.keys()) delete stationTypes[id];
    }
  }

  // The current desktop simulation runs synchronously in the main renderer.
  // Its official station registry is shared, but dwell is evaluated separately
  // for every train. Scope the registry lookup to that train for the duration
  // of ONE native call. No station IDs, arrays, paths or arrival timestamps
  // are changed. This also avoids delaying the opposite platform in a shared
  // native station component. Accessors are removed before saving/UI yields.
  function withLiveNativeDwell(state, plan, stationTypes, trainTypes, step) {
    if (!plan.holds.length) return step();
    const held = new Map(plan.holds.map(h => [h.slowId,h]));
    const trains = new Map(state.trains.map(t => [t.id,t]));
    const savedTrains = [], savedInfos=[], savedTypes = [];
    let activeTrain = null;
    try {
      for (const train of state.trains) {
        const descriptor = Object.getOwnPropertyDescriptor(train,"currentStComboInfo");
        if (!descriptor || !descriptor.configurable || descriptor.get || descriptor.set) throw Error("Native train access is already wrapped");
        let value = descriptor.value;
        Object.defineProperty(train,"currentStComboInfo",{configurable:true,enumerable:descriptor.enumerable,
          get() { return value; },set(next) { value=next; }});
        savedTrains.push({train,descriptor,current:()=>value});
        // Native updateMultipleGameState spreads every train between ticks.
        // The root accessor does not survive that spread; its shared dwell
        // info DOES. Native reads index immediately before station dwell.
        const info=value, indexDescriptor=Object.getOwnPropertyDescriptor(info,"index");
        if(!indexDescriptor?.configurable || indexDescriptor.get || indexDescriptor.set)throw Error("Native dwell index access is already wrapped");
        let index=indexDescriptor.value;
        Object.defineProperty(info,"index",{configurable:true,enumerable:indexDescriptor.enumerable,
          get(){activeTrain=train;return index;},set(next){index=next;}});
        savedInfos.push({info,descriptor:indexDescriptor,current:()=>index});
      }
      const baseTypeIds = new Set(plan.holds.map(h => state.stations.find(s=>s.id===h.stationId)?.stationType || "standard"));
      for (const id of baseTypeIds) {
        const type=stationTypes[id];
        const descriptor=type && Object.getOwnPropertyDescriptor(type,"extraDwellTime");
        if (!descriptor || !descriptor.configurable || descriptor.get || descriptor.set) throw Error("Native dwell registry is already wrapped");
        Object.defineProperty(type,"extraDwellTime",{configurable:true,enumerable:descriptor.enumerable,get() {
          const train=activeTrain,hold=train && held.get(train.id);activeTrain=null;
          try {
          if (!hold || !dwelling(train) || stopToken(train)!==hold.stopToken) return descriptor.value;
          if(hold.kind==="throat-admission") {
            const stats=trainTypes[train.trainType]?.stats;
            if(!stats || !Number.isFinite(stats.stopTimeSeconds)) throw Error("Native train dwell definition unavailable");
            return Math.max(descriptor.value || 0,hold.deadline-hold.arrivalTime-stats.stopTimeSeconds);
          }
          const fast=trains.get(hold.fastId);
          // The native engine updates moving train windows in place between
          // its internal ticks. A full tail clear can therefore release dwell
          // within a fast-speed batch, not only at the next rendered frame.
          if(overtakeProgress(fast,state.routes.find(r=>r.id===fast?.routeId),hold)!=="waiting")return descriptor.value;
          const stats=trainTypes[train.trainType]?.stats;
          if (!stats || !Number.isFinite(stats.stopTimeSeconds)) throw Error("Native train dwell definition unavailable");
          return Math.max(descriptor.value || 0,hold.deadline-hold.arrivalTime-stats.stopTimeSeconds);
          }finally{activeTrain=null;}
        }});
        savedTypes.push({type,descriptor});
      }
      return step();
    } finally {
      for (const {type,descriptor} of savedTypes) Object.defineProperty(type,"extraDwellTime",descriptor);
      for(const {info,descriptor,current} of savedInfos)Object.defineProperty(info,"index",{...descriptor,value:current()});
      for (const {train,descriptor,current} of savedTrains) Object.defineProperty(train,"currentStComboInfo",{...descriptor,value:current()});
    }
  }


  // Retain the occupied platform signal behind the resident train's nose,
  // rather than re-requesting it in its forward warning window. Incoming legs
  // still cover the WHOLE platform. Physical collision windows and native
  // reservation/occupation records are never edited. Native clone batches
  // share these route parts, unlike transient root train accessors.
  function withLivePlatformEgress(state,step,onDecision=()=>{}) {
    const routes=new Map(state.routes.map(r=>[r.id,r])),tracks=new Map(state.tracks.map(t=>[t.id,t]));
    const signals=new Map(state.signals.map(s=>[s.id,s])),saved=new Map();
    const prefixFor=combo=>{
      const prefix=[];for(const p of combo?.path || []){if(tracks.get(p.trackId)?.type!=="station")break;prefix.push(p);}return prefix;
    };
    const nonPrefix=new Set();
    for(const r of state.routes)for(const c of r.stCombos || [])for(const p of (c.path || []).slice(prefixFor(c).length))nonPrefix.add(p);
    try{
      for(const train of state.trains){
        const route=routes.get(train.routeId),combo=comboFor(train,route),prefix=prefixFor(combo),node=route?.stNodes?.find(n=>n.id===combo?.startStNodeId);
        const ids=new Set(prefix.map(p=>p.trackId)),body=windowTracks(train),head=train.windows?.train?.headStComboProgress;
        const length=prefix.reduce((sum,p)=>sum+p.length,0),center=length/2;
        if(route?.disruption || !node?.trackIds?.length || ids.size!==node.trackIds.length || node.trackIds.some(id=>!ids.has(id)) ||
          !body.length || body.some(p=>!ids.has(p.trackId)) || !Number.isFinite(head) || head<=center || head>length ||
          prefix.some(p=>nonPrefix.has(p) || tracks.get(p.trackId)?.buildType==="blueprint") ||
          (combo.path || []).slice(prefix.length).some(p=>ids.has(p.trackId)))continue;
        let offset=0;
        for(const p of prefix){
          const covered=Math.max(0,Math.min(p.length,center-offset));offset+=p.length;
          const refs=(p.signals || []).flatMap(ref=>{
            const signal=signals.get(ref.signalId),rails=signal?.signalTracks || [];
            if(signal?.type!=="station" || signal.buildType==="blueprint" || !rails.length || rails.some(r=>!ids.has(r.trackId)))return [ref];
            if(!covered)return [];
            const area=p.reversed?{start:p.length-covered,end:p.length}:{start:0,end:covered};
            const original=ref.areaCovered;
            if(original!=="all"){
              if(!Number.isFinite(original?.start) || !Number.isFinite(original?.end))return [ref];
              area.start=Math.max(area.start,original.start);area.end=Math.min(area.end,original.end);
              if(area.start>area.end)return [];
            }
            return [{...ref,areaCovered:area}];
          });
          if(JSON.stringify(refs)===JSON.stringify(p.signals || []))continue;
          if(!saved.has(p)){const descriptor=Object.getOwnPropertyDescriptor(p,"signals");
            if(!descriptor?.configurable || descriptor.get || descriptor.set)throw Error("Native path signal access is already wrapped");
            saved.set(p,descriptor);}
          p.signals=refs;
          onDecision({trainId:train.id,trackId:p.trackId,kind:"occupied-platform-egress"});
        }
      }
      return step();
    }finally{for(const [part,descriptor] of saved)Object.defineProperty(part,"signals",descriptor);}
  }

  return { arbitrateThroats, planThroatDepartures, planOvertakes, planDispatch, withNativeDwell, withLiveNativeDwell, withLivePlatformEgress, resourceOwners };
});

/* Own-code, add-only connected bypass planner. Native validation/construction
 * remains mandatory. Existing rails are never split or moved under trains. */
(function(root,factory){const value=factory();if(typeof module==="object"&&module.exports)module.exports=value;root.PVGExpansionCore=value;})(globalThis,function(){
  "use strict";
  const metric=p=>[(p[0]-121.5)*95500,(p[1]-31.2)*110540];
  const geographic=p=>[121.5+p[0]/95500,31.2+p[1]/110540];
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  const minus=(a,b)=>[a[0]-b[0],a[1]-b[1]];
  const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*x*(10+x*(-15+6*x));};
  const same=(a,b)=>distance(a,b)<.02;
  const bounds=points=>[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  const overlaps=(a,b)=>a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
  function segmentHit(a,b,c,d) {
    const u=minus(b,a),v=minus(d,c),w=minus(c,a),denom=cross(u,v);
    if(Math.abs(denom)<1e-8) {
      if(Math.abs(cross(w,u))>1e-6) return null;
      const len=u[0]*u[0]+u[1]*u[1];if(!len)return null;
      const t=p=>((p[0]-a[0])*u[0]+(p[1]-a[1])*u[1])/len;
      const lo=Math.max(0,Math.min(t(c),t(d))),hi=Math.min(1,Math.max(t(c),t(d)));
      return hi>=lo-1e-8?{t:(lo+hi)/2,point:[a[0]+u[0]*(lo+hi)/2,a[1]+u[1]*(lo+hi)/2],coincident:(hi-lo)*Math.sqrt(len)>.02}:null;
    }
    const t=cross(w,v)/denom,q=cross(w,u)/denom;
    return t>=-1e-8&&t<=1+1e-8&&q>=-1e-8&&q<=1+1e-8?{t,q,point:[a[0]+t*u[0],a[1]+t*u[1]],coincident:false}:null;
  }
  function inside(point,ring) {
    let result=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j];
      if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
    }
    return result;
  }
  function outlineIndex(geometries) {
    if(!Array.isArray(geometries)||!geometries.length)throw Error("缺少完整排除边界，不能自动施工。");
    return geometries.flatMap(g=>{
      if(!g || !["Polygon","MultiPolygon"].includes(g.type))throw Error("排除边界格式不受支持。");
      return (g.type==="Polygon"?[g.coordinates]:g.coordinates).map(rings=>{
        if(!rings.length || rings.some(r=>r.length<4 || r.some(p=>p.length<2 || !p.every(Number.isFinite))))throw Error("排除边界不完整。");
        const points=rings.map(r=>r.map(metric));return {rings:points,bbox:bounds(points.flat())};
      });
    });
  }
  function clearOfOutlines(points,outlines,clearance=3) {
    const box=bounds(points),padded=[box[0]-clearance,box[1]-clearance,box[2]+clearance,box[3]+clearance];
    const segmentDistance=(p,a,b)=>{const u=minus(b,a),len=u[0]*u[0]+u[1]*u[1],t=len?Math.max(0,Math.min(1,((p[0]-a[0])*u[0]+(p[1]-a[1])*u[1])/len)):0;return distance(p,[a[0]+t*u[0],a[1]+t*u[1]]);};
    for(const polygon of outlines) {
      if(!overlaps(padded,polygon.bbox))continue;
      if(points.some(p=>inside(p,polygon.rings[0])&&!polygon.rings.slice(1).some(r=>inside(p,r))))return false;
      for(const ring of polygon.rings)for(let j=1;j<ring.length;j++)for(let i=1;i<points.length;i++) {
        const a=points[i-1],b=points[i],c=ring[j-1],d=ring[j];
        if(segmentHit(a,b,c,d)||Math.min(segmentDistance(a,c,d),segmentDistance(b,c,d),segmentDistance(c,a,b),segmentDistance(d,a,b))<=clearance)return false;
      }
    }
    return true;
  }
  function curveStats(points) {
    let minRadius=Infinity,maxTurn=0;
    for(let i=1;i<points.length-1;i++) {
      const a=minus(points[i],points[i-1]),b=minus(points[i+1],points[i]),la=Math.hypot(...a),lb=Math.hypot(...b);
      if(la<1e-6 || lb<1e-6)return {minRadius:0,maxTurn:180};
      const turn=Math.atan2(Math.abs(cross(a,b)),a[0]*b[0]+a[1]*b[1]);maxTurn=Math.max(maxTurn,turn*180/Math.PI);
      const area=Math.abs(cross(a,b));if(area>1e-8)minRadius=Math.min(minRadius,la*lb*distance(points[i-1],points[i+1])/(2*area));
    }
    return {minRadius,maxTurn};
  }
  function samples(points,step=5) {
    const output=[points[0]];
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],n=Math.max(1,Math.ceil(distance(a,b)/step));
      for(let k=1;k<=n;k++)output.push([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);
    }
    return output;
  }
  const physicalKey=t=>JSON.stringify([t.id,t.coords,t.trackType,t.type,t.buildType,t.startElevation,t.endElevation,t.reversable]);
  const networkKey=state=>JSON.stringify((state.tracks || []).map(physicalKey).sort());
  function planBypass(state,routeId,stNodeId,options={}) {
    const outlines=outlineIndex(options.exclusionGeometries),route=state.routes.find(r=>r.id===routeId);
    const index=new Map(state.tracks.map(t=>[t.id,t])),node=route?.stNodes.find(n=>n.id===stNodeId);
    const at=route?.stNodes.findIndex(n=>n.id===stNodeId);
    if(!node || at<1 || at>=route.stCombos.length || node.trackIds?.length!==2)throw Error("仅对已有完整双半段站台的中途站补建通过线；端点需另行设计。");
    if(state.trackGroups.some(g=>g.pvgExpansionNodeId===stNodeId))throw Error("此方向已补建接轨，不重复施工。");
    const platform=new Set(node.trackIds),before=route.stCombos[at-1].path,after=route.stCombos[at].path;
    const inbound=before.filter(p=>!platform.has(p.trackId)),outbound=after.filter(p=>!platform.has(p.trackId));
    const minimum=Number(options.minimumRadius)||600,transition=Math.max(250,Math.sqrt(minimum*18)*4);
    const select=(parts,reverse)=>{let length=0,chosen=[];for(const part of reverse?[...parts].reverse():parts){
      const track=index.get(part.trackId);if(!track || track.type==="station" || track.buildType!=="constructed")break;
      chosen.push(part);length+=track.length;if(length>=transition)break;
    }return reverse?chosen.reverse():chosen;};
    const lead=select(inbound,true),tail=select(outbound,false);
    const stationParts=after.slice(0,node.trackIds.length);
    if(!lead.length || !tail.length || stationParts.some(p=>!platform.has(p.trackId)))throw Error("车站前后缺少可接入的原生轨道，未凭空连接。");
    const pieces=[...lead,...stationParts,...tail];
    if(pieces.some(p=>index.get(p.trackId).trackType!==index.get(node.trackIds[0]).trackType))throw Error("接轨范围制式不一致。");
    const directed=p=>{const points=index.get(p.trackId).coords.map(metric);return p.reversed?points.reverse():points;};
    const points=[];for(const p of pieces){const rail=directed(p);if(points.length&&!same(points.at(-1),rail[0]))throw Error("原生区间存在断点。");points.push(...rail.slice(points.length?1:0));}
    const base=samples(points),s=[0];for(let i=1;i<base.length;i++)s.push(s.at(-1)+distance(base[i-1],base[i]));
    const leadLength=lead.reduce((sum,p)=>sum+index.get(p.trackId).length,0),platformLength=stationParts.reduce((sum,p)=>sum+index.get(p.trackId).length,0);
    const affectedTrackIds=[...new Set(pieces.map(p=>p.trackId))],oldRails=state.tracks.map(t=>({track:t,points:t.coords.map(metric)}));
    const oldStart=index.get(pieces[0].trackId),oldEnd=index.get(pieces.at(-1).trackId);
    const startZ=pieces[0].reversed?oldStart.endElevation:oldStart.startElevation,endZ=pieces.at(-1).reversed?oldEnd.startElevation:oldEnd.endElevation;
    if(!Number.isFinite(startZ)||!Number.isFinite(endZ))throw Error("接轨高程不完整。");
    for(const shift of [12,-12,18,-18,24,-24]) {
      const changed=base.map((p,i)=>{
        const a=base[Math.max(0,i-1)],b=base[Math.min(base.length-1,i+1)],u=minus(b,a),l=Math.hypot(...u);
        const weight=smooth(s[i]/leadLength)*smooth((s.at(-1)-s[i])/(s.at(-1)-leadLength-platformLength));
        return [p[0]-u[1]/l*shift*weight,p[1]+u[0]/l*shift*weight];
      });
      changed[0]=base[0];changed[changed.length-1]=base.at(-1);
      const stats=curveStats(changed),box=bounds(changed);
      if(stats.minRadius<minimum*1.01 || stats.maxTurn>3 || !clearOfOutlines(changed,outlines,3))continue;
      let invalid=false;
      const oldLength=s.at(-1),newLength=changed.slice(1).reduce((sum,p,i)=>sum+distance(changed[i],p),0);
      if(Math.abs(endZ-startZ)/newLength>.04)continue;
      const z=f=>startZ+(endZ-startZ)*f;
      for(const rail of oldRails) {
        if(!overlaps(box,bounds(rail.points)))continue;
        let candidateProgress=0;
        for(let i=1;i<changed.length&&!invalid;i++) {
          let railProgress=0;
          for(let j=1;j<rail.points.length&&!invalid;j++) {
            const a=changed[i-1],b=changed[i],c=rail.points[j-1],d=rail.points[j],hit=segmentHit(a,b,c,d);
            if(hit) {
              const railLength=rail.points.slice(1).reduce((sum,p,k)=>sum+distance(rail.points[k],p),0);
              const otherZ=rail.track.startElevation+(rail.track.endElevation-rail.track.startElevation)*(railProgress+(hit.q??0)*distance(c,d))/railLength;
              const gap=Math.abs(z((candidateProgress+hit.t*distance(a,b))/newLength)-otherZ);
              const sharedPort=[changed[0],changed.at(-1)].some(p=>same(p,hit.point)&&[rail.points[0],rail.points.at(-1)].some(q=>same(q,p)));
              // Only exact common endpoints are switches. Nearby parallel
              // rails or coincident tangent leads must not be merged.
              if(!sharedPort && (!Number.isFinite(gap)||gap<3))invalid=true;
              if(hit.coincident)invalid=true;
            }
            railProgress+=distance(c,d);
          }
          candidateProgress+=distance(changed[i-1],changed[i]);
        }
        if(invalid)break;
      }
      if(invalid)continue;
      const id=options.id || "pvg-expansion-"+globalThis.crypto.randomUUID();
      const coords=changed.map(geographic);coords[0]=index.get(pieces[0].trackId).coords[pieces[0].reversed?index.get(pieces[0].trackId).coords.length-1:0];
      coords[coords.length-1]=index.get(pieces.at(-1).trackId).coords[pieces.at(-1).reversed?0:index.get(pieces.at(-1).trackId).coords.length-1];
      const track={id:id+"-rail",coords,length:newLength,type:null,trackType:index.get(node.trackIds[0]).trackType,
        buildType:"blueprint",displayType:"blueprint",interactable:true,reversable:true,curveType:"bezier",
        startElevation:startZ,endElevation:endZ,pvgRole:"express-bypass",pvgExpansionId:id,createdAt:Date.now()};
      const group={id:id+"-group",trackIds:[track.id],centerLine:coords,trackLanesType:"single",type:null,trackType:track.trackType,
        pvgRole:"express-bypass",pvgExpansionId:id,pvgExpansionNodeId:stNodeId};
      return {id,routeId,stNodeId,tracks:[track],trackGroups:[group],affectedTrackIds,baseline:networkKey(state),
        geometry:{minimumRadius:stats.minRadius,maximumTurnDegrees:stats.maxTurn,shiftMeters:shift,sourceLength:oldLength,newLength},
        exclusionVerified:true,requiresNativeValidation:true};
    }
    throw Error("没有找到同时满足曲率、排除边界和邻线零重叠的接轨方案；原站保持不变。");
  }
  function preserveSignals(existing,fresh,trackIds,changedTrackIds) {
    const valid=new Set(trackIds),signature=s=>JSON.stringify([s.type,s.buildType,(s.signalTracks || []).map(p=>[p.trackId,p.areaCovered]).sort((a,b)=>a[0].localeCompare(b[0]))]);
    const old=existing.filter(s=>(s.signalTracks || []).every(p=>valid.has(p.trackId)));
    const bySignature=new Map(old.map(s=>[signature(s),s])),byId=new Map(old.map(s=>[s.id,s]));
    const scoped=Array.isArray(changedTrackIds),changed=new Set(changedTrackIds || []),taken=new Set([...old,...fresh].map(s=>s.id));
    // The caller has proven an add-only (or own-only removal) physical change.
    // Global native regeneration is not allowed to replace unrelated signals:
    // dense crossings can reuse a coordinate ID for a different pair of rails.
    const accepted=scoped?fresh.filter(s=>(s.signalTracks || []).some(p=>changed.has(p.trackId))):fresh;
    const result=accepted.map(s=>{
      const same=bySignature.get(signature(s));if(same)return same;
      const previous=byId.get(s.id);if(!previous || signature(s)===signature(previous))return s;
      if(!scoped)throw Error("原生信号在接轨范围之外改变覆盖，拒绝施工："+JSON.stringify({id:s.id,old:signature(previous),fresh:signature(s)}));
      // The native generator reuses endpoint-based IDs when a switch gains a
      // branch. Keep the occupied old resource intact and give the genuinely
      // new coverage its own identity. Never inherit/clear old occupations.
      let digest=2166136261;for(const c of signature(s)){digest^=c.charCodeAt(0);digest=Math.imul(digest,16777619);}
      const base=s.id+"-pvg-"+(digest>>>0).toString(16);let id=base,n=0;
      while(taken.has(id))id=base+"-"+(++n);taken.add(id);
      return {...s,id};
    }),present=new Set(result.map(s=>s.id));
    for(const s of old)if(!present.has(s.id)){result.push(s);present.add(s.id);}
    for(const s of result)if(byId.has(s.id)&&signature(s)!==signature(byId.get(s.id)))throw Error("原生信号 ID 与旧覆盖范围冲突。");
    return result;
  }
  function vacant(state,ids) {
    const wanted=new Set(ids),now=state.timeConfig.elapsedSeconds;
    for(const train of state.trains) for(const name of ["train","warning","warningExtra"]) {
      if((train.windows?.[name]?.tracks || []).some(p=>wanted.has(p.trackId)))return false;
    }
    return !state.signals.some(s=>(s.signalTracks || []).some(p=>wanted.has(p.trackId)) &&
      (Boolean(s.status?.reservedBy) || (s.status?.occupations || []).some(o=>o && o.timeVerified>=now-1)));
  }
  return {planBypass,preserveSignals,vacant,networkKey,physicalKey,curveStats,outlineIndex,clearOfOutlines,segmentHit};
});

globalThis.PVGExpansionBoundaries={"geometries":[{"type":"MultiPolygon","coordinates":[[[[120.0323372,30.9013328],[120.0325916,30.904698],[120.0342369,30.9067065],[120.0385808,30.9053412],[120.0393641,30.9004798],[120.0387756,30.8991425],[120.035318,30.8992429],[120.0346749,30.9003336],[120.0323372,30.9013328]]],[[[120.0486196,30.9086227],[120.0535669,30.9075441],[120.0511026,30.9025272],[120.0468661,30.9078636],[120.0486196,30.9086227]]],[[[120.0550074,30.908601],[120.0558933,30.9095879],[120.0570357,30.9100613],[120.0590174,30.9104613],[120.0602453,30.9077809],[120.0601676,30.9071008],[120.0551162,30.9079209],[120.0549219,30.9081409],[120.0550074,30.908601]]],[[[120.0544041,30.9301166],[120.0540601,30.9301891],[120.0542083,30.9303933],[120.0547273,30.9306797],[120.0550036,30.9309086],[120.0552262,30.9309437],[120.0555957,30.9308108],[120.0564782,30.9295828],[120.0572808,30.9286234],[120.058467,30.9278687],[120.0607851,30.9261511],[120.0616951,30.9257743],[120.0618607,30.9256811],[120.0625084,30.92482],[120.0627404,30.9246337],[120.0636403,30.9243955],[120.0648259,30.9240504],[120.0649318,30.9239929],[120.0652121,30.9239284],[120.0653368,30.9239468],[120.0660657,30.9241913],[120.0663044,30.9242339],[120.0666028,30.9242379],[120.0675268,30.9240998],[120.0685018,30.9238341],[120.0692689,30.9233981],[120.0696713,30.9230805],[120.0693722,30.9228205],[120.0689417,30.922434],[120.0685394,30.9220221],[120.0681853,30.921555],[120.0679252,30.9210511],[120.0677294,30.9204896],[120.0676408,30.9199006],[120.067665,30.9192839],[120.0677696,30.9186925],[120.0682484,30.9162315],[120.0682738,30.9160175],[120.068247,30.9158184],[120.0681397,30.9156792],[120.068015,30.9155446],[120.0661871,30.9145793],[120.0656158,30.9142502],[120.0629872,30.9127533],[120.0620098,30.9158556],[120.0614692,30.9163875],[120.0604413,30.9167044],[120.0604471,30.9172094],[120.0613162,30.9179055],[120.0617266,30.9185119],[120.0617876,30.9189541],[120.0618325,30.9192793],[120.0619358,30.9194691],[120.0626707,30.9199431],[120.063297,30.9203769],[120.0628906,30.9218553],[120.0635424,30.9221763],[120.0631696,30.9226572],[120.0611101,30.9231453],[120.0606776,30.9232471],[120.0600374,30.9232203],[120.058355,30.9238283],[120.0579607,30.9234901],[120.0550452,30.9241804],[120.0524354,30.9250064],[120.0523791,30.9250892],[120.0523818,30.9251617],[120.0524434,30.9254321],[120.052886,30.9255138],[120.0542057,30.9257818],[120.0542821,30.9263743],[120.0538315,30.9276168],[120.0552946,30.9280965],[120.0549352,30.9293826],[120.0544041,30.9301166]]],[[[119.9949959,30.9486476],[119.9955404,30.948459],[119.9968506,30.9485418],[119.9968882,30.9485153],[119.9969378,30.9464703],[119.9965636,30.9464002],[119.995708,30.9465278],[119.9951568,30.9467671],[119.9951488,30.9470512],[119.9941644,30.9472294],[119.9941993,30.9468533],[119.9940678,30.9465301],[119.9934348,30.9465152],[119.9933007,30.9463311],[119.9930379,30.9462138],[119.9928582,30.9455444],[119.9935931,30.9456111],[119.9938425,30.9455444],[119.9938955,30.9449782],[119.9938137,30.9448986],[119.9934737,30.9448428],[119.9927737,30.9448382],[119.9923955,30.9448819],[119.9902806,30.9466532],[119.9896046,30.9465773],[119.989256,30.9467728],[119.9891514,30.9470397],[119.9892345,30.9474974],[119.9891889,30.9479092],[119.9857101,30.9478793],[119.9857879,30.9491169],[119.9858576,30.9502578],[119.9901572,30.9504741],[119.9917625,30.9508214],[119.995079,30.9509203],[119.9951971,30.949876],[119.995071,30.9497104],[119.9952722,30.9488316],[119.9949959,30.9486476]]],[[[119.7695443,30.9557072],[119.769834,30.9555002],[119.7700486,30.9552472],[119.7698662,30.9550862],[119.7695872,30.9549068],[119.7693566,30.954663],[119.769309,30.9545559],[119.7694428,30.9543667],[119.7693303,30.9542888],[119.7693526,30.9542681],[119.7692715,30.9540537],[119.7696106,30.9534175],[119.7674971,30.9526215],[119.7672685,30.9526924],[119.7660483,30.952153],[119.7659684,30.952223],[119.7664519,30.9526264],[119.7667441,30.9529562],[119.7666046,30.9532138],[119.7674951,30.9540603],[119.7672591,30.9543179],[119.7682729,30.955192],[119.7684017,30.9550908],[119.7692975,30.9558315],[119.7695443,30.9557072]]],[[[119.7193664,30.9731192],[119.7192633,30.9737054],[119.7200958,30.9743196],[119.7208105,30.9746077],[119.7230851,30.9752212],[119.7219676,30.9763983],[119.720844,30.9780501],[119.720157,30.9784024],[119.7192246,30.9807159],[119.717972,30.9829602],[119.7186425,30.9831775],[119.7209358,30.9810286],[119.7232924,30.9783405],[119.7241445,30.9773377],[119.7247516,30.9764589],[119.7259422,30.9764972],[119.7271474,30.9770492],[119.7280504,30.9774073],[119.7285404,30.9766435],[119.729071,30.9768675],[119.7292057,30.9767082],[119.7292262,30.9767167],[119.729649,30.9761304],[119.7300852,30.9754274],[119.7306596,30.974147],[119.7315624,30.9745172],[119.7321019,30.975],[119.7329879,30.973905],[119.7370613,30.9733731],[119.7371015,30.9735617],[119.7372785,30.973764],[119.737528,30.9738376],[119.7378793,30.9738215],[119.7383353,30.9737365],[119.738802,30.9737204],[119.7410859,30.9734341],[119.7411328,30.9733306],[119.7422379,30.9735432],[119.7430184,30.9737663],[119.7439787,30.9738284],[119.7441389,30.9738675],[119.745767,30.972943],[119.7422728,30.971715],[119.7421152,30.9715741],[119.7414561,30.9713539],[119.7412905,30.9711866],[119.7234759,30.9649464],[119.7234062,30.964836],[119.7185755,30.963203],[119.7182952,30.9636521],[119.7153783,30.9629524],[119.715098,30.9634607],[119.7150698,30.9638332],[119.7151838,30.9638964],[119.715338,30.9639298],[119.7152844,30.9640712],[119.7174114,30.9648211],[119.7172558,30.9653972],[119.7172357,30.9656272],[119.7169822,30.966262],[119.7161086,30.9690856],[119.7139673,30.9692306],[119.7141304,30.971319],[119.7145872,30.9725911],[119.7153306,30.9724728],[119.7157882,30.9729104],[119.716092,30.9729268],[119.7164264,30.9724843],[119.7178636,30.9726551],[119.7181912,30.9726951],[119.7193664,30.9731192]]],[[[119.7309695,30.978316],[119.7314201,30.9785092],[119.7307281,30.9791622],[119.7308301,30.9794474],[119.7311466,30.9798567],[119.7315167,30.9799441],[119.7321443,30.9799165],[119.7328524,30.9798843],[119.7332709,30.9791071],[119.7310768,30.9781274],[119.7309695,30.978316]]],[[[119.7032463,30.9892257],[119.7034728,30.9893016],[119.7041912,30.9876875],[119.7044355,30.9875085],[119.7044708,30.9874235],[119.7044107,30.9873659],[119.70417,30.9873871],[119.7039435,30.9876025],[119.7036993,30.9881213],[119.7032463,30.9892257]]],[[[119.8200121,31.026633],[119.8190261,31.0264746],[119.8181018,31.0263796],[119.8176549,31.0274969],[119.8181174,31.0278174],[119.8195191,31.0285974],[119.8198888,31.0285974],[119.820123,31.0286924],[119.8203202,31.0290726],[119.8225016,31.0304138],[119.8248555,31.027837],[119.8202709,31.026633],[119.8200121,31.026633]]],[[[119.9386239,31.0500065],[119.9387392,31.0499422],[119.9387634,31.0474696],[119.9373713,31.0474719],[119.9373673,31.0475776],[119.9366015,31.047596],[119.9366069,31.0486301],[119.9386239,31.0500065]]],[[[119.4860306,31.265002],[119.4876856,31.2655844],[119.488171,31.2645848],[119.4866475,31.264101],[119.4855908,31.2635714],[119.4850302,31.2634178],[119.4842872,31.2628607],[119.4840485,31.2627116],[119.4831982,31.2624732],[119.4818652,31.2612374],[119.4812429,31.2614529],[119.4821736,31.2627025],[119.4817552,31.2627208],[119.4811866,31.2634201],[119.4812804,31.2638901],[119.4820529,31.2638649],[119.4826055,31.2635187],[119.4831714,31.2637204],[119.4836569,31.2640047],[119.4853467,31.2646857],[119.4853869,31.2648439],[119.4858885,31.2650823],[119.4860306,31.265002]]],[[[119.7845084,31.2809383],[119.7846374,31.2810864],[119.786181,31.2810037],[119.7870998,31.2811288],[119.7876364,31.2811149],[119.7879129,31.2794819],[119.787921,31.2788218],[119.7877254,31.2784133],[119.787109,31.2785091],[119.7870529,31.2780062],[119.7861376,31.2783575],[119.7860255,31.2771521],[119.7845311,31.277216],[119.7843257,31.2767769],[119.7841856,31.2765694],[119.7838587,31.2763538],[119.7823932,31.2762407],[119.7823079,31.2762342],[119.7822773,31.2772092],[119.7814135,31.2773018],[119.7814327,31.2798384],[119.7816263,31.2799319],[119.7814202,31.2818008],[119.7815209,31.2817447],[119.7816133,31.2818498],[119.7840507,31.2812192],[119.7841147,31.2809334],[119.7842905,31.2809131],[119.7845084,31.2809383]]],[[[119.7798086,31.2836538],[119.779337,31.28382],[119.7790759,31.286151],[119.7801977,31.2862381],[119.7803686,31.2837948],[119.7798086,31.2836538]]],[[[119.8041279,31.289971],[119.8053719,31.2896305],[119.8056402,31.2907631],[119.8073315,31.2905685],[119.8073559,31.2903601],[119.8077705,31.2901933],[119.8082421,31.2890955],[119.8083722,31.2887064],[119.8083228,31.2884247],[119.8080871,31.2870821],[119.8080795,31.2870388],[119.8073315,31.2860729],[119.8072989,31.2859965],[119.8071282,31.2859339],[119.8071282,31.2857463],[119.8068029,31.2853642],[119.8069818,31.2848361],[119.8071607,31.2846554],[119.8071932,31.2843427],[119.8062609,31.2840954],[119.806318,31.2833411],[119.8021293,31.2830259],[119.8007476,31.2829337],[119.8007476,31.283138],[119.8008317,31.2837872],[119.801184,31.2860116],[119.8016376,31.288759],[119.8018512,31.28963],[119.8031522,31.2898251],[119.8032823,31.2899223],[119.8040303,31.2896583],[119.8041279,31.289971]]],[[[119.7941706,31.2871614],[119.7939446,31.2873077],[119.7939378,31.2881327],[119.7941158,31.2881502],[119.7943419,31.2880085],[119.7951453,31.2878966],[119.7961238,31.2879265],[119.7962109,31.2878518],[119.7957704,31.2873281],[119.7949068,31.2859619],[119.7942117,31.2863774],[119.7941706,31.2871614]]],[[[119.8014962,31.2888154],[119.8010093,31.2860719],[119.8004136,31.2862388],[119.8002544,31.2863623],[119.8001391,31.2863456],[119.7993539,31.2865718],[119.7992408,31.2869934],[119.7991053,31.2889365],[119.8014962,31.2888154]]],[[[119.7954369,31.2928862],[119.7946617,31.2921665],[119.7915213,31.2942598],[119.791386,31.2951205],[119.7909361,31.2956228],[119.7909147,31.2967321],[119.7906142,31.2968215],[119.7903916,31.2970919],[119.7905895,31.2975181],[119.7907873,31.2975906],[119.7901448,31.2983658],[119.7902736,31.2988414],[119.7908396,31.299118],[119.7911507,31.29882],[119.7915933,31.297846],[119.7918051,31.2978872],[119.7921002,31.2972409],[119.7918105,31.2971446],[119.7925267,31.2955953],[119.7954369,31.2928862]]],[[[119.8075739,31.2983929],[119.8079479,31.2975522],[119.8080943,31.2966073],[119.8082488,31.295051],[119.8082976,31.294106],[119.8083041,31.2934651],[119.8077961,31.2935535],[119.8067021,31.2937725],[119.8065854,31.2939564],[119.806375,31.2939583],[119.8061586,31.2940169],[119.8060528,31.2939898],[119.8054457,31.2942065],[119.8035633,31.2950419],[119.8040793,31.2960578],[119.8043325,31.2965564],[119.8047938,31.2976907],[119.8051706,31.2982895],[119.8055249,31.2982956],[119.8062242,31.2985943],[119.8064681,31.2991501],[119.8071836,31.2990529],[119.8075739,31.2983929]]],[[[119.8098028,31.3023802],[119.8077425,31.302338],[119.8071579,31.3028824],[119.806218,31.3025878],[119.8055911,31.3035838],[119.8056588,31.3036168],[119.80542,31.3040889],[119.806391,31.3047631],[119.8061999,31.3053498],[119.8053505,31.3059122],[119.8049258,31.3067045],[119.8050178,31.3074181],[119.804494,31.3087123],[119.8061716,31.3092082],[119.8087623,31.3099158],[119.8100222,31.3068255],[119.8093498,31.3061904],[119.8087056,31.3050534],[119.8089958,31.3046059],[119.8093639,31.3041886],[119.8096824,31.3035959],[119.8098028,31.3023802]]],[[[119.8992249,31.4461849],[119.8986898,31.4464035],[119.8986308,31.4463337],[119.8982272,31.4462009],[119.8979576,31.4463989],[119.8968807,31.4454252],[119.8966916,31.4456895],[119.8962235,31.4460339],[119.8927125,31.4431106],[119.8910147,31.4400739],[119.887682,31.4414344],[119.8910402,31.4473737],[119.8911381,31.4473943],[119.8959164,31.4464481],[119.8969021,31.4456781],[119.8987636,31.4473096],[119.8992383,31.4471494],[119.8994596,31.4472696],[119.899976,31.4468611],[119.8992249,31.4461849]]],[[[120.2466622,31.4512819],[120.246689,31.4515473],[120.247322,31.4515496],[120.2470189,31.4512362],[120.2469626,31.4511286],[120.246972,31.4510119],[120.2470203,31.4497271],[120.2468942,31.449591],[120.2463819,31.4496138],[120.2455008,31.4496116],[120.2450851,31.4495589],[120.2449764,31.4494766],[120.2448453,31.4494522],[120.2443327,31.4493164],[120.2437963,31.4491059],[120.2431767,31.4488301],[120.2431244,31.4488336],[120.2434677,31.4492363],[120.2435213,31.4493347],[120.2435669,31.4499891],[120.2436313,31.4505474],[120.2441034,31.4510096],[120.2443582,31.4510623],[120.2446666,31.4510851],[120.2447069,31.4512247],[120.2466622,31.4512819]]],[[[120.1481257,31.5383146],[120.1480007,31.5378693],[120.1478682,31.5369841],[120.147026,31.5370207],[120.1461813,31.5402418],[120.1486436,31.5402624],[120.1488552,31.5398142],[120.1494346,31.5392884],[120.1495349,31.5390946],[120.1495204,31.5389638],[120.149338,31.5387855],[120.1487157,31.5385341],[120.1483386,31.5384728],[120.1481257,31.5383146]]],[[[120.1546753,31.5415281],[120.1548416,31.541615],[120.15607,31.5416653],[120.1564295,31.5417933],[120.1565099,31.5423556],[120.156703,31.5437089],[120.1570088,31.5439923],[120.1573575,31.5443398],[120.1575184,31.5449204],[120.1578564,31.5453821],[120.1586128,31.5452724],[120.1583821,31.5446278],[120.1581353,31.5435352],[120.1580656,31.5424699],[120.1576193,31.5405571],[120.1573671,31.5393551],[120.1573904,31.5388814],[120.1576566,31.5372296],[120.1578061,31.5369271],[120.1581376,31.5366605],[120.1594126,31.5361152],[120.1590203,31.5353669],[120.1574809,31.5359686],[120.1570464,31.5359823],[120.1555551,31.5358177],[120.1550079,31.5358177],[120.1542408,31.5358771],[120.1541442,31.5362703],[120.1540638,31.5376008],[120.153935,31.5378294],[120.1529426,31.5382455],[120.1527066,31.5384466],[120.1527125,31.5391743],[120.1529748,31.5392513],[120.1544393,31.5394068],[120.1547021,31.5395668],[120.1550615,31.5400011],[120.1551044,31.5401931],[120.1549757,31.5403669],[120.1547289,31.5404857],[120.1546753,31.5415281]]],[[[120.1646268,31.5482081],[120.1645034,31.5485464],[120.164423,31.5490401],[120.1642299,31.5493967],[120.1639885,31.5496115],[120.1638222,31.5499772],[120.1638275,31.5503201],[120.1640367,31.5505487],[120.1647448,31.5506355],[120.1653188,31.5505578],[120.1654959,31.550311],[120.1655763,31.5501601],[120.1655012,31.549863],[120.1652974,31.5495521],[120.1652706,31.5492961],[120.1653832,31.5486515],[120.1657212,31.5482492],[120.1659733,31.5479338],[120.1664078,31.5475863],[120.1668048,31.5472846],[120.1669443,31.547216],[120.1673359,31.5472938],[120.1677757,31.5474218],[120.16828,31.5473715],[120.1685482,31.5472389],[120.1688433,31.5469646],[120.1691222,31.546736],[120.1693475,31.5466172],[120.1695567,31.5465714],[120.169841,31.5466354],[120.1700824,31.5467589],[120.170297,31.5470057],[120.1703292,31.5473303],[120.1702112,31.5477509],[120.1701683,31.5480938],[120.1703507,31.5483864],[120.170694,31.5486104],[120.1712465,31.5486287],[120.171563,31.5484504],[120.1718259,31.5481212],[120.1720726,31.5478332],[120.172357,31.5476549],[120.1727217,31.5476732],[120.1733655,31.5476915],[120.1736873,31.5473349],[120.1736444,31.5470835],[120.1733279,31.5467223],[120.1728398,31.5464069],[120.1726842,31.5459726],[120.1726574,31.5455657],[120.1727647,31.5451336],[120.1728612,31.5450445],[120.1734996,31.5452548],[120.1741165,31.54544],[120.1748675,31.5453714],[120.1752028,31.5452091],[120.1754495,31.5447611],[120.1752967,31.5446308],[120.174669,31.5446536],[120.1742908,31.5445576],[120.1739743,31.5445645],[120.1734218,31.5445645],[120.1728693,31.5442856],[120.1713377,31.5437644],[120.1702702,31.5433415],[120.1699376,31.5432981],[120.1696962,31.5434032],[120.1696399,31.5436867],[120.1693207,31.5439519],[120.1677436,31.5448159],[120.1663059,31.5460548],[120.1658499,31.546384],[120.165571,31.5464434],[120.1651096,31.5460823],[120.1648307,31.5460777],[120.164423,31.5462697],[120.1638704,31.5465852],[120.1627439,31.5468275],[120.1621807,31.5471566],[120.1620519,31.5475772],[120.162363,31.5478195],[120.1624435,31.5476823],[120.1627546,31.5475223],[120.1631623,31.5475909],[120.1637202,31.5476823],[120.1641869,31.5477646],[120.1645625,31.5477875],[120.1646644,31.5479886],[120.1646268,31.5482081]]],[[[120.2060428,31.5570754],[120.2062869,31.5568799],[120.2064693,31.5568411],[120.2068577,31.5569295],[120.2073061,31.5562148],[120.2072471,31.5538767],[120.2028366,31.553739],[120.2026525,31.5570377],[120.2060428,31.5570754]]],[[[120.1756883,31.5554674],[120.1757473,31.5558743],[120.1759297,31.5562308],[120.1763534,31.5565828],[120.1763481,31.5576661],[120.1765948,31.557881],[120.1774263,31.557913],[120.1779091,31.5569439],[120.1783222,31.5565782],[120.1788962,31.5560388],[120.1800978,31.5559154],[120.1805055,31.5551703],[120.1807201,31.5551017],[120.1816106,31.5552709],[120.1817661,31.5554811],[120.1814175,31.5559931],[120.1809239,31.5568799],[120.1805699,31.5576799],[120.1805109,31.5580227],[120.1804143,31.5586306],[120.1802051,31.559074],[120.1800603,31.5595174],[120.1806021,31.559778],[120.1808166,31.5596043],[120.1814067,31.5587769],[120.1819754,31.5580364],[120.1824743,31.557753],[120.1830643,31.5576022],[120.1836705,31.557529],[120.183928,31.5572776],[120.1841158,31.5568113],[120.184443,31.5555314],[120.1850116,31.554224],[120.1852477,31.5537121],[120.1853228,31.5526698],[120.1853174,31.5524047],[120.1851404,31.5523772],[120.1847756,31.552135],[120.1843464,31.5517418],[120.1838744,31.5515498],[120.1831233,31.5515315],[120.1827532,31.5513304],[120.1826245,31.551431],[120.1819271,31.5531498],[120.1810098,31.5529852],[120.1799154,31.5526195],[120.1787245,31.5522172],[120.1782042,31.5522127],[120.1775175,31.5527658],[120.1761121,31.5533555],[120.1746583,31.5536344],[120.1727861,31.5539361],[120.1719868,31.5540686],[120.1718366,31.5541463],[120.1717615,31.5544115],[120.1720244,31.5549372],[120.1725072,31.5553623],[120.1736283,31.5556503],[120.1739931,31.5556274],[120.1741487,31.5553943],[120.1743847,31.5551886],[120.1750928,31.5552846],[120.1756883,31.5554674]]],[[[120.23558,31.5573416],[120.2364068,31.5574467],[120.2364403,31.5574364],[120.236679,31.5567234],[120.2360943,31.5565554],[120.2362405,31.5562502],[120.2365851,31.554912],[120.234603,31.554336],[120.2329266,31.5539201],[120.2327818,31.5539475],[120.2322185,31.5583518],[120.2322641,31.5584364],[120.2348176,31.558978],[120.234839,31.5588706],[120.2347264,31.5588203],[120.2348095,31.5585598],[120.2348873,31.5584912],[120.2349114,31.557769],[120.235523,31.5577827],[120.23558,31.5573416]]],[[[120.1914169,31.5550286],[120.1919286,31.5553725],[120.1912362,31.5565759],[120.1900629,31.5563518],[120.1886167,31.5612005],[120.1918833,31.5617874],[120.1931225,31.5592661],[120.1926504,31.5587084],[120.1923285,31.5563589],[120.1944046,31.5564576],[120.1951288,31.5546401],[120.1940266,31.553479],[120.1918648,31.5533624],[120.1914169,31.5550286]]],[[[120.2156378,31.5610411],[120.2156367,31.5582674],[120.2112297,31.558308],[120.2112397,31.5594142],[120.211315,31.5634322],[120.2113469,31.5638068],[120.2126811,31.5637958],[120.2126864,31.5637227],[120.2159051,31.5637044],[120.2159117,31.5625712],[120.2158185,31.5610324],[120.2156378,31.5610411]]],[[[120.1747294,31.5644174],[120.1749198,31.5641957],[120.1751022,31.5641352],[120.1768456,31.5641683],[120.1768939,31.5641374],[120.1769295,31.5636009],[120.1769006,31.563581],[120.1748165,31.5636312],[120.1746663,31.5635718],[120.1746985,31.563069],[120.174661,31.5630256],[120.1740172,31.5627902],[120.1739958,31.5626851],[120.1739623,31.5616646],[120.173969,31.5615435],[120.1740146,31.5614201],[120.1741379,31.5611607],[120.1744974,31.5607116],[120.1751317,31.5595711],[120.1752591,31.5593563],[120.1752082,31.5592512],[120.1750231,31.5591575],[120.1738577,31.5590078],[120.1736377,31.5591323],[120.1736216,31.5592466],[120.1736699,31.5594751],[120.1736471,31.559706],[120.1731174,31.560739],[120.1727968,31.5613481],[120.1726802,31.5614658],[120.1717561,31.5620497],[120.1715228,31.5622211],[120.1712975,31.5624634],[120.1707188,31.563029],[120.1705968,31.5632044],[120.1704801,31.5634215],[120.1703513,31.5637061],[120.1703668,31.5638392],[120.1714075,31.5642757],[120.1724468,31.5644734],[120.1737812,31.5647579],[120.1737678,31.5648836],[120.1741929,31.5649442],[120.1743042,31.5648871],[120.1744544,31.5647648],[120.1747294,31.5644174]]],[[[120.2497776,31.5672421],[120.2504173,31.5671564],[120.2505139,31.5671301],[120.2507606,31.5645911],[120.2460889,31.5642311],[120.2454103,31.5641826],[120.2454016,31.5641957],[120.2452031,31.5668787],[120.2455491,31.5669816],[120.2458844,31.5675026],[120.2459179,31.5675678],[120.2465241,31.567586],[120.2476989,31.5676135],[120.2478424,31.5676055],[120.248246,31.5675495],[120.2492841,31.5673392],[120.2497776,31.5672421]]],[[[120.2301559,31.5661977],[120.230054,31.5663942],[120.2300432,31.5666502],[120.2307191,31.5664719],[120.2305233,31.566961],[120.2303383,31.5674523],[120.229708,31.5676237],[120.2294558,31.5680465],[120.2295819,31.5683802],[120.2301881,31.5684533],[120.2312851,31.5680877],[120.2315453,31.5679231],[120.2324277,31.5679848],[120.2328488,31.5686041],[120.2331036,31.5686704],[120.2334765,31.568787],[120.2373871,31.569228],[120.2378029,31.5665771],[120.2377465,31.5665245],[120.2339995,31.5661223],[120.2337313,31.5679597],[120.232535,31.5677677],[120.2322641,31.5672352],[120.2322105,31.5665565],[120.2323714,31.56628],[120.2313039,31.5651464],[120.2268326,31.5647031],[120.2266636,31.5649819],[120.2266288,31.565503],[120.226779,31.5655167],[120.2267656,31.566961],[120.2269855,31.5671004],[120.2274415,31.5669199],[120.2279189,31.5662503],[120.2287102,31.5662617],[120.2288443,31.5659075],[120.2300888,31.5660514],[120.2301559,31.5661977]]],[[[120.2458436,31.5763023],[120.2462706,31.5759528],[120.2463907,31.5758545],[120.246439,31.5757265],[120.2464015,31.575562],[120.246439,31.575402],[120.2467662,31.5751278],[120.2465195,31.5747347],[120.2462727,31.5743691],[120.2459187,31.5739212],[120.2444381,31.5722896],[120.2437729,31.572052],[120.2435529,31.5719743],[120.2433028,31.571791],[120.2420534,31.5722277],[120.2425552,31.5730255],[120.2429629,31.5735739],[120.2441162,31.5750867],[120.2444971,31.5756991],[120.2448619,31.5761378],[120.2450872,31.5763298],[120.2452964,31.5764394],[120.2456022,31.5764577],[120.2458436,31.5763023]]],[[[120.2415091,31.5756579],[120.2435529,31.5747256],[120.2431399,31.5741772],[120.2411926,31.5752055],[120.2415091,31.5756579]]],[[[120.2838184,31.5988431],[120.2854128,31.6006551],[120.2866589,31.5994853],[120.2867341,31.5992683],[120.2866946,31.5989903],[120.2857018,31.5980055],[120.286324,31.5975396],[120.2860063,31.5972211],[120.2852239,31.597783],[120.2838184,31.5988431]]],[[[120.3221798,31.8862329],[120.3224749,31.8852536],[120.3225419,31.8850304],[120.3241056,31.8824807],[120.3202623,31.8819176],[120.3168097,31.8836527],[120.3164825,31.8860669],[120.3192682,31.8865216],[120.3190396,31.8875682],[120.3181295,31.8874238],[120.3180272,31.8879038],[120.3176787,31.8893828],[120.3224745,31.8898113],[120.322512,31.8897175],[120.3221694,31.8864162],[120.3221798,31.8862329]]],[[[119.7620028,31.9077216],[119.761946,31.9062163],[119.7609718,31.9063645],[119.7609681,31.908359],[119.7610702,31.9083704],[119.761093,31.9078857],[119.7620028,31.9077216]]],[[[119.7610112,31.9120495],[119.7610887,31.9117786],[119.7611654,31.9115102],[119.7611968,31.9089105],[119.7591664,31.9089858],[119.7587501,31.9092672],[119.7587398,31.9113628],[119.758986,31.9115508],[119.7592006,31.9117836],[119.7606482,31.9117948],[119.7607438,31.91204],[119.7608075,31.9121085],[119.7608496,31.912445],[119.7609907,31.9124568],[119.7609978,31.9123159],[119.7610112,31.9120495]]],[[[119.8032417,31.9116907],[119.803125,31.9117185],[119.8029615,31.9113339],[119.8025085,31.9114568],[119.802728,31.9120237],[119.8033118,31.9119008],[119.8032417,31.9116907]]],[[[119.7756582,31.9105325],[119.7721851,31.9105565],[119.7721822,31.9127443],[119.7721921,31.9129901],[119.7739743,31.9170824],[119.7674043,31.9189124],[119.76708,31.9182024],[119.7664805,31.9183966],[119.7660436,31.9173899],[119.7656901,31.9173229],[119.7620274,31.9184635],[119.7596037,31.9174731],[119.7571378,31.91827],[119.7574772,31.9189948],[119.7577191,31.9190571],[119.7583084,31.918871],[119.7599263,31.9195341],[119.7603649,31.919411],[119.7611474,31.9210276],[119.7549411,31.9230775],[119.7560476,31.9257012],[119.7780047,31.9187177],[119.7776031,31.9177054],[119.7770772,31.9164064],[119.7768671,31.9156576],[119.7765605,31.9145082],[119.7756295,31.9125514],[119.7756582,31.9105325]]],[[[120.2637063,31.9220443],[120.264064,31.9208541],[120.2624133,31.9201811],[120.2617511,31.9200632],[120.2613358,31.9216055],[120.2603629,31.9213212],[120.2594637,31.9231393],[120.262549,31.9243013],[120.2644073,31.9245057],[120.264602,31.9237289],[120.2651275,31.9235299],[120.2650666,31.9224042],[120.2652186,31.921595],[120.2646847,31.9211175],[120.2643579,31.9222206],[120.2637063,31.9220443]]],[[[120.283569,31.9409088],[120.2828298,31.9431714],[120.2968051,31.9464303],[120.296899,31.9460448],[120.2958921,31.9451627],[120.2954489,31.9400091],[120.2948715,31.9390314],[120.2931189,31.9386281],[120.2901998,31.9399706],[120.2896296,31.9415244],[120.283569,31.9409088]]],[[[120.6943095,30.6857637],[120.6948137,30.6855146],[120.6949156,30.68533],[120.6953394,30.6852055],[120.695377,30.6850994],[120.6958866,30.6849748],[120.6955808,30.6832632],[120.6955379,30.6831756],[120.6939018,30.6833463],[120.693832,30.6834293],[120.6931293,30.6833278],[120.6926948,30.6848641],[120.6928021,30.6866956],[120.6927136,30.686968],[120.6925714,30.687406],[120.6928557,30.6874706],[120.6928503,30.6875444],[120.6929469,30.6875859],[120.6941271,30.687406],[120.694111,30.6872353],[120.6940412,30.6869124],[120.6942022,30.6868247],[120.6941754,30.6860359],[120.6943095,30.6857637]]],[[[120.6896377,30.6934136],[120.689288,30.6935744],[120.6886294,30.6940359],[120.688605,30.6945743],[120.6893856,30.6961754],[120.6900117,30.6961824],[120.6909305,30.6960705],[120.6928541,30.6957882],[120.6917498,30.6919058],[120.6914427,30.6918964],[120.6910524,30.69219],[120.6907435,30.6932388],[120.6896377,30.6934136]]],[[[120.6920954,30.7135198],[120.6923354,30.7125849],[120.6955769,30.7129896],[120.6968192,30.7106148],[120.6949776,30.7104263],[120.6950361,30.7101247],[120.6916474,30.7097749],[120.6916653,30.7096518],[120.690359,30.709521],[120.6905111,30.7086748],[120.690691,30.7074393],[120.6929252,30.7076397],[120.6940593,30.7072111],[120.6973552,30.7048174],[120.6981675,30.7048056],[120.696076,30.7036792],[120.6925474,30.7017447],[120.6905201,30.7006157],[120.6874374,30.6989061],[120.6869999,30.6996885],[120.6859698,30.7009065],[120.6835982,30.699437],[120.6804922,30.6974478],[120.681806,30.6970494],[120.6812614,30.696399],[120.6812003,30.6960626],[120.6724334,30.6989106],[120.6711797,30.700104],[120.6777026,30.706377],[120.6789799,30.7077102],[120.6848704,30.7134279],[120.6893379,30.717764],[120.6901106,30.7185591],[120.6928035,30.7189315],[120.6937167,30.7179049],[120.692739,30.7137345],[120.6920954,30.7135198]]],[[[120.7478997,30.747098],[120.7461531,30.7471342],[120.74648,30.7489041],[120.7480772,30.7488078],[120.7480445,30.7479971],[120.7478997,30.747098]]],[[[121.3481253,30.9192308],[121.3476532,30.9197003],[121.3481274,30.9200406],[121.348474,30.9202893],[121.3489568,30.9198383],[121.3481253,30.9192308]]],[[[121.2556742,31.0114764],[121.2556956,31.0109063],[121.254671,31.0108328],[121.2547354,31.0101109],[121.2519137,31.0099178],[121.2518762,31.0104144],[121.2522785,31.0114305],[121.2556742,31.0114764]]],[[[121.0485097,31.0985549],[121.047493,31.1006285],[121.0486557,31.1010442],[121.0496762,31.1014599],[121.0498839,31.101325],[121.0500811,31.1009398],[121.0500872,31.1005388],[121.0498469,31.0998054],[121.0494402,31.0992936],[121.0490643,31.0988979],[121.0485097,31.0985549]]],[[[121.1928844,31.0996829],[121.1926857,31.0993909],[121.1916397,31.098711],[121.1915914,31.0988121],[121.1913124,31.0992071],[121.1916128,31.1013844],[121.1917738,31.1016921],[121.1918757,31.1016738],[121.1919991,31.1014119],[121.1920849,31.1011821],[121.1921979,31.1009464],[121.192516,31.1007342],[121.1928127,31.1000628],[121.1928844,31.0996829]]],[[[121.0244896,31.1062056],[121.0247116,31.1061773],[121.0250847,31.1063271],[121.0254562,31.106414],[121.0255951,31.1061177],[121.0255678,31.1060246],[121.024854,31.1058994],[121.0246715,31.1053783],[121.0247615,31.1051635],[121.0243869,31.1045589],[121.0244659,31.1045247],[121.024338,31.1040777],[121.0241015,31.1037265],[121.0237415,31.1034676],[121.0236875,31.1034785],[121.0235684,31.1035755],[121.0233621,31.1038088],[121.0230098,31.1043903],[121.022641,31.1049339],[121.0227457,31.1052157],[121.0227381,31.1052901],[121.0227834,31.1054974],[121.0228912,31.1055403],[121.0230038,31.1056193],[121.0236732,31.1057345],[121.0238236,31.105855],[121.0239211,31.1058956],[121.0244896,31.1062056]]],[[[121.2038745,31.1071901],[121.2038885,31.1065783],[121.204108,31.1059666],[121.2039322,31.1052895],[121.2029908,31.1053499],[121.2027012,31.1052075],[121.202526,31.1051532],[121.2023632,31.1051846],[121.2021596,31.1052548],[121.2015204,31.1060339],[121.2012406,31.1064824],[121.2001992,31.1061665],[121.1995921,31.1059026],[121.1991531,31.1056147],[121.1991158,31.1055307],[121.1988636,31.1055987],[121.1985787,31.1057906],[121.1985133,31.1058906],[121.1991064,31.1064824],[121.1994894,31.1070262],[121.199919,31.107534],[121.200344,31.1080858],[121.2016408,31.1082835],[121.2027303,31.1085016],[121.2032674,31.1083297],[121.2036924,31.10737],[121.2038745,31.1071901]]],[[[121.1614414,31.1212812],[121.1648566,31.1215897],[121.1650357,31.1211666],[121.1665201,31.1212353],[121.1667303,31.1166107],[121.1657135,31.1145654],[121.1632507,31.1136232],[121.1638805,31.1114375],[121.1622815,31.1116471],[121.1614414,31.1212812]]],[[[121.0819745,31.1289679],[121.0817255,31.128835],[121.0818554,31.1286342],[121.0809857,31.1279855],[121.0805022,31.1289184],[121.0816136,31.1295146],[121.0819745,31.1289679]]],[[[121.2223212,31.1391188],[121.2222097,31.1387753],[121.2220239,31.1385845],[121.2221503,31.1381329],[121.2221503,31.1377768],[121.2219273,31.1368736],[121.2215409,31.1369499],[121.2152097,31.1369563],[121.2156482,31.1397421],[121.2198987,31.1407788],[121.2228636,31.1408233],[121.2230123,31.1407025],[121.2228116,31.1404544],[121.2225887,31.140041],[121.2227373,31.139405],[121.2227373,31.1392269],[121.2223212,31.1391188]]],[[[121.1950409,31.1416426],[121.1951863,31.1414908],[121.1952723,31.1414127],[121.1964755,31.1426573],[121.1969354,31.1428263],[121.1974504,31.1423958],[121.1975005,31.1418206],[121.19766,31.1416297],[121.1976654,31.1412039],[121.1973765,31.1411232],[121.1968922,31.1409351],[121.1964905,31.1405994],[121.1960609,31.1399678],[121.1955192,31.1393603],[121.1950831,31.1391678],[121.1952035,31.1387128],[121.1942583,31.138409],[121.1933149,31.1385609],[121.1926051,31.1388566],[121.1923342,31.1393123],[121.1923556,31.1400828],[121.1927262,31.1408187],[121.1929019,31.1409401],[121.1942069,31.1409584],[121.1943815,31.1410263],[121.1943737,31.1411488],[121.1943991,31.1414242],[121.1947825,31.1416002],[121.1950409,31.1416426]]],[[[121.3407444,31.2064913],[121.3436405,31.2066086],[121.3437013,31.2056753],[121.3409004,31.205567],[121.3407795,31.2055947],[121.3407022,31.2056628],[121.3406625,31.2057578],[121.3406059,31.2064827],[121.3407444,31.2064913]]],[[[121.2791377,31.2384666],[121.2795408,31.2391648],[121.2805462,31.2416302],[121.2824569,31.2384893],[121.2796381,31.2371465],[121.2788647,31.2382758],[121.2789999,31.2382964],[121.2791377,31.2384666]]],[[[120.4020265,31.2421587],[120.4020638,31.2417375],[120.4016435,31.2418073],[120.4016365,31.2421268],[120.4020265,31.2421587]]],[[[120.4277381,31.2443427],[120.4275966,31.2440537],[120.427427,31.243974],[120.4272379,31.2440566],[120.427248,31.2443243],[120.4275289,31.2448013],[120.4274619,31.244932],[120.4272124,31.244893],[120.426574,31.2447577],[120.4263608,31.2447302],[120.4258499,31.2453987],[120.4259934,31.2457931],[120.426098,31.2458264],[120.4278414,31.2455816],[120.4279805,31.2458759],[120.4284301,31.2457025],[120.428693,31.2454457],[120.4284945,31.2450948],[120.427781,31.2443197],[120.4277381,31.2443427]]],[[[120.4242861,31.2478558],[120.4251069,31.2480576],[120.4256836,31.2483648],[120.4260242,31.248163],[120.4255199,31.2473559],[120.425013,31.2470388],[120.424844,31.2475531],[120.4242137,31.2477382],[120.4242861,31.2478558]]],[[[120.5564117,31.2481585],[120.556668,31.2477719],[120.5561984,31.2475523],[120.5555675,31.2484769],[120.5560137,31.2487055],[120.5561971,31.2484703],[120.5564117,31.2481585]]],[[[120.4128125,31.2564635],[120.4116555,31.2555884],[120.4108782,31.2561443],[120.407757,31.25694],[120.4070728,31.2569246],[120.4065643,31.2573137],[120.4059346,31.2578673],[120.4052741,31.258736],[120.404985,31.2606021],[120.4053808,31.2609805],[120.4063475,31.2618428],[120.405341,31.2646387],[120.4046997,31.266399],[120.4058678,31.2668123],[120.4075443,31.2658884],[120.4085894,31.2638054],[120.4085348,31.2623936],[120.408932,31.2611038],[120.4104615,31.2600801],[120.4110446,31.2601144],[120.4130333,31.257828],[120.4128125,31.2564635]]],[[[120.4019619,31.2723969],[120.4020251,31.2723083],[120.4021049,31.2707451],[120.4021262,31.2703609],[120.4023007,31.270243],[120.4025582,31.2705089],[120.4064908,31.2748802],[120.4068037,31.2751243],[120.40868,31.2763788],[120.4088473,31.2764591],[120.4089841,31.2764866],[120.4091782,31.2764962],[120.4092817,31.276484],[120.409424,31.2764499],[120.410771,31.2758185],[120.4110955,31.2756707],[120.4112785,31.2756281],[120.4113934,31.2756205],[120.4114818,31.2756453],[120.4115188,31.2756865],[120.4115265,31.2757579],[120.4114844,31.2759487],[120.4130545,31.276202],[120.4130823,31.276087],[120.4131161,31.2760315],[120.4132201,31.2759518],[120.413285,31.2759421],[120.4133986,31.2759493],[120.4176173,31.2768554],[120.418003,31.2769246],[120.4182713,31.2769577],[120.4185015,31.2769691],[120.4206528,31.2768653],[120.4208381,31.2768224],[120.4209867,31.2767457],[120.4211647,31.2766414],[120.4212749,31.2765261],[120.42136566563234,31.276343369189526],[120.4213531,31.2765611],[120.4212914,31.2766493],[120.4217622,31.2770184],[120.42254,31.2768293],[120.4221591,31.2754057],[120.4214215,31.2753759],[120.42138195524409,31.276061111179846],[120.4212157,31.2747809],[120.4211919,31.2746467],[120.4211846,31.2745688],[120.4212056,31.2745185],[120.4212566,31.2744773],[120.4214466,31.2744246],[120.4212961,31.2740051],[120.421101,31.2740325],[120.4210586,31.2739382],[120.4210182,31.27389],[120.4209744,31.2738378],[120.4206615,31.2736426],[120.4202274,31.27349],[120.4201281,31.2737113],[120.4204358,31.2738107],[120.4205538,31.2738858],[120.4206906,31.2739981],[120.4207842,31.2741202],[120.4209993,31.2747552],[120.421218,31.2762461],[120.4211935,31.2763731],[120.4211317,31.2764901],[120.420932,31.2766138],[120.4206434,31.2767671],[120.4184537,31.2768614],[120.4182981,31.2768568],[120.4181636,31.2768432],[120.4145976,31.2760978],[120.4132716,31.2757976],[120.4115406,31.2755259],[120.4113994,31.2755226],[120.4112331,31.2755341],[120.4111263,31.2755569],[120.4109488,31.275612],[120.4106328,31.2757611],[120.4105009,31.2757862],[120.4103609,31.2757259],[120.4102918,31.2756793],[120.410253,31.2755898],[120.4102555,31.2754962],[120.4103625,31.2751449],[120.4105318,31.2747424],[120.4108919,31.2739548],[120.4107666,31.2739443],[120.4102878,31.2749888],[120.4101795,31.2753121],[120.4100101,31.2759658],[120.4099524,31.2760533],[120.4098317,31.2761496],[120.4096482,31.2762387],[120.4094488,31.2763305],[120.4092577,31.2763811],[120.4090351,31.2763765],[120.408884,31.2763408],[120.4086787,31.2762374],[120.406887,31.2750465],[120.4066345,31.274844],[120.4063608,31.2745711],[120.4063381,31.2745059],[120.4063499,31.2744295],[120.4065764,31.2742305],[120.4048371,31.2723083],[120.4046322,31.2724358],[120.4045115,31.272422],[120.4044219,31.2723793],[120.4026835,31.2704775],[120.4023148,31.2700905],[120.4022276,31.2700034],[120.4021279,31.2699509],[120.4021228,31.269291],[120.4018105,31.2691544],[120.4019826,31.2649957],[120.402539,31.2649957],[120.402539,31.2643967],[120.4026168,31.2621761],[120.4027584,31.2614622],[120.4038204,31.2614994],[120.4039722,31.2593454],[120.402752,31.2592851],[120.4028486,31.2571848],[120.4030712,31.2571986],[120.4030687,31.2566078],[120.4036131,31.2566397],[120.4036754,31.2552117],[120.4034849,31.2551898],[120.4035422,31.2533096],[120.4032517,31.2532941],[120.4032908,31.252485],[120.4025595,31.2524487],[120.4025627,31.2522421],[120.4021968,31.2522165],[120.4022442,31.2512255],[120.4022513,31.2505236],[120.4022654,31.24987],[120.4021946,31.2497853],[120.4005737,31.2492649],[120.4005383,31.2493375],[120.4003591,31.2531554],[120.4002705,31.2531988],[120.4001379,31.2558514],[120.3998751,31.2558371],[120.3998568,31.2561912],[120.4002378,31.2562271],[120.3998871,31.2620023],[120.3990589,31.2766014],[120.3991368,31.2766437],[120.4007817,31.2767143],[120.400859,31.2766776],[120.4009811,31.2742411],[120.4010338,31.2741126],[120.4014166,31.2741309],[120.4014488,31.2734931],[120.4018786,31.2735104],[120.4019619,31.2723969]]],[[[120.4895258,31.2656461],[120.4896534,31.2654503],[120.489931,31.2652841],[120.4901147,31.2650193],[120.4900396,31.2646708],[120.4897714,31.2642856],[120.489472,31.2639353],[120.4897705,31.2624154],[120.4892031,31.2619634],[120.4887664,31.2623459],[120.4884524,31.2628394],[120.488337,31.2630737],[120.4880952,31.2635643],[120.4879472,31.2637099],[120.4874458,31.264203],[120.4877033,31.2645149],[120.4880059,31.2645735],[120.4882642,31.2647698],[120.4883704,31.264922],[120.4886107,31.2651742],[120.4886676,31.2652256],[120.4891439,31.2655209],[120.4894755,31.2656438],[120.4895258,31.2656461]]],[[[120.4168451,31.2642911],[120.4173033,31.2648439],[120.4175862,31.2657247],[120.4172952,31.2664961],[120.4173066,31.2668624],[120.4193781,31.2662355],[120.4196119,31.2659886],[120.4176666,31.2639923],[120.41698,31.2639355],[120.4168451,31.2642911]]],[[[120.4866882,31.264603],[120.4859372,31.2648414],[120.4851218,31.2651166],[120.4843064,31.2654192],[120.4829078,31.2663088],[120.4832618,31.2672647],[120.484993,31.2669232],[120.4851325,31.2672533],[120.4884906,31.2663821],[120.4878925,31.2651722],[120.487635,31.2646514],[120.4873813,31.2642362],[120.4872139,31.2643554],[120.4866882,31.264603]]],[[[120.3742996,31.2775829],[120.3770928,31.2777582],[120.3840149,31.2753957],[120.3835166,31.2713343],[120.3791205,31.2716823],[120.3785599,31.2735307],[120.3768065,31.2735983],[120.3761975,31.2748485],[120.3746974,31.2749885],[120.3742996,31.2775829]]],[[[120.4562342,31.2802296],[120.4576225,31.2800615],[120.4596496,31.2787569],[120.4590665,31.2777814],[120.4544486,31.2782293],[120.4543247,31.278285],[120.4541253,31.2783003],[120.4537857,31.2794588],[120.4562342,31.2802296]]],[[[120.3998172,31.2839176],[120.3998429,31.2833668],[120.3994693,31.2833129],[120.3993409,31.2838836],[120.3998172,31.2839176]]],[[[120.4745239,31.2869016],[120.4746312,31.2866632],[120.4745997,31.2864775],[120.4746204,31.2863331],[120.4747921,31.2862047],[120.4752159,31.2861497],[120.4755378,31.285893],[120.4759562,31.285783],[120.4766214,31.285838],[120.4769862,31.286058],[120.4782307,31.2884052],[120.4783396,31.2884595],[120.4804408,31.2879834],[120.4800548,31.2854091],[120.4809344,31.2851687],[120.4814386,31.2854071],[120.4818463,31.2854346],[120.4821789,31.2853704],[120.4826939,31.2854896],[120.4828119,31.2857005],[120.4828334,31.2859664],[120.4828977,31.2863514],[120.4833054,31.2867274],[120.4848289,31.286709],[120.4861593,31.2858013],[120.4862451,31.2851228],[120.4861164,31.2842059],[120.4856443,31.283234],[120.484668,31.2827297],[120.4841865,31.2827268],[120.4842051,31.2837103],[120.4833552,31.2837582],[120.4832431,31.2844447],[120.4823558,31.284317],[120.4820849,31.2840136],[120.481758,31.2838939],[120.4811229,31.283862],[120.480301,31.2838221],[120.4768545,31.2839817],[120.475603,31.2840456],[120.4755936,31.2841813],[120.4743981,31.2840615],[120.4732843,31.2843599],[120.4724928,31.2844926],[120.4716807,31.284536],[120.4715661,31.2849624],[120.4714823,31.2854391],[120.4715252,31.2856454],[120.4716117,31.2856936],[120.4726678,31.2859618],[120.4730594,31.2863514],[120.4732096,31.2866494],[120.4733163,31.286739],[120.4738379,31.286858],[120.4742932,31.2869841],[120.4745239,31.2869016]]],[[[121.2881805,31.2952278],[121.287379,31.2963195],[121.2874505,31.2963595],[121.2891452,31.2970664],[121.2898086,31.2958219],[121.2881805,31.2952278]]],[[[120.5952394,31.3094147],[120.5959743,31.3095476],[120.5961996,31.3080214],[120.5950195,31.3077877],[120.5952787,31.3069049],[120.5953105,31.3067965],[120.5947955,31.3067209],[120.5947113,31.3070085],[120.593563,31.3067541],[120.5935013,31.3069489],[120.5946483,31.3072171],[120.5940914,31.3090939],[120.5939512,31.3090668],[120.5929595,31.308875],[120.5928321,31.3092955],[120.5926055,31.3092543],[120.5925537,31.3094675],[120.5925364,31.3095479],[120.592532,31.3095681],[120.5924336,31.3099885],[120.5924123,31.3100793],[120.5925196,31.3103955],[120.59223,31.3114038],[120.592922,31.3115046],[120.5936998,31.3116513],[120.5938339,31.3110876],[120.5949986,31.3113282],[120.5951428,31.3108034],[120.5961969,31.3110142],[120.5962479,31.3104505],[120.5950892,31.3101984],[120.5952394,31.3094147]]],[[[120.5780598,31.3143072],[120.5780518,31.3134547],[120.5781215,31.3134524],[120.5781859,31.3128521],[120.5762793,31.312729],[120.5762708,31.3127994],[120.5744013,31.312655],[120.5742323,31.3140184],[120.5780598,31.3143072]]],[[[120.5810049,31.3134135],[120.5803236,31.3133722],[120.5802995,31.3135785],[120.5796531,31.3135326],[120.5795512,31.3144424],[120.582523,31.3147173],[120.5826223,31.3136541],[120.5824962,31.3136472],[120.5825727,31.3128411],[120.5826223,31.3123181],[120.5814877,31.3124923],[120.5814716,31.3127444],[120.5811551,31.3127375],[120.5810049,31.3134135]]],[[[120.5916828,31.3137228],[120.5920154,31.3121646],[120.5918866,31.3121371],[120.591951,31.31183],[120.5899447,31.3116742],[120.5899179,31.3119217],[120.5894512,31.3118988],[120.5893975,31.3124671],[120.5889469,31.3124304],[120.5888504,31.3134891],[120.5860877,31.3135212],[120.5860367,31.3137962],[120.5859214,31.3150565],[120.586769,31.315139],[120.5879883,31.3152209],[120.5880129,31.315007],[120.5896185,31.3151418],[120.5895939,31.3153557],[120.5916399,31.3154919],[120.5918062,31.3139749],[120.5918491,31.3137458],[120.5916828,31.3137228]]],[[[120.5613735,31.3152298],[120.5613068,31.3151527],[120.5612746,31.3149442],[120.5613309,31.3147884],[120.5613145,31.3143759],[120.5599335,31.3141491],[120.5596358,31.3154644],[120.5595741,31.315792],[120.5595647,31.3158917],[120.5595687,31.3160029],[120.5595821,31.3161781],[120.5596679,31.316633],[120.5611194,31.3169172],[120.5614035,31.3161217],[120.5614516,31.3159204],[120.5614543,31.315776],[120.5614489,31.3155973],[120.5613735,31.3152298]]],[[[121.156222,31.3260281],[121.1562242,31.3258629],[121.156209,31.3257217],[121.1561442,31.3255256],[121.1560808,31.3252064],[121.1560402,31.3249855],[121.156032,31.3247646],[121.1563618,31.3246547],[121.1565138,31.3246861],[121.1604646,31.3260935],[121.1614828,31.3240099],[121.1594129,31.3231878],[121.1588679,31.3230618],[121.1585162,31.3230122],[121.1575806,31.3229956],[121.1553893,31.3231114],[121.1543882,31.3231448],[121.1537201,31.3231429],[121.1534182,31.3231542],[121.1532567,31.3231596],[121.1530841,31.3231924],[121.1528395,31.323253],[121.1526413,31.3233277],[121.1524748,31.3234077],[121.1522798,31.3234951],[121.1521308,31.3235886],[121.1519674,31.3237259],[121.1513607,31.3242607],[121.1532113,31.325627],[121.15504,31.3268721],[121.155294,31.3267447],[121.1555576,31.3266608],[121.1557798,31.3265805],[121.1559437,31.3264855],[121.1560761,31.3263467],[121.1561805,31.3261833],[121.156222,31.3260281]]],[[[120.8873292,31.4140819],[120.8881038,31.4111913],[120.8885595,31.4095969],[120.8888329,31.4081192],[120.8826817,31.4070822],[120.8812198,31.4130202],[120.8824235,31.4133301],[120.8873292,31.4140819]]],[[[121.1746513,31.4729932],[121.1756988,31.4715111],[121.1706213,31.4690514],[121.1694751,31.4707963],[121.1746513,31.4729932]]],[[[120.4217586,31.4771322],[120.4221623,31.477006],[120.4220298,31.4766487],[120.4216046,31.4767538],[120.4217586,31.4771322]]],[[[120.417015,31.4803041],[120.4133398,31.4802279],[120.4130633,31.483896],[120.4145025,31.4840832],[120.4166653,31.4841872],[120.417015,31.4803041]]],[[[121.275429,31.4922156],[121.2765757,31.4927159],[121.276924,31.4921245],[121.2770399,31.4916288],[121.2771394,31.4914452],[121.2772447,31.4914417],[121.2775822,31.4915817],[121.2777772,31.4917271],[121.2782806,31.4919013],[121.2793851,31.491544],[121.2794862,31.4913908],[121.2803171,31.4901312],[121.2794373,31.4884908],[121.2774727,31.4889247],[121.2773779,31.488724],[121.2762924,31.4889354],[121.2752692,31.4891646],[121.274371,31.4889918],[121.2736364,31.4887261],[121.2733726,31.4890576],[121.2729724,31.4894669],[121.2738751,31.4898726],[121.2745916,31.4902424],[121.2746765,31.490017],[121.275214,31.4901159],[121.2757518,31.4903463],[121.2759795,31.4905468],[121.2756311,31.4915096],[121.2757059,31.4916539],[121.275429,31.4922156]]],[[[120.4221852,31.4950674],[120.4222284,31.4952249],[120.4222466,31.4959648],[120.4225822,31.4969005],[120.4223264,31.4968574],[120.4219491,31.4977902],[120.4247815,31.4984099],[120.4253652,31.5000354],[120.4251543,31.5004291],[120.4254971,31.5005847],[120.4259768,31.5009147],[120.4255909,31.5012871],[120.4257758,31.5025628],[120.4257986,31.5026186],[120.4262335,31.5024826],[120.4276442,31.5020428],[120.4295609,31.5014453],[120.4228495,31.4855651],[120.4211855,31.486124],[120.4205573,31.4873025],[120.4202784,31.4876143],[120.4201317,31.4879743],[120.4199081,31.48875],[120.4198366,31.4890339],[120.4198257,31.4894881],[120.4200373,31.4904698],[120.4201882,31.4907413],[120.4208057,31.4923569],[120.4207784,31.4929522],[120.420614,31.493902],[120.4207236,31.4951119],[120.4208388,31.4950822],[120.4209843,31.4954451],[120.4221852,31.4950674]]],[[[120.41399,31.494356],[120.4139688,31.4942232],[120.4135653,31.4940482],[120.4132751,31.4938068],[120.4131618,31.4932515],[120.4128646,31.493167],[120.4125531,31.4931368],[120.4120505,31.493167],[120.4115904,31.4933903],[120.411095,31.4938128],[120.4136715,31.4963478],[120.4143722,31.495883],[120.4137635,31.4951889],[120.4137423,31.4949777],[120.414351,31.4950199],[120.4144997,31.4949173],[120.4142661,31.4947544],[120.4140608,31.4946035],[120.41399,31.494356]]],[[[120.7063051,31.657593],[120.7057437,31.657719],[120.705642,31.6575183],[120.7049182,31.6577275],[120.7044754,31.657817],[120.7031811,31.6580373],[120.7031766,31.6584662],[120.703789,31.6584618],[120.7060499,31.6586921],[120.706402,31.6586704],[120.7071523,31.6595869],[120.707581,31.6593524],[120.7073524,31.6590759],[120.7069634,31.6586052],[120.7066572,31.6582012],[120.7063051,31.657593]]],[[[120.7026882,31.6662323],[120.7025208,31.666029],[120.7022621,31.6661427],[120.7021975,31.6663439],[120.7022476,31.6666026],[120.7023266,31.6666683],[120.7024865,31.6670493],[120.7028559,31.6669573],[120.7032026,31.6669635],[120.7033099,31.6661634],[120.7031651,31.6659665],[120.7030959,31.6660113],[120.7026882,31.6662323]]],[[[121.2696134,32.0116516],[121.2713203,32.0113643],[121.2714436,32.0113434],[121.2714867,32.0115367],[121.2720105,32.0113329],[121.2719859,32.0112441],[121.271727,32.0099273],[121.2695087,32.010011],[121.2696134,32.0116516]]],[[[121.44732,30.9375461],[121.4470896,30.9381627],[121.4482865,30.9384736],[121.4494152,30.9388099],[121.4496518,30.9381316],[121.44732,30.9375461]]],[[[121.4230098,31.0122929],[121.4233417,31.0117413],[121.4226776,31.011449],[121.4231493,31.0105227],[121.4225101,31.0102533],[121.4219338,31.0112161],[121.4216594,31.0116745],[121.4215976,31.0117777],[121.4230098,31.0122929]]],[[[121.4046367,31.046751],[121.404766,31.0462982],[121.4029122,31.0455432],[121.4018762,31.0472247],[121.4030547,31.0478072],[121.4031346,31.0476369],[121.4043363,31.048234],[121.4046953,31.0468969],[121.4048406,31.0469272],[121.4049071,31.0467481],[121.4048077,31.046727],[121.4047724,31.0467997],[121.4046367,31.046751]]],[[[121.4460428,31.0484982],[121.4459854,31.0487316],[121.4456155,31.048677],[121.4455258,31.0489978],[121.4475065,31.0492819],[121.4477405,31.0488066],[121.4460428,31.0484982]]],[[[121.4519214,31.1180561],[121.4511409,31.1180352],[121.4506437,31.1180107],[121.4505588,31.1187156],[121.451084,31.1187139],[121.452019,31.1187104],[121.4519214,31.1180561]]],[[[121.368731,31.1381561],[121.3694304,31.1368639],[121.3700096,31.1370775],[121.3712636,31.1348121],[121.3698859,31.1342675],[121.3686039,31.136542],[121.3692239,31.13679],[121.3685369,31.1381165],[121.368731,31.1381561]]],[[[121.4577598,31.1578834],[121.4585698,31.1571397],[121.4582265,31.1566898],[121.4578456,31.1562812],[121.4569337,31.1555054],[121.4563704,31.1561711],[121.4575345,31.1576217],[121.4577598,31.1578834]]],[[[121.4466915,31.1609011],[121.4467129,31.1608323],[121.4467666,31.1604926],[121.4467719,31.1603227],[121.4451358,31.1599601],[121.4449641,31.160309],[121.445066,31.1604972],[121.4466915,31.1609011]]],[[[121.4444706,31.161328],[121.4448415,31.1614706],[121.4464769,31.1620992],[121.4466164,31.1613005],[121.4465895,31.1612041],[121.4464286,31.1611628],[121.4448836,31.1608277],[121.4446905,31.1608965],[121.4444706,31.161328]]],[[[121.4349242,31.1804866],[121.435109,31.1807133],[121.4357006,31.1804049],[121.4359625,31.1803865],[121.4359717,31.1801598],[121.4358454,31.1801466],[121.4356636,31.1801571],[121.4354572,31.1802072],[121.4351029,31.1803812],[121.4349242,31.1804866]]],[[[121.4688119,31.1924024],[121.4687999,31.1923647],[121.468832,31.1923595],[121.468846,31.1923887],[121.4693405,31.1922088],[121.4693037,31.1921447],[121.4690507,31.1919706],[121.4666091,31.1907032],[121.4668547,31.1904029],[121.4664786,31.1902011],[121.4658609,31.1910242],[121.4660143,31.1927406],[121.4661082,31.1927739],[121.4668255,31.1926198],[121.4671009,31.1925994],[121.4680052,31.1925703],[121.4681343,31.1925609],[121.4681673,31.1925548],[121.4681793,31.1925805],[121.4688119,31.1924024]]],[[[121.3673128,31.1934667],[121.3669205,31.194813],[121.368499,31.1953603],[121.3695264,31.1943216],[121.3686998,31.1939141],[121.3673128,31.1934667]]],[[[121.3835552,31.1959369],[121.3841286,31.1951032],[121.382235,31.1942681],[121.3818554,31.1948543],[121.3835552,31.1959369]]],[[[121.4051164,31.1983928],[121.4048606,31.1975403],[121.4047461,31.1974885],[121.4032579,31.1978398],[121.4036552,31.1989515],[121.4049818,31.1985886],[121.4051164,31.1983928]]],[[[121.4375054,31.2034644],[121.4376964,31.2031286],[121.4367744,31.2026685],[121.4365919,31.2030417],[121.4375054,31.2034644]]],[[[121.4270772,31.2123475],[121.4274754,31.2124215],[121.4281973,31.2125117],[121.4283931,31.211875],[121.4284828,31.211607],[121.4281803,31.2109325],[121.4281426,31.2104848],[121.4277141,31.210447],[121.427692,31.2105415],[121.4274887,31.2105188],[121.4274269,31.2112103],[121.4271088,31.2111838],[121.4270999,31.2113123],[121.4266449,31.2112745],[121.4266357,31.2115705],[121.4267542,31.2115716],[121.4267489,31.2116003],[121.4267489,31.211645],[121.4267431,31.2116663],[121.4267698,31.2116668],[121.4267524,31.2118274],[121.4267527,31.211983],[121.426745,31.2123089],[121.4270772,31.2123475]]],[[[121.3642361,31.2114818],[121.3640255,31.2127235],[121.3642411,31.2126719],[121.3658211,31.2118475],[121.3654841,31.2116067],[121.3642361,31.2114818]]],[[[121.4397275,31.2296169],[121.4410274,31.2301911],[121.4409445,31.230325],[121.4408579,31.2302858],[121.4407274,31.2304965],[121.441832,31.2310459],[121.4422765,31.2291098],[121.4406046,31.2282527],[121.4398141,31.2294746],[121.4397275,31.2296169]]],[[[121.4687864,31.2333445],[121.4690132,31.2331019],[121.4682531,31.2326102],[121.4679997,31.232864],[121.4687864,31.2333445]]],[[[121.4627098,31.2330866],[121.4625365,31.2340354],[121.4630283,31.2340981],[121.4631581,31.2333866],[121.4632295,31.2333768],[121.4632724,31.2329561],[121.462919,31.2329372],[121.4628638,31.2329508],[121.4628024,31.2329797],[121.4627607,31.2330215],[121.4627098,31.2330866]]],[[[121.4624939,31.2343402],[121.4623597,31.2349105],[121.462785,31.2349766],[121.4631313,31.2350266],[121.4636777,31.2350439],[121.4637924,31.2348612],[121.4634731,31.2346594],[121.4632787,31.2346108],[121.4630976,31.2344681],[121.4629649,31.2344017],[121.4624939,31.2343402]]],[[[121.4529911,31.2494025],[121.4530689,31.2494437],[121.4533585,31.249446],[121.4533685,31.2492166],[121.4532884,31.249214],[121.4532624,31.2488782],[121.4527182,31.248853],[121.4527052,31.2492495],[121.4529911,31.2494025]]],[[[121.3894252,31.2569991],[121.3893488,31.2566424],[121.3878864,31.2562864],[121.3877239,31.2562986],[121.3890611,31.2576044],[121.3891393,31.257511],[121.3894252,31.2569991]]],[[[121.4793341,31.2688747],[121.4794132,31.2692801],[121.4798638,31.2691838],[121.4798027,31.2687849],[121.4793341,31.2688747]]],[[[121.4784395,31.2690382],[121.4785185,31.269442],[121.4785555,31.2697048],[121.4793439,31.2695874],[121.4791271,31.2687343],[121.478001,31.2688712],[121.4780329,31.2690927],[121.4784395,31.2690382]]],[[[121.4701095,31.279386],[121.4699845,31.2793944],[121.4695312,31.2794244],[121.469306,31.2795078],[121.4694879,31.2798926],[121.4702133,31.2796743],[121.4701095,31.279386]]],[[[121.4689559,31.2858119],[121.4697607,31.2857973],[121.4705032,31.2844466],[121.4708707,31.2843481],[121.4715975,31.2846438],[121.4706588,31.2800042],[121.470429,31.2799413],[121.4672769,31.2811005],[121.4659627,31.281579],[121.4667057,31.2819793],[121.4662023,31.2827289],[121.4671589,31.2832132],[121.4673049,31.2833103],[121.4662063,31.2849991],[121.4664092,31.2851],[121.4678938,31.2855752],[121.4685709,31.2857838],[121.4689559,31.2858119]]],[[[121.4800493,31.2846123],[121.4801447,31.2846108],[121.4801425,31.2845117],[121.4800243,31.2845136],[121.480025,31.2845462],[121.4800029,31.2845466],[121.4800012,31.2844711],[121.479887,31.284473],[121.479889,31.2845628],[121.4799137,31.2845624],[121.4799146,31.2846021],[121.4798206,31.2846036],[121.4798221,31.2846712],[121.4799207,31.2846696],[121.4799211,31.2846886],[121.4799832,31.2846875],[121.4799844,31.2847417],[121.4800957,31.2847399],[121.4800932,31.2846262],[121.4800497,31.2846269],[121.4800493,31.2846123]]],[[[121.4723313,31.2883301],[121.4721962,31.2876091],[121.4717032,31.2876696],[121.4715769,31.2871114],[121.4716324,31.2868797],[121.4715678,31.2866638],[121.4711061,31.2866448],[121.4710944,31.2865869],[121.4706622,31.2865712],[121.4705854,31.2873771],[121.4701681,31.2873617],[121.4699963,31.2880545],[121.4694705,31.2881108],[121.4691642,31.2880612],[121.4692332,31.287836],[121.4686538,31.2877099],[121.468627,31.2876114],[121.4679242,31.2874509],[121.4680081,31.2871716],[121.4674027,31.2870567],[121.4673062,31.287416],[121.4663321,31.287225],[121.4664377,31.2868318],[121.4658972,31.2867196],[121.4657957,31.28677],[121.4659271,31.2874852],[121.466029,31.2874737],[121.4660805,31.2877892],[121.4664273,31.2879284],[121.4669193,31.2879465],[121.466916,31.288042],[121.4678758,31.2880692],[121.4678721,31.2889574],[121.4723313,31.2883301]]],[[[121.4585564,31.2871716],[121.4584953,31.2873264],[121.4588479,31.2888686],[121.4594093,31.2888027],[121.459493,31.2890518],[121.4600885,31.2889788],[121.4600563,31.288656],[121.4601092,31.2886118],[121.4606286,31.2885725],[121.4605257,31.2878107],[121.4585564,31.2871716]]],[[[121.4563214,31.2897055],[121.4565253,31.2892014],[121.4565774,31.2886751],[121.4565997,31.2878987],[121.4566901,31.2869174],[121.4566253,31.2866057],[121.4554377,31.2864763],[121.4546508,31.286435],[121.4539522,31.286503],[121.4530661,31.2867407],[121.4529359,31.2867855],[121.452993,31.2869745],[121.4531088,31.2873574],[121.4533975,31.2883126],[121.4536921,31.2890102],[121.4540668,31.2896432],[121.455654,31.2898998],[121.455723,31.2895806],[121.4563214,31.2897055]]],[[[121.4584937,31.3018414],[121.4589436,31.3017905],[121.4595034,31.3017315],[121.459495,31.3016795],[121.4594822,31.3015702],[121.4596039,31.3012565],[121.4596997,31.3009832],[121.4597555,31.3002732],[121.4573907,31.2991432],[121.4561795,31.2998869],[121.4562841,31.3003516],[121.4564933,31.3003659],[121.4566486,31.3005102],[121.4574199,31.3013843],[121.4576829,31.3016762],[121.4577392,31.3017607],[121.4579962,31.3018376],[121.4582145,31.3018533],[121.4584937,31.3018414]]],[[[121.4227704,31.301313],[121.4227067,31.303206],[121.4227067,31.3032967],[121.4247949,31.3032907],[121.4246887,31.3012404],[121.4227704,31.301313]]],[[[121.404824,31.304483],[121.405487,31.3043991],[121.4085318,31.3043895],[121.4085956,31.3043074],[121.4089046,31.3039517],[121.4088458,31.3025449],[121.4058254,31.3026924],[121.4044726,31.3032386],[121.404824,31.304483]]],[[[121.4774241,31.309972],[121.475489,31.3097011],[121.475245,31.3114933],[121.4776518,31.311667],[121.4775867,31.3127715],[121.4788877,31.3128688],[121.478969,31.311799],[121.4804976,31.3118754],[121.4804244,31.3100415],[121.4790096,31.3099998],[121.4780421,31.3099928],[121.4774241,31.309972]]],[[[121.4749967,31.3131648],[121.475489,31.3097011],[121.4717676,31.3092487],[121.4717332,31.3093021],[121.4716451,31.3094384],[121.4713517,31.3099976],[121.470998,31.3101882],[121.4707187,31.310161],[121.4703217,31.3101335],[121.4700804,31.3102786],[121.4700792,31.3109578],[121.4701729,31.3111592],[121.4703195,31.3112925],[121.4710543,31.3118534],[121.4717438,31.3124438],[121.4724412,31.3133726],[121.472921,31.3131893],[121.4731989,31.3131164],[121.4738221,31.3130671],[121.4749967,31.3131648]]],[[[121.397034,31.320592],[121.3971931,31.3205902],[121.397181,31.3212982],[121.3972977,31.3213693],[121.3975927,31.3213819],[121.3977376,31.3214174],[121.3979924,31.3213842],[121.3997385,31.3215159],[121.3998055,31.3208766],[121.3998914,31.3205524],[121.4006746,31.3207392],[121.401148,31.3186815],[121.4020251,31.3188431],[121.4021149,31.3185475],[121.4031006,31.3187319],[121.4031234,31.318662],[121.4022383,31.3184982],[121.4021981,31.3184512],[121.4020787,31.3184272],[121.4026809,31.3161415],[121.4030524,31.3162137],[121.4031333,31.3158739],[121.4032066,31.3155663],[121.4029732,31.3153887],[121.4016402,31.3151161],[121.4016858,31.3149671],[121.3999558,31.3146845],[121.3997363,31.3150473],[121.3993258,31.3152106],[121.3988303,31.3152952],[121.398172,31.315265],[121.3976836,31.315265],[121.3968837,31.3152081],[121.3969589,31.3153139],[121.3969788,31.3154131],[121.396719,31.3174256],[121.3966659,31.3175125],[121.396268,31.3179195],[121.3961765,31.3182072],[121.3962042,31.3185788],[121.3962467,31.3187058],[121.3964732,31.3189114],[121.3966858,31.3191066],[121.3969865,31.319455],[121.3971032,31.3196733],[121.3970819,31.3201026],[121.397034,31.320592]]],[[[121.4086284,31.3384786],[121.4094078,31.3365112],[121.4082491,31.336273],[121.4082766,31.3361346],[121.4083307,31.3358619],[121.408675,31.3341261],[121.4088606,31.3340599],[121.4089572,31.3333316],[121.4091417,31.3322154],[121.4092898,31.3315812],[121.4095923,31.3312256],[121.4099281,31.3313521],[121.4107221,31.3314896],[121.4119398,31.3315216],[121.4126962,31.331627],[121.412988,31.331221],[121.4131039,31.3308985],[121.413238,31.3307198],[121.414343,31.3299637],[121.4148387,31.3296173],[121.415019,31.3296933],[121.4154481,31.329785],[121.4181838,31.3298151],[121.4182283,31.3295056],[121.4183398,31.329509],[121.4183801,31.3295365],[121.4184565,31.3294655],[121.4190157,31.3294895],[121.4190182,31.3294535],[121.4190204,31.3294214],[121.4185504,31.3294036],[121.4184431,31.3293234],[121.4183341,31.3293176],[121.4188009,31.3282683],[121.4175027,31.3282316],[121.4172366,31.3282747],[121.4171218,31.3283874],[121.4159545,31.3283434],[121.4163064,31.3274114],[121.4163815,31.3266965],[121.4165478,31.3259038],[121.4167624,31.3248361],[121.4173171,31.3220334],[121.4174866,31.3216466],[121.4179479,31.3211288],[121.4182612,31.3209473],[121.4190069,31.3206632],[121.4196324,31.3201252],[121.4201152,31.3199694],[121.42026,31.3198639],[121.4205336,31.3192544],[121.4206784,31.3191215],[121.4224326,31.3175955],[121.4227888,31.3172994],[121.4229497,31.3169878],[121.4228853,31.3166853],[121.4228317,31.3163187],[121.422839,31.3152169],[121.4191818,31.3147105],[121.4194259,31.3134501],[121.4186883,31.3133402],[121.4189565,31.3119263],[121.4196914,31.3120317],[121.419957,31.3106613],[121.4266491,31.3115596],[121.4268073,31.3114829],[121.426924,31.3113946],[121.4272011,31.3099789],[121.4276995,31.3077878],[121.4261609,31.307806],[121.4247764,31.307542],[121.4251478,31.3053728],[121.4218318,31.3052668],[121.4178622,31.305056],[121.4142627,31.3048955],[121.4142439,31.3050331],[121.4126785,31.3049667],[121.4125541,31.3067358],[121.4113712,31.3066315],[121.4112505,31.3067749],[121.4112022,31.3070315],[121.4107141,31.3086676],[121.4105907,31.3088602],[121.410403,31.3088464],[121.4101106,31.3089472],[121.4099309,31.3089724],[121.4094615,31.3089862],[121.4095554,31.3095178],[121.4095151,31.3097562],[121.409397,31.3100152],[121.4090002,31.3104666],[121.4085173,31.3112022],[121.4084336,31.3115982],[121.4084121,31.3121894],[121.4082083,31.3148109],[121.4080935,31.3164406],[121.4079969,31.3173434],[121.4079098,31.3180136],[121.4093247,31.3181591],[121.4089143,31.3204333],[121.4083296,31.3235254],[121.4076081,31.3270722],[121.4073922,31.3280482],[121.4069134,31.3302248],[121.4067042,31.3305181],[121.4065888,31.3313039],[121.4066559,31.3315376],[121.406554,31.3322157],[121.4059596,31.3335606],[121.4060282,31.3338812],[121.4057868,31.3351458],[121.4054671,31.3352533],[121.4048319,31.3385089],[121.4045605,31.3397847],[121.4046517,31.3398901],[121.4049735,31.3399909],[121.4058941,31.340195],[121.4073961,31.3402225],[121.4074304,31.3400459],[121.4076482,31.3394986],[121.4082544,31.3392649],[121.4084068,31.3390379],[121.4086284,31.3384786]]],[[[121.4492246,31.3242199],[121.4493421,31.3240404],[121.4501376,31.3231477],[121.4495045,31.3227493],[121.449895,31.322264],[121.4504578,31.3215646],[121.4509343,31.3219023],[121.4509458,31.3217924],[121.4487143,31.3202792],[121.4484289,31.3201351],[121.4482529,31.3200882],[121.4482391,31.3201276],[121.4482188,31.3201902],[121.4481848,31.3202447],[121.4481699,31.3202707],[121.4476983,31.3210917],[121.4476409,31.3211205],[121.44722,31.3216101],[121.4473373,31.3216887],[121.4466671,31.3224607],[121.4469585,31.3226446],[121.4469039,31.3227045],[121.4455436,31.3242077],[121.4455355,31.3242284],[121.4455514,31.3242437],[121.4467631,31.3250443],[121.4467888,31.325049],[121.4468105,31.3250393],[121.4482007,31.3234922],[121.4485446,31.3236907],[121.4480193,31.3242759],[121.4487746,31.3247292],[121.4492246,31.3242199]]],[[[121.4800846,31.334118],[121.4812142,31.3355735],[121.4812815,31.3356603],[121.4813905,31.3358008],[121.4855683,31.3334421],[121.4861647,31.333111],[121.4810818,31.3262405],[121.480473,31.3251109],[121.4773946,31.3268178],[121.4758784,31.3249548],[121.4727049,31.3267869],[121.4751428,31.3299657],[121.4752681,31.3299005],[121.4787073,31.3342603],[121.4792323,31.3339748],[121.4793776,31.3341741],[121.4794368,31.3341644],[121.4796796,31.3340129],[121.4797889,31.3340002],[121.4800846,31.334118]]],[[[121.4080404,31.366805],[121.4065737,31.3663252],[121.4069152,31.3657511],[121.406463,31.3655236],[121.4061006,31.3661421],[121.4057925,31.3660347],[121.4049939,31.3675564],[121.4049347,31.3675206],[121.404814,31.3676995],[121.4047302,31.3678131],[121.4048395,31.3678642],[121.4047474,31.3680278],[121.4046661,31.3679983],[121.4042791,31.3687476],[121.4053981,31.3691748],[121.4055436,31.369139],[121.4060267,31.3693284],[121.4060883,31.3694252],[121.4063446,31.3695262],[121.4064654,31.369541],[121.4071654,31.3697809],[121.4085581,31.3672133],[121.4080404,31.366805]]],[[[121.3526684,31.3733751],[121.3552045,31.3741176],[121.3578585,31.3751252],[121.3588374,31.373316],[121.3574201,31.3728169],[121.3573266,31.3728009],[121.3572284,31.3728049],[121.357074,31.3731403],[121.3531121,31.3721515],[121.3526684,31.3733751]]],[[[121.418834,31.3761316],[121.4209742,31.3726367],[121.4207085,31.3724334],[121.420001,31.3720522],[121.4199668,31.3721489],[121.4193855,31.37278],[121.418629,31.3724609],[121.416678,31.3752898],[121.418834,31.3761316]]],[[[121.4605763,31.3878486],[121.460594,31.3878048],[121.4605391,31.3877716],[121.4604312,31.3874256],[121.4604524,31.3871159],[121.4601215,31.3870102],[121.460072,31.3871356],[121.4598596,31.387119],[121.4598543,31.3871326],[121.4597269,31.387122],[121.4595269,31.3869966],[121.4595901,31.3869125],[121.4596596,31.3868199],[121.4594172,31.3866703],[121.4592946,31.3868523],[121.4591394,31.3870827],[121.4589996,31.3870691],[121.4589609,31.3875957],[121.4589541,31.3876892],[121.4589199,31.3881538],[121.4592916,31.3881764],[121.459465,31.3877429],[121.4594891,31.387754],[121.4595114,31.3877643],[121.4596154,31.3877867],[121.4604482,31.3878885],[121.460456,31.3878894],[121.4604683,31.3878456],[121.4605763,31.3878486]]],[[[121.4359293,31.3883567],[121.4367234,31.3886235],[121.4371874,31.3877804],[121.4360369,31.3873853],[121.4342902,31.3867711],[121.4334635,31.3881939],[121.4355155,31.3890555],[121.4359293,31.3883567]]],[[[121.4322253,31.6055018],[121.4323441,31.6054362],[121.4319799,31.6048317],[121.4342682,31.6033919],[121.432671,31.6014668],[121.4315129,31.6026441],[121.4311206,31.6033203],[121.4304108,31.6037976],[121.4295421,31.6045453],[121.4287202,31.6054203],[121.4296262,31.6065419],[121.429711,31.6064941],[121.4298937,31.6063913],[121.4302053,31.6062158],[121.4304575,31.6064783],[121.4305345,31.6064358],[121.43083,31.6062726],[121.4313648,31.6059772],[121.4322253,31.6055018]]],[[[121.55165,30.8419615],[121.5517249,30.841766],[121.5519054,30.8412955],[121.5518413,30.8412391],[121.5530321,30.8378924],[121.5395057,30.8346462],[121.5373385,30.8398246],[121.5374203,30.8399017],[121.5392268,30.8403853],[121.5418097,30.841044],[121.5433305,30.841424],[121.5511331,30.8432294],[121.5513755,30.8425481],[121.5514071,30.8424593],[121.5515688,30.8420049],[121.55165,30.8419615]]],[[[121.482944,31.1545704],[121.4831758,31.1538664],[121.4835361,31.1525718],[121.4829659,31.1522845],[121.4825947,31.1522094],[121.4823806,31.1521685],[121.4820521,31.1532014],[121.4803533,31.1579505],[121.4818114,31.1581564],[121.4820663,31.1572478],[121.4818398,31.1571509],[121.4819672,31.1567511],[121.4823069,31.1568117],[121.4828006,31.1554855],[121.4828849,31.1551272],[121.4828406,31.1549457],[121.482944,31.1545704]]],[[[121.5303564,31.1711592],[121.530247,31.1712813],[121.5301043,31.171343],[121.5300255,31.17148],[121.5309929,31.171827],[121.5311984,31.1714891],[121.5303564,31.1711592]]],[[[121.4814401,31.1782791],[121.4818014,31.1784176],[121.4823205,31.1776674],[121.4819695,31.1774862],[121.4815609,31.177607],[121.4813071,31.1780995],[121.4813828,31.1782326],[121.4814401,31.1782791]]],[[[121.5016155,31.2050696],[121.5017925,31.2053765],[121.5019058,31.2053551],[121.5018217,31.2050335],[121.5016155,31.2050696]]],[[[121.5258641,31.2386031],[121.525223,31.240208],[121.526159,31.2405462],[121.5271085,31.2388664],[121.525919,31.2384719],[121.5258641,31.2386031]]],[[[121.5108551,31.28948],[121.5106499,31.2894891],[121.5104729,31.2889749],[121.510303,31.2890414],[121.5102611,31.2880677],[121.5098733,31.2874259],[121.5103224,31.2872367],[121.5101839,31.2870988],[121.5091212,31.2868571],[121.5082312,31.2874036],[121.5081997,31.2874142],[121.5080461,31.2874403],[121.5079094,31.2874034],[121.5075461,31.2872459],[121.5072629,31.2871652],[121.5068443,31.2872942],[121.5064127,31.2874724],[121.5062839,31.2876305],[121.5059079,31.2878243],[121.5054605,31.2878804],[121.5047772,31.2880445],[121.505523,31.2894359],[121.5050513,31.2896315],[121.5058689,31.2913559],[121.507615,31.2907125],[121.5077062,31.2908706],[121.5102504,31.2898781],[121.5105076,31.2898064],[121.5108419,31.2897591],[121.5108551,31.28948]]],[[[121.5102736,31.2899987],[121.5102883,31.2900737],[121.509707,31.2902462],[121.5084142,31.2907172],[121.5077407,31.290947],[121.5080997,31.2915799],[121.509124,31.291194],[121.508975,31.2908224],[121.5089292,31.2907052],[121.509821,31.2904402],[121.5100343,31.2911556],[121.5109872,31.2909294],[121.5109456,31.2898979],[121.5107345,31.2898963],[121.5105005,31.2899466],[121.5102736,31.2899987]]],[[[121.4876271,31.2978052],[121.4882019,31.2958382],[121.4867533,31.2955344],[121.4862812,31.2969729],[121.4864752,31.2972271],[121.4867772,31.2975072],[121.4876271,31.2978052]]],[[[121.5053904,31.2992376],[121.5055649,31.2989084],[121.5052316,31.2987919],[121.5050659,31.2991022],[121.5053904,31.2992376]]],[[[121.4895411,31.3020686],[121.4900453,31.3019936],[121.4899632,31.3015491],[121.4911973,31.3013571],[121.4911777,31.3011969],[121.4926669,31.3010045],[121.4943302,31.2981354],[121.4938287,31.2980123],[121.4938304,31.2976305],[121.4939162,31.2972042],[121.4910382,31.2965487],[121.4909416,31.2968192],[121.4899412,31.2965923],[121.4900458,31.2963058],[121.4890963,31.2960812],[121.4883023,31.2983364],[121.4886644,31.2985473],[121.488753,31.2994594],[121.4886054,31.2998536],[121.4895442,31.3000737],[121.4895925,31.3004518],[121.4900056,31.300587],[121.4901236,31.3014648],[121.489453,31.3016688],[121.4895411,31.3020686]]],[[[121.5065656,31.2976493],[121.5060753,31.2980257],[121.5056899,31.2985483],[121.5079284,31.2992196],[121.5078406,31.2993754],[121.5071503,31.3005898],[121.5094911,31.3013109],[121.5095998,31.3008002],[121.5098752,31.3006087],[121.5096494,31.3001858],[121.508169,31.2970254],[121.5065656,31.2976493]]],[[[121.5134832,31.2993333],[121.513559,31.2991643],[121.512967,31.2989948],[121.5121371,31.3008661],[121.5129298,31.3011104],[121.5130406,31.3008292],[121.5130989,31.3007878],[121.5131613,31.3007912],[121.5138213,31.3009945],[121.5139017,31.3010164],[121.5139441,31.3007688],[121.5144323,31.2995953],[121.5134832,31.2993333]]],[[[121.5121452,31.3035661],[121.5119538,31.3041209],[121.5119236,31.3041991],[121.5117638,31.3041518],[121.5116367,31.3044098],[121.5115044,31.304442],[121.5110314,31.3051629],[121.5112417,31.3052551],[121.511166,31.3055048],[121.5125107,31.3058751],[121.5127555,31.3051252],[121.5124119,31.3050018],[121.5129429,31.3035507],[121.5126082,31.30345],[121.5124507,31.3036361],[121.5121452,31.3035661]]],[[[121.5150697,31.3067474],[121.5155247,31.3068756],[121.5163089,31.3070965],[121.5168775,31.3072567],[121.5170409,31.3068333],[121.5181671,31.3071506],[121.5181842,31.3066724],[121.5187852,31.3052444],[121.517838,31.3049533],[121.5179042,31.3047961],[121.5172764,31.3046031],[121.5174103,31.3042859],[121.5155547,31.3037141],[121.5153814,31.3038377],[121.5152669,31.3044209],[121.5151219,31.305362],[121.5150772,31.3060578],[121.5150697,31.3067474]]],[[[121.5279973,31.3059359],[121.5279585,31.3060103],[121.527773,31.3059598],[121.5277278,31.3067245],[121.52791,31.3067937],[121.5279754,31.3067158],[121.5283874,31.3068385],[121.5284645,31.3069553],[121.5283445,31.3071833],[121.5288697,31.3073463],[121.5293659,31.3063633],[121.5280784,31.3059612],[121.5279973,31.3059359]]],[[[121.5296074,31.3075086],[121.5301626,31.3076719],[121.5303118,31.3073406],[121.5304385,31.3073551],[121.5307321,31.30663],[121.5305572,31.3064994],[121.5301606,31.3063138],[121.5300421,31.3065088],[121.5296074,31.3075086]]],[[[121.5273275,31.309546],[121.5273543,31.3085835],[121.5273597,31.3081504],[121.5272255,31.3081504],[121.5271746,31.307967],[121.5271746,31.3072658],[121.5265121,31.3070527],[121.5254258,31.306702],[121.5236368,31.3061566],[121.5225102,31.3058312],[121.5219899,31.305712],[121.5206649,31.3053156],[121.5205281,31.305272],[121.5204878,31.3053499],[121.5200077,31.3051941],[121.5198897,31.3054668],[121.5194874,31.306395],[121.5188758,31.3077745],[121.5208757,31.3078071],[121.5208779,31.3079019],[121.5183743,31.3078777],[121.5183528,31.3083864],[121.5191548,31.3085056],[121.51982,31.3086133],[121.5213274,31.3087462],[121.5223815,31.3091633],[121.5229206,31.3093787],[121.5242832,31.3093076],[121.5257047,31.3094474],[121.5266328,31.3094497],[121.5273275,31.309546]]],[[[121.5176794,31.307705],[121.5174652,31.3082564],[121.5175189,31.3082686],[121.5182059,31.308385],[121.5182272,31.3078539],[121.5176794,31.307705]]],[[[121.5161029,31.3080507],[121.5150462,31.3080212],[121.5149936,31.3080922],[121.5149903,31.3092069],[121.5169467,31.3092112],[121.5169496,31.308316],[121.5161029,31.3080507]]],[[[121.5171056,31.3092601],[121.5160019,31.3092475],[121.5160181,31.3097049],[121.5160093,31.3099267],[121.5171053,31.3099309],[121.5171056,31.3092601]]],[[[121.5228826,31.3095972],[121.522469,31.3094736],[121.5216968,31.3091024],[121.5216877,31.3095502],[121.520645,31.3095391],[121.5206504,31.3103338],[121.5216014,31.3103193],[121.5216007,31.3107745],[121.5206327,31.310771],[121.5206308,31.3115883],[121.5273989,31.3115838],[121.5273933,31.3098659],[121.5270178,31.3097284],[121.5266386,31.3096922],[121.5260731,31.3096902],[121.5254807,31.3096489],[121.524034,31.309557],[121.5232366,31.3096059],[121.5228826,31.3095972]]],[[[121.5059301,31.311786],[121.5052516,31.3129014],[121.5054156,31.3129527],[121.5061631,31.3131866],[121.5067678,31.3133884],[121.5072954,31.3133872],[121.5073008,31.311719],[121.506775,31.3117235],[121.5064563,31.3115833],[121.5062517,31.3119287],[121.5059301,31.311786]]],[[[121.5274372,31.3119496],[121.5273485,31.3118339],[121.5272457,31.311786],[121.5242033,31.3118231],[121.5242035,31.3127294],[121.5253177,31.3127316],[121.5253217,31.3122861],[121.5266164,31.3122952],[121.5266231,31.3125905],[121.5269774,31.312588],[121.5269733,31.31372],[121.5274598,31.3137223],[121.5274372,31.3119496]]],[[[121.4995815,31.3200144],[121.4998498,31.3179861],[121.4975162,31.3177152],[121.497378,31.3179722],[121.4972886,31.3187085],[121.4973048,31.3191531],[121.4978333,31.3192434],[121.4981586,31.319424],[121.4983212,31.3196879],[121.4984106,31.3199241],[121.4985651,31.3200213],[121.4992888,31.3200699],[121.499427,31.320056],[121.4995815,31.3200144]]],[[[121.4902006,31.326539],[121.490318,31.3264159],[121.4904816,31.326094],[121.4901335,31.3259416],[121.4902732,31.3255669],[121.4895151,31.3253846],[121.4895389,31.324767],[121.4870405,31.3246074],[121.4866817,31.3250585],[121.4857974,31.3249309],[121.4855012,31.3262685],[121.4851556,31.3278427],[121.4879968,31.3284136],[121.4882476,31.3278413],[121.4883798,31.3271782],[121.488517,31.3265731],[121.4887948,31.3263218],[121.4890932,31.3262909],[121.4895416,31.3263601],[121.4899518,31.326487],[121.4902006,31.326539]]],[[[121.4923425,31.3312868],[121.4918306,31.3311031],[121.4915486,31.3311389],[121.4907808,31.3314212],[121.4891969,31.3322701],[121.4892045,31.332492],[121.4893449,31.3326588],[121.4895327,31.3328551],[121.4898674,31.3332776],[121.4904439,31.3329323],[121.4903371,31.3327798],[121.4904469,31.3326222],[121.4925231,31.3314771],[121.4923425,31.3312868]]],[[[121.5359638,31.3367958],[121.535183,31.3372625],[121.5338156,31.3379391],[121.532735,31.3385255],[121.532246,31.3388795],[121.5320128,31.3394468],[121.5315666,31.3399113],[121.5312412,31.3403931],[121.5308384,31.3407253],[121.5308186,31.3408317],[121.5313274,31.3416333],[121.531524,31.3420175],[121.5350116,31.34092],[121.5348628,31.3406406],[121.5345621,31.3397296],[121.5347704,31.3392662],[121.5348982,31.3386475],[121.5353721,31.3378417],[121.5359638,31.3367958]]],[[[121.5395481,31.3457579],[121.5398985,31.3467439],[121.540076,31.3468494],[121.5404114,31.34672],[121.5405699,31.3470812],[121.5413625,31.3469028],[121.5406104,31.3449637],[121.5402909,31.3449202],[121.5400424,31.3440311],[121.5369597,31.3448613],[121.5370415,31.3450476],[121.5371277,31.345244],[121.5373149,31.3456702],[121.5394441,31.3452237],[121.539515,31.34536],[121.5398908,31.3452832],[121.5400142,31.3456102],[121.5395481,31.3457579]]],[[[121.4925834,31.3475685],[121.4927618,31.3461272],[121.4915345,31.3459728],[121.4914894,31.3471002],[121.4925834,31.3475685]]],[[[121.5124983,31.3819085],[121.5126611,31.3820172],[121.5125124,31.3822348],[121.5124912,31.382555],[121.5132698,31.3829055],[121.5131968,31.3830229],[121.5131495,31.3830989],[121.5142679,31.3836488],[121.5152376,31.3822589],[121.5140201,31.3816063],[121.5136662,31.3820354],[121.5125124,31.3814371],[121.5124983,31.3819085]]],[[[121.532361,31.3837856],[121.5325025,31.3836345],[121.5330971,31.3836466],[121.5333236,31.3835016],[121.5335147,31.3834834],[121.5335572,31.3826918],[121.5314054,31.3825045],[121.5312921,31.3836829],[121.532361,31.3837856]]],[[[121.4854049,31.3890888],[121.4848256,31.3901409],[121.4870501,31.3911929],[121.4880607,31.3897832],[121.4874014,31.3895202],[121.4890405,31.3868269],[121.4846408,31.3848963],[121.4828599,31.3879737],[121.4854049,31.3890888]]],[[[121.4991036,31.3893789],[121.4999735,31.3908974],[121.5003416,31.3902085],[121.5014316,31.3897916],[121.5018493,31.3904019],[121.5024637,31.3926731],[121.504079,31.3929013],[121.5043503,31.3928856],[121.5048313,31.3926609],[121.5056045,31.3922041],[121.5072143,31.3938248],[121.5076747,31.3942849],[121.5084196,31.3939764],[121.5088787,31.3936781],[121.5093534,31.3932821],[121.5093613,31.3931211],[121.5099297,31.3925638],[121.5098048,31.3925177],[121.5081245,31.3914953],[121.5065787,31.390339],[121.5055063,31.3892535],[121.5026491,31.3863353],[121.4998081,31.382333],[121.4988479,31.3825755],[121.4985975,31.3826225],[121.4980896,31.3828049],[121.4977307,31.3830407],[121.4976018,31.3831344],[121.4989986,31.3855708],[121.4973987,31.3862095],[121.4978471,31.3870902],[121.4977423,31.3872674],[121.497541,31.3876075],[121.4964865,31.3893895],[121.4957276,31.3890951],[121.4950649,31.3900031],[121.4938302,31.3894738],[121.4932158,31.3909356],[121.4942553,31.3913403],[121.4945701,31.3909341],[121.4957451,31.3914018],[121.4957408,31.3917853],[121.497305,31.3924129],[121.4975968,31.392236],[121.4986563,31.3905879],[121.4989542,31.3895982],[121.4991036,31.3893789]]],[[[121.5025141,31.4010943],[121.5022092,31.4008465],[121.5020054,31.4007275],[121.5014904,31.4003246],[121.5011042,31.4002174],[121.5009217,31.4001506],[121.5009003,31.4000865],[121.5012543,31.3982183],[121.501334,31.397706],[121.5005829,31.3984707],[121.5002933,31.3990384],[121.500263,31.3993534],[121.5002343,31.399652],[121.5001484,31.4000183],[121.4997032,31.400783],[121.5009424,31.4013049],[121.5010657,31.4014057],[121.5009906,31.4017949],[121.5009225,31.4019401],[121.500422,31.4030082],[121.5008887,31.4031593],[121.5012374,31.4026877],[121.5018489,31.4019322],[121.5025141,31.4010943]]],[[[121.5220866,31.6433694],[121.5220127,31.6438101],[121.5222746,31.6438415],[121.522558,31.6437655],[121.5226012,31.6434192],[121.5220866,31.6433694]]],[[[121.5054578,31.6638333],[121.5067828,31.6634817],[121.5063965,31.6616051],[121.5047765,31.6620252],[121.5054578,31.6638333]]],[[[121.5202795,31.6762565],[121.5209768,31.6716272],[121.5192817,31.6710428],[121.5228801,31.6484882],[121.5203653,31.6489704],[121.5201342,31.6504278],[121.5179995,31.6502106],[121.5178471,31.6511814],[121.5162347,31.6509797],[121.5151189,31.6511989],[121.5126834,31.6522583],[121.5123294,31.652377],[121.5119689,31.6527898],[121.5128336,31.6561763],[121.5129821,31.6562381],[121.5129452,31.6563387],[121.5125176,31.6565303],[121.5132063,31.6584863],[121.5144166,31.6581821],[121.5148281,31.6593145],[121.5115167,31.6602006],[121.5115255,31.6602322],[121.5117877,31.6611724],[121.5118139,31.6612665],[121.5121967,31.6626393],[121.512393,31.6633431],[121.5124006,31.6633702],[121.5128959,31.6651285],[121.512951,31.6653585],[121.5156489,31.664607],[121.5152469,31.6675107],[121.5148335,31.6704968],[121.5096837,31.6720399],[121.5088216,31.6734625],[121.5094546,31.6764391],[121.5118895,31.6759004],[121.5138207,31.6768043],[121.5148829,31.6769778],[121.5159879,31.6770965],[121.5156548,31.6795359],[121.5179728,31.6797808],[121.5184384,31.676514],[121.5202795,31.6762565]]],[[[121.5062526,31.6675267],[121.5073002,31.6673972],[121.5069852,31.6655717],[121.5059518,31.6657284],[121.5062526,31.6675267]]],[[[121.4983756,31.6717335],[121.5029045,31.6705502],[121.5020426,31.6652907],[121.4969689,31.6666264],[121.4983756,31.6717335]]],[[[121.5157335,31.6844697],[121.5156657,31.6849075],[121.5161926,31.68496],[121.5162542,31.6845142],[121.5159825,31.684491],[121.5157335,31.6844697]]],[[[121.5565391,30.8382678],[121.5572056,30.8361789],[121.5441929,30.8330917],[121.5435438,30.8351011],[121.5565391,30.8382678]]],[[[121.5636204,30.8378229],[121.5573016,30.8363099],[121.5567076,30.8382798],[121.5576825,30.8385186],[121.5629551,30.8398098],[121.5636204,30.8378229]]],[[[121.5517648,30.8421056],[121.5514013,30.8430913],[121.5515596,30.8433388],[121.554274,30.843994],[121.5551857,30.8442406],[121.5564588,30.8403554],[121.5529799,30.8393922],[121.5525261,30.8406801],[121.5543916,30.8411563],[121.5540406,30.8421828],[121.5539226,30.842154],[121.5539347,30.8421194],[121.5537268,30.8420711],[121.5536799,30.8420388],[121.5532292,30.8419605],[121.5530831,30.8424211],[121.5517648,30.8421056]]],[[[121.7232722,30.8550585],[121.7216762,30.8550401],[121.7216333,30.8535111],[121.7183771,30.8534674],[121.718545,30.8575081],[121.7233446,30.8576166],[121.7232722,30.8550585]]],[[[121.6755576,30.8771254],[121.6751833,30.8786437],[121.6779844,30.8789747],[121.6779504,30.8771838],[121.6758184,30.8769112],[121.6755576,30.8771254]]],[[[121.8753618,30.8850663],[121.8750203,30.884522],[121.8736217,30.8825263],[121.8723696,30.8810748],[121.870906,30.8792046],[121.8693611,30.8804747],[121.8740446,30.8858339],[121.8753618,30.8850663]]],[[[121.9505123,30.9574622],[121.9499215,30.9589332],[121.9497649,30.9594337],[121.9543345,30.9607826],[121.956961,30.9549229],[121.9525052,30.9537204],[121.9522917,30.9541966],[121.9519928,30.9545933],[121.9517009,30.9549229],[121.9514162,30.9555639],[121.9509749,30.9564916],[121.9505123,30.9574622]]],[[[121.886091,31.0716118],[121.8864651,31.0707482],[121.8866033,31.0706159],[121.8868065,31.070588],[121.8899288,31.071772],[121.8910346,31.0697802],[121.8864651,31.0679903],[121.8848551,31.0710895],[121.886091,31.0716118]]],[[[121.5654471,31.1205278],[121.5652348,31.1207035],[121.5650649,31.1209217],[121.5648808,31.1212489],[121.564803,31.1215519],[121.5647817,31.1220245],[121.5646614,31.122479],[121.5646826,31.1227699],[121.5646119,31.1229698],[121.5645552,31.1233092],[121.5645239,31.1237475],[121.5652334,31.1238329],[121.5670668,31.1240864],[121.5678433,31.1222296],[121.5679892,31.1219125],[121.567955,31.1216005],[121.5678298,31.1212788],[121.5680575,31.1207524],[121.565642,31.1201776],[121.5654471,31.1205278]]],[[[121.5677594,31.130665],[121.5684568,31.1299763],[121.5684783,31.1297467],[121.5656192,31.1292785],[121.5655801,31.12993],[121.5654819,31.1315652],[121.5654041,31.1326316],[121.5652625,31.1339282],[121.5655032,31.1341039],[121.5654395,31.1347704],[121.5675449,31.1349354],[121.56762,31.1341915],[121.567856,31.1337783],[121.567856,31.1335487],[121.5676951,31.1332365],[121.5675019,31.1329426],[121.5677594,31.130665]]],[[[121.7952808,31.179974],[121.7957717,31.1787982],[121.7936758,31.1782723],[121.7932515,31.1793851],[121.7952808,31.179974]]],[[[121.6092273,31.2245046],[121.609594,31.2234051],[121.6085547,31.2232076],[121.6082668,31.2242857],[121.6092273,31.2245046]]],[[[121.7417859,31.2446415],[121.7418612,31.2446038],[121.74245,31.2438316],[121.7427731,31.2433438],[121.743692,31.2415183],[121.7437766,31.2414363],[121.7438983,31.2414259],[121.7449133,31.2416722],[121.7450016,31.2416747],[121.7450553,31.2416239],[121.7457374,31.2401997],[121.7467054,31.2376541],[121.7465898,31.2376104],[121.7464709,31.2377847],[121.7459033,31.2374814],[121.7442997,31.2370074],[121.7431562,31.2407307],[121.7424277,31.2406258],[121.7418542,31.2404754],[121.7419075,31.2401876],[121.7418266,31.2401698],[121.741493,31.2400765],[121.7414863,31.2400202],[121.7406424,31.2398733],[121.7399676,31.2435772],[121.7398337,31.2438871],[121.7396441,31.2442421],[121.7391822,31.2450083],[121.7383028,31.2459885],[121.7386819,31.2460715],[121.740351,31.2444883],[121.740466,31.2444295],[121.7408142,31.244486],[121.7409093,31.2444393],[121.7409963,31.2444548],[121.7410592,31.2445365],[121.7416566,31.2446482],[121.7417859,31.2446415]]],[[[121.695739,31.2476494],[121.6963935,31.2463538],[121.6950121,31.2459295],[121.6939098,31.2480644],[121.695157,31.248468],[121.6955915,31.2478787],[121.695739,31.2476494]]],[[[121.7312086,31.2583693],[121.7312599,31.2561792],[121.7308706,31.2561174],[121.7307551,31.2561765],[121.7306469,31.2560812],[121.7300804,31.2559912],[121.7299843,31.2578758],[121.7299682,31.2583712],[121.7312086,31.2583693]]],[[[121.5542782,31.2622172],[121.5538037,31.2619855],[121.5538815,31.2614059],[121.5544199,31.2608214],[121.5535326,31.2601261],[121.5542013,31.2594093],[121.5508706,31.2572184],[121.5497535,31.2558592],[121.5472334,31.2530614],[121.5452199,31.2544475],[121.5452165,31.2544872],[121.5453994,31.2546227],[121.5456515,31.2549564],[121.5451782,31.2552949],[121.5444603,31.2560581],[121.5439803,31.2556849],[121.543734,31.2559231],[121.5469701,31.2580805],[121.5490708,31.2596932],[121.5495979,31.2600482],[121.5501962,31.2604755],[121.5510993,31.2611535],[121.5512106,31.2610591],[121.5534994,31.2626941],[121.5542782,31.2622172]]],[[[121.5627506,31.2639539],[121.5645759,31.2615953],[121.5624505,31.2605529],[121.5608832,31.262908],[121.5627506,31.2639539]]],[[[121.5582147,31.2666631],[121.5627612,31.2709307],[121.5643677,31.2694147],[121.5634494,31.268574],[121.5630229,31.2682759],[121.563299,31.2679413],[121.5623727,31.2672296],[121.5625532,31.2669974],[121.5619574,31.2664736],[121.5626689,31.2657957],[121.5619089,31.2651733],[121.5621225,31.2649364],[121.5617265,31.2646204],[121.5606219,31.263572],[121.5601588,31.2638428],[121.5599973,31.2636349],[121.5594922,31.2645801],[121.5587018,31.264214],[121.5589279,31.2639222],[121.558024,31.2637961],[121.5575171,31.2638514],[121.5572083,31.2641596],[121.5572076,31.2642673],[121.5575332,31.264492],[121.5564819,31.2653979],[121.5562157,31.2651744],[121.5560795,31.2652873],[121.5572039,31.2662401],[121.5573351,31.2661086],[121.5569937,31.2658254],[121.5571236,31.2656961],[121.5571816,31.2656764],[121.5576554,31.2660097],[121.5579569,31.2656383],[121.5585923,31.265982],[121.5582147,31.2666631]]],[[[121.5576236,31.2843005],[121.5578267,31.2832961],[121.5560497,31.2832379],[121.5558681,31.2841832],[121.5576236,31.2843005]]],[[[121.5975721,31.2868046],[121.5990927,31.2868725],[121.5996833,31.2868431],[121.5998135,31.2868033],[121.5998317,31.2854934],[121.5996926,31.2852969],[121.5996559,31.2850578],[121.5996514,31.2847053],[121.5979172,31.2845735],[121.5975721,31.2868046]]],[[[121.5678653,31.2863994],[121.5675922,31.2872743],[121.5673302,31.2884408],[121.5673202,31.2885877],[121.5676552,31.2887209],[121.5682916,31.2889529],[121.5689547,31.2890201],[121.5696477,31.2889969],[121.5702453,31.2881046],[121.5709041,31.2869415],[121.5708023,31.2869134],[121.5694236,31.28651],[121.5678653,31.2863994]]],[[[121.5571331,31.290029],[121.557181,31.2895129],[121.5555056,31.2893967],[121.5554468,31.2899391],[121.5571331,31.290029]]],[[[121.6873482,31.2906702],[121.6876384,31.2900468],[121.6837017,31.2888732],[121.6831344,31.2903921],[121.6879612,31.2913434],[121.6881269,31.2909316],[121.6873482,31.2906702]]],[[[121.6913163,31.3015697],[121.6889496,31.3046807],[121.6930382,31.3085123],[121.7069846,31.2970271],[121.7051623,31.2954255],[121.7050097,31.2952817],[121.7046583,31.2949506],[121.7041743,31.2945492],[121.7036344,31.2942962],[121.7002796,31.2929539],[121.6999737,31.2929428],[121.6998599,31.2928878],[121.6989627,31.292906],[121.6983809,31.2930317],[121.6977706,31.2933319],[121.6929899,31.2959267],[121.6917874,31.2969349],[121.6909834,31.2978337],[121.6889438,31.299911],[121.6876946,31.3003444],[121.6878042,31.3004794],[121.6884861,31.3006729],[121.6890581,31.3008179],[121.6893564,31.300868],[121.6897452,31.3008954],[121.6901287,31.3008676],[121.6905445,31.3008114],[121.6915314,31.301297],[121.6913163,31.3015697]]],[[[121.5512194,31.3105791],[121.5541682,31.3105183],[121.554977,31.3104994],[121.5549116,31.306685],[121.5544539,31.3060626],[121.5528566,31.3057203],[121.5512615,31.3056457],[121.5510591,31.3061626],[121.5512194,31.3105791]]],[[[121.5881045,31.3074721],[121.5880704,31.3094674],[121.5887333,31.3100119],[121.5892891,31.3100076],[121.5892703,31.3074743],[121.5881045,31.3074721]]],[[[121.5509751,31.3121441],[121.5509012,31.3121558],[121.5487666,31.3121261],[121.5488123,31.3128892],[121.548808,31.3132539],[121.5497087,31.3132787],[121.5496979,31.3135668],[121.5504121,31.31357],[121.5510542,31.3135729],[121.5510116,31.3133395],[121.5509697,31.3123996],[121.5509751,31.3121441]]],[[[121.5987365,31.3313357],[121.5990943,31.3307914],[121.5992733,31.3302706],[121.5997811,31.3291335],[121.5992277,31.3286492],[121.5991531,31.3284311],[121.5963607,31.3271467],[121.59575,31.3281975],[121.5969264,31.3286894],[121.5968474,31.3290641],[121.5970069,31.3292247],[121.5971356,31.3293266],[121.5967897,31.3297169],[121.5969197,31.3302019],[121.5972859,31.3307666],[121.5983998,31.3312488],[121.5987365,31.3313357]]],[[[121.5735505,31.3479332],[121.5733232,31.34859],[121.573154,31.3494592],[121.5732745,31.3498162],[121.5733444,31.3500904],[121.5735687,31.3506743],[121.575355,31.3511978],[121.5756147,31.3500292],[121.5737122,31.3478634],[121.5736465,31.3478673],[121.5735913,31.3478919],[121.5735505,31.3479332]]],[[[121.7746733,31.3521302],[121.7754727,31.3531623],[121.7762395,31.3521598],[121.7756147,31.3513827],[121.7746733,31.3521302]]],[[[121.801732,31.3692843],[121.8033923,31.3664512],[121.8018618,31.3663512],[121.7989883,31.3647942],[121.7984626,31.3649274],[121.797443,31.3669738],[121.7966008,31.3684464],[121.7959678,31.3698067],[121.796177,31.3703838],[121.7959356,31.3708006],[121.7961318,31.3709419],[121.7963677,31.3712376],[121.7964873,31.3712765],[121.7966249,31.3714999],[121.7968301,31.3715956],[121.7969412,31.3718278],[121.7971695,31.37205],[121.8012242,31.3724071],[121.801732,31.3692843]]],[[[121.5473018,31.3793958],[121.5474006,31.3793921],[121.5474563,31.3794398],[121.547613,31.379416],[121.5476301,31.3793885],[121.547761,31.3793903],[121.5482889,31.3793262],[121.5486451,31.3792639],[121.5491825,31.3791676],[121.5491008,31.3789018],[121.5485292,31.3785489],[121.5480138,31.3787406],[121.5476208,31.3784966],[121.5474779,31.3781786],[121.5447679,31.3790282],[121.5455794,31.3803527],[121.5459315,31.3802787],[121.546202,31.3802003],[121.5462837,31.3800957],[121.5462837,31.3799345],[121.5464419,31.379856],[121.5465644,31.3797907],[121.5470288,31.379477],[121.5473018,31.3793958]]],[[[122.2387869,31.4203351],[122.2387675,31.4203593],[122.2388188,31.4203638],[122.238879,31.4202853],[122.2388365,31.420234],[122.2387356,31.4202868],[122.2387799,31.4203064],[122.2387869,31.4203351]]],[[[122.2433305,31.4216343],[122.2433561,31.4216442],[122.2433912,31.4216064],[122.2434122,31.4216024],[122.2434589,31.4215087],[122.2434519,31.421431],[122.2434309,31.4213633],[122.2434098,31.4213254],[122.2433865,31.4212517],[122.2433048,31.4211939],[122.2431857,31.42118],[122.2431367,31.42118],[122.2431483,31.4212079],[122.2431904,31.4212477],[122.2432511,31.4212617],[122.2433094,31.4213155],[122.2433772,31.4213633],[122.2434145,31.4214589],[122.2433795,31.4215426],[122.2433188,31.4216163],[122.2433305,31.4216343]]],[[[122.2379529,31.421331],[122.238028,31.4213459],[122.2381166,31.4213367],[122.2381648,31.4213012],[122.2381756,31.4212406],[122.2383097,31.4212039],[122.2383755,31.4210942],[122.2384356,31.4211668],[122.2385771,31.4211901],[122.2386734,31.4212009],[122.2387723,31.4211874],[122.2389503,31.4212912],[122.2389125,31.4213868],[122.2387817,31.4214093],[122.2388013,31.4214665],[122.2388595,31.4214397],[122.2388622,31.4215152],[122.2387844,31.4215793],[122.2387464,31.421562],[122.2386342,31.4216571],[122.2386592,31.4216765],[122.2386751,31.4216888],[122.2387491,31.4217463],[122.2386554,31.4218705],[122.2388,31.4219478],[122.2388071,31.4221832],[122.2389212,31.4224399],[122.2390009,31.4226413],[122.2391278,31.422694],[122.2393128,31.422662],[122.2394343,31.4226622],[122.2394901,31.4226078],[122.2395918,31.4226047],[122.2397229,31.4225416],[122.2398429,31.4223976],[122.239971,31.4223414],[122.2400424,31.4223667],[122.2402409,31.4223758],[122.2403401,31.4224605],[122.240489,31.4224296],[122.2404099,31.4225498],[122.240343,31.4226747],[122.240265,31.4227672],[122.2403187,31.422829],[122.240485,31.4228496],[122.2405976,31.4227878],[122.2406364,31.4227496],[122.240762,31.42272],[122.2407833,31.422788],[122.2407614,31.4228231],[122.2408205,31.4229287],[122.2409106,31.4229674],[122.2408712,31.4231243],[122.2408975,31.4232642],[122.2410402,31.4234196],[122.2412267,31.4234024],[122.2412518,31.4232883],[122.2414114,31.4233162],[122.2414976,31.4232759],[122.2414607,31.4232293],[122.2415377,31.4231666],[122.241521,31.4230963],[122.2414608,31.4229587],[122.2413823,31.4228599],[122.2415976,31.4229031],[122.2416477,31.4229562],[122.2416819,31.4229693],[122.2418234,31.4229916],[122.2418475,31.4229481],[122.241818,31.4228039],[122.2417354,31.422583],[122.2419075,31.4226547],[122.242108,31.4226917],[122.2422472,31.4227146],[122.2423028,31.422646],[122.242186,31.4224714],[122.2417625,31.422364],[122.2417365,31.4223163],[122.2417814,31.4222716],[122.2420624,31.4222781],[122.2420639,31.4222545],[122.2418824,31.4221348],[122.2420553,31.4221323],[122.2420977,31.4221],[122.2421719,31.422108],[122.2422214,31.4221582],[122.2422849,31.4221872],[122.2424215,31.422211],[122.2426758,31.4221284],[122.2428822,31.4220343],[122.2429525,31.4219574],[122.242918,31.4219332],[122.2428495,31.421939],[122.2428394,31.4218497],[122.242975,31.4217587],[122.2430125,31.4216915],[122.242999,31.4216325],[122.2429614,31.4216052],[122.242964,31.4215687],[122.2430161,31.4215517],[122.2430753,31.4215831],[122.2431495,31.4215767],[122.2431955,31.4215522],[122.2431471,31.4214299],[122.2430701,31.4214179],[122.2430037,31.4214361],[122.2429762,31.4214015],[122.2429493,31.4214039],[122.2428976,31.4214334],[122.2428207,31.421436],[122.2428509,31.421408],[122.24297,31.4213518],[122.2430035,31.421322],[122.24298,31.4212481],[122.2429406,31.4212482],[122.242912,31.4211687],[122.2428428,31.421154],[122.2428363,31.4212003],[122.2428127,31.4212014],[122.242776,31.4211551],[122.2427112,31.4211765],[122.2425583,31.421268],[122.2423223,31.4213481],[122.2422391,31.4213321],[122.2424402,31.421159],[122.2424165,31.4210288],[122.242479,31.4208813],[122.2423813,31.4208171],[122.2422981,31.4208194],[122.2422525,31.4209636],[122.2421613,31.421014],[122.2420862,31.4212039],[122.2419897,31.4211833],[122.2419628,31.4210025],[122.242105,31.4208904],[122.241986,31.4206938],[122.2420138,31.4206134],[122.2418877,31.4205035],[122.2417259,31.4205047],[122.2415471,31.4205241],[122.2413701,31.4205608],[122.2412574,31.4205425],[122.2411421,31.4206043],[122.241177,31.4207416],[122.2411366,31.4207779],[122.2412002,31.4209476],[122.2410351,31.4209619],[122.2410185,31.4209247],[122.2410392,31.4208935],[122.2409955,31.4208081],[122.2408883,31.4207601],[122.2408068,31.4206065],[122.2406432,31.4204715],[122.2405071,31.4204317],[122.2403267,31.4205676],[122.2401684,31.4207416],[122.2399485,31.4208515],[122.2397688,31.4207599],[122.2397135,31.4208161],[122.2396339,31.4209661],[122.2394624,31.4209016],[122.2393225,31.420754],[122.2393208,31.4206602],[122.2395247,31.4205905],[122.2397286,31.420396],[122.2397748,31.4202481],[122.2397344,31.4201585],[122.2397572,31.4200934],[122.239573,31.4200824],[122.2396581,31.4199893],[122.239624,31.4199038],[122.239337,31.419929],[122.2393236,31.42],[122.2392135,31.4200259],[122.2389239,31.4201739],[122.2390664,31.4202582],[122.23894,31.4203525],[122.2387174,31.420412],[122.238653,31.4204829],[122.2386268,31.4205878],[122.2384651,31.4205692],[122.2384921,31.4204761],[122.2384887,31.4203937],[122.2384416,31.4203776],[122.2384465,31.4203433],[122.2383633,31.4203227],[122.2382346,31.4203319],[122.2381058,31.4203365],[122.2381648,31.4202632],[122.2381622,31.4201922],[122.2380227,31.420238],[122.2379369,31.4202083],[122.2379261,31.4202724],[122.2379905,31.4202975],[122.2379932,31.4203616],[122.2379208,31.4203593],[122.2379476,31.4204166],[122.2379556,31.4204921],[122.2378725,31.4205173],[122.2378188,31.4204623],[122.2377142,31.4204509],[122.23766,31.4204948],[122.2376204,31.4206752],[122.2375748,31.4207118],[122.2374939,31.4207088],[122.2374299,31.4206798],[122.2374192,31.4207393],[122.2374809,31.4208423],[122.2375238,31.4208995],[122.237505,31.4209842],[122.2376043,31.421046],[122.2377518,31.4210506],[122.2378939,31.4210722],[122.2379141,31.4211879],[122.237902,31.4212669],[122.2379529,31.421331]]],[[[122.2407345,31.4228553],[122.2407391,31.4228342],[122.2407376,31.4228132],[122.2407052,31.4228303],[122.2406791,31.4228921],[122.240676,31.4229315],[122.2407129,31.4229604],[122.2406946,31.4229734],[122.2406759,31.4229612],[122.2406665,31.4229803],[122.2406919,31.4229986],[122.2407268,31.4229848],[122.2407268,31.423034],[122.2407715,31.423034],[122.24079,31.4229644],[122.2407946,31.4229315],[122.240773,31.4228986],[122.2407545,31.4228802],[122.2407345,31.4228553]]],[[[122.2416892,31.4231152],[122.2417576,31.4231003],[122.2417858,31.423034],[122.2417294,31.4229928],[122.2416543,31.4230443],[122.2416436,31.4230763],[122.2416677,31.4230946],[122.2416892,31.4231152]]],[[[121.8887474,31.4540612],[121.8899082,31.4539526],[121.8888606,31.4518693],[121.8877989,31.4519297],[121.8887474,31.4540612]]],[[[121.9008237,31.4757602],[121.9068289,31.4724998],[121.8999237,31.46405],[121.8943677,31.4674045],[121.9008237,31.4757602]]],[[[121.9471702,31.5400476],[121.9469178,31.5400223],[121.9467173,31.5400414],[121.9464066,31.540126],[121.9460424,31.5403072],[121.947128,31.5418967],[121.9474421,31.5416695],[121.9477453,31.541361],[121.9479099,31.5411219],[121.9479186,31.5407551],[121.9478321,31.540499],[121.9477078,31.5403105],[121.9474189,31.540122],[121.9471702,31.5400476]]],[[[121.9341204,31.5533416],[121.9354625,31.5533842],[121.9354063,31.5462285],[121.9341168,31.5462475],[121.9341204,31.5533416]]],[[[121.7473161,31.5977255],[121.7427575,31.6004713],[121.7445987,31.6038469],[121.7511659,31.6011506],[121.7484977,31.5972501],[121.7473161,31.5977255]]],[[[121.8549097,31.731388],[121.8554881,31.7296502],[121.8526561,31.7288962],[121.8519951,31.7306341],[121.8549097,31.731388]]],[[[121.8522235,31.823477],[121.8521102,31.8230921],[121.850369,31.8196398],[121.8469996,31.8209389],[121.8492081,31.8249084],[121.8521386,31.823886],[121.8522235,31.823477]]]]}],"sha256":"4399e05ad33c6d2f28e447ab4fc6b332e0f8e4879f51a7ae71b880a733d22bce"};
(function () {
  "use strict";

  const api = window.SubwayBuilderAPI;
  const TAG = "[Shanghai Operations]";
  const CITY_CODE = "PVG";
  const VERSION = "0.8.1-dev.2";
  const DEFAULT_CENTER = [121.4737, 31.2304];
  const DEFAULT_ELEVATION = -10;
  const DEFAULT_LENGTH = 220;
  const DEFAULT_LANE_SPACING = 6;
  const THROAT_LENGTH = 90;
  const STORAGE_LENGTH = 180;
  const TURNBACK_LENGTH = 150;
  let uidCounter = 0;
  let lastStationName = "上海多线车站";
  let coreInitialized = false;
  let uiInitialized = false;
  let tileRepairSequence = 0;
  const externalTrainTypeBackup = new Map();

  // Native Load/Continue currently navigates by the legacy cityCode, although
  // the save carries cityUid. Railyard tiles require the namespaced identifier.
  // Redirect before StoreInitializer consumes the pending save. Use the game's
  // native reloadWindow bridge: browser-only reload may be cancelled and a
  // hash-change can initialize two competing maps in the same renderer.
  function repairLegacySaveEntry(location) {
    if (!location?.href || typeof location.replace !== "function") return false;
    const url = new URL(location.href);
    const [route, query = ""] = url.hash.slice(1).split("?");
    const params = new URLSearchParams(query);
    if (route !== "/game" || params.get("city") !== CITY_CODE) return false;
    params.set("city", "com.railyard.maploader:PVG");
    url.hash = route + "?" + params.toString();
    console.info(TAG + " repairing legacy PVG save entry before pending-save consumption");
    if (location === window.location && window.history?.replaceState && window.electron?.reloadWindow) {
      window.history.replaceState(window.history.state, "", url.href);
      window.electron.reloadWindow();
    } else {
      location.replace(url.href);
      location.reload?.();
    }
    return true;
  }
  let saveEntryRedirecting = false;
  function stopSaveEntryWatcher() {
    if (!window.__PVG_SAVE_ENTRY_WATCH__ || typeof window.clearInterval !== "function") return false;
    window.clearInterval(window.__PVG_SAVE_ENTRY_WATCH__);
    window.__PVG_SAVE_ENTRY_WATCH__ = null;
    return true;
  }
  function repairCurrentSaveEntry() {
    if (saveEntryRedirecting) return false;
    // location.replace is asynchronous; repeated requests cancel each other.
    saveEntryRedirecting = true;
    const requested = repairLegacySaveEntry(window.location);
    if (!requested) saveEntryRedirecting = false;
    return requested;
  }
  // Continue from the main menu can change only the hash without reloading the
  // mod; native Load uses a full renderer navigation. Support both entry paths.
  window.addEventListener?.("hashchange", repairCurrentSaveEntry);
  // React Router's pushState does not emit hashchange. A cheap URL-only watcher
  // covers that path without patching browser history or the game's save API.
  if (!window.__PVG_SAVE_ENTRY_WATCH__ && window.setInterval) {
    window.__PVG_SAVE_ENTRY_WATCH__ = window.setInterval(() => {
      const hash = window.location?.hash || "";
      if (/(?:\?|&)city=PVG(?:&|$)/.test(hash)) {
        repairCurrentSaveEntry();
      } else if (/^#\/game\?(?:.*&)?city=com\.railyard\.maploader(?::|%3A)PVG(?:&|$)/i.test(hash)) {
        stopSaveEntryWatcher();
      }
    }, 250);
  }
  if (repairCurrentSaveEntry()) return;

  if (!api) {
    console.error(TAG + " SubwayBuilderAPI is unavailable");
    return;
  }

  const TEMPLATES = [
    {
      id: "two-track-island",
      name: "2股道 · 单岛双线",
      laneCount: 2,
      platformGroups: [[0, 1]],
      bypassLanes: [],
      description: "一座岛式站台，两根站线。"
    },
    {
      id: "four-track-double-island",
      name: "4股道 · 双岛四线",
      laneCount: 4,
      platformGroups: [[0, 1], [2, 3]],
      bypassLanes: [],
      description: "两个原生双线岛式站台组件合并为一个车站组。"
    },
    {
      id: "four-track-express-bypass",
      name: "4股道 · 外侧站台/内侧越行",
      laneCount: 4,
      platformGroups: [[0], [3]],
      bypassLanes: [1, 2],
      description: "外侧两根站线，内侧两根无站台通过线。"
    },
    {
      id: "six-track-triple-island",
      name: "6股道 · 三岛六线",
      laneCount: 6,
      platformGroups: [[0, 1], [2, 3], [4, 5]],
      bypassLanes: [],
      description: "三个岛式站台组件组成六线换乘枢纽。"
    },
    {
      id: "six-track-express-bypass",
      name: "6股道 · 双岛四站线+双越行",
      laneCount: 6,
      platformGroups: [[0, 1], [4, 5]],
      bypassLanes: [2, 3],
      description: "四根站线包夹两根无站台急行通过线。"
    },
    {
      id: "eight-track-four-island",
      name: "8股道 · 四岛八线",
      laneCount: 8,
      platformGroups: [[0, 1], [2, 3], [4, 5], [6, 7]],
      bypassLanes: [],
      description: "四个岛式站台组件组成八线综合枢纽。"
    },
    {
      id: "eight-track-express-bypass",
      name: "8股道 · 三岛六站线+双越行",
      laneCount: 8,
      platformGroups: [[0, 1], [3, 4], [6, 7]],
      bypassLanes: [2, 5],
      description: "六根站线、两根无站台通过线，适合跨线急行枢纽。"
    }
  ];

  const OPERATION_PRESETS = [
    {
      id: "local-through-station",
      name: "普通中间站 · 双岛四线",
      templateId: "four-track-double-island",
      throatMode: "double-ladder",
      turnbackMode: "none",
      storageTracks: 0,
      operatingMode: "local",
      description: "两组岛式站台，适合普通线、同站换乘和临时折返。"
    },
    {
      id: "express-overtake",
      name: "快慢车越行站 · 双岛四线",
      templateId: "four-track-express-bypass",
      throatMode: "scissors",
      turnbackMode: "none",
      storageTracks: 0,
      operatingMode: "express",
      description: "外侧停车、内侧通过；普通列车待避，快车或急行不进站台。"
    },
    {
      id: "cross-platform-hub",
      name: "同台换乘枢纽 · 三岛六线",
      templateId: "six-track-triple-island",
      throatMode: "scissors",
      turnbackMode: "both",
      storageTracks: 0,
      operatingMode: "through",
      description: "三组岛台、双端折返，适合同台换乘、跨线和直通组织。"
    },
    {
      id: "regional-express-hub",
      name: "市域快慢车枢纽 · 六线",
      templateId: "six-track-express-bypass",
      throatMode: "scissors",
      turnbackMode: "both",
      storageTracks: 2,
      operatingMode: "rapid",
      description: "四根站线、两根无站台通过线，附双端折返和两条存车线。"
    },
    {
      id: "integrated-terminal",
      name: "综合始发终到站 · 四岛八线",
      templateId: "eight-track-four-island",
      throatMode: "scissors",
      turnbackMode: "both",
      storageTracks: 2,
      operatingMode: "through",
      description: "四岛八线，适合多线路始发终到、同台换乘和跨线直通。"
    },
    {
      id: "integrated-through-hub",
      name: "综合直通枢纽 · 八线含越行",
      templateId: "eight-track-express-bypass",
      throatMode: "scissors",
      turnbackMode: "both",
      storageTracks: 2,
      operatingMode: "express",
      description: "六根站线、两根通过线，适合普通、快车、急行和直通共站。"
    }
  ];

  const OPERATING_MODES = [
    {
      id: "local",
      name: "普通 / Local",
      stopStep: 1,
      preferredTrainType: "pvg-ops-light-80",
      description: "站站停；使用普通站台股道，单股道车站由双向列车共用。"
    },
    {
      id: "rapid",
      name: "快车 / Rapid",
      stopStep: 2,
      preferredTrainType: "pvg-ops-medium-120",
      description: "约隔站停；优先使用可越行的站台股道。"
    },
    {
      id: "express",
      name: "急行 / Express",
      stopStep: 3,
      preferredTrainType: "pvg-ops-heavy-160",
      description: "仅停主要换乘站；普通站走无站台通过线。"
    },
    {
      id: "through",
      name: "直通 / Through",
      stopStep: 1,
      preferredTrainType: "pvg-ops-heavy-160",
      description: "跨线路连续运营；轨距、供电、限界与轨道等级必须兼容。"
    }
  ];

  // Five deliberately broad service tiers keep the construction picker short.
  // Costs are tuned for forgiving sandbox play: faster stock is more expensive,
  // but hourly operating cost grows much more slowly than speed and capacity.
  const TRAIN_PROFILES = [
    {
      id: "pvg-ops-light-80", name: "轻运量列车 80",
      description: "支线与低客流走廊；80 km/h，2–4节编组。",
      baseIds: ["heavy-metro"], speedKph: 80, localSpeedKph: 70,
      capacityPerCar: 180, minCars: 2, maxCars: 4, carsPerCarSet: 2, carLength: 18,
      minTurnRadius: 60, minStationTurnRadius: 220, maxSlopePercentage: 6,
      stopTimeSeconds: 25, turnaroundTimeSeconds: 90, tphLimit: 40,
      carCost: 700000, baseTrackCost: 12000, baseStationCost: 10000000,
      trainOperationalCostPerHour: 160, carOperationalCostPerHour: 12,
      trackMaintenanceCostPerMeter: 80, stationMaintenanceCostPerYear: 40000,
      color: "#55A630",
      compatibleTrackTypes: ["pvg-ops-light-80", "pvg-ops-medium-120", "pvg-ops-heavy-160"]
    },
    {
      id: "pvg-ops-medium-120", name: "中运量列车 120",
      description: "城市骨干与快线；120 km/h，4–6节编组。",
      baseIds: ["heavy-metro", "commuter-rail"], speedKph: 120, localSpeedKph: 100,
      capacityPerCar: 260, minCars: 4, maxCars: 6, carsPerCarSet: 2, carLength: 20,
      minTurnRadius: 120, minStationTurnRadius: 400, maxSlopePercentage: 5,
      stopTimeSeconds: 30, turnaroundTimeSeconds: 120, tphLimit: 34,
      carCost: 1100000, baseTrackCost: 16000, baseStationCost: 16000000,
      trainOperationalCostPerHour: 220, carOperationalCostPerHour: 16,
      trackMaintenanceCostPerMeter: 100, stationMaintenanceCostPerYear: 60000,
      color: "#0072CE",
      compatibleTrackTypes: ["pvg-ops-medium-120", "pvg-ops-heavy-160"]
    },
    {
      id: "pvg-ops-heavy-160", name: "高运量列车 160",
      description: "高客流主干线与市域快线；160 km/h，6–8节编组。",
      baseIds: ["commuter-rail", "regional-rail", "heavy-metro"], speedKph: 160, localSpeedKph: 120,
      capacityPerCar: 340, minCars: 6, maxCars: 8, carsPerCarSet: 2, carLength: 22,
      minTurnRadius: 250, minStationTurnRadius: 700, maxSlopePercentage: 4.5,
      stopTimeSeconds: 35, turnaroundTimeSeconds: 150, tphLimit: 30,
      carCost: 1500000, baseTrackCost: 22000, baseStationCost: 24000000,
      trainOperationalCostPerHour: 300, carOperationalCostPerHour: 20,
      trackMaintenanceCostPerMeter: 130, stationMaintenanceCostPerYear: 80000,
      color: "#E87722",
      compatibleTrackTypes: ["pvg-ops-heavy-160", "pvg-ops-intercity-200"]
    },
    {
      id: "pvg-ops-intercity-200", name: "城际列车 200",
      description: "跨城与机场长距离服务；200 km/h，6–8节编组。",
      baseIds: ["intercity-rail", "regional-rail", "commuter-rail"], speedKph: 200, localSpeedKph: 140,
      capacityPerCar: 190, minCars: 6, maxCars: 8, carsPerCarSet: 2, carLength: 25,
      minTurnRadius: 700, minStationTurnRadius: 1200, maxSlopePercentage: 3.5,
      stopTimeSeconds: 45, turnaroundTimeSeconds: 240, tphLimit: 22,
      carCost: 2000000, baseTrackCost: 30000, baseStationCost: 34000000,
      trainOperationalCostPerHour: 420, carOperationalCostPerHour: 25,
      trackMaintenanceCostPerMeter: 160, stationMaintenanceCostPerYear: 100000,
      color: "#9C2AA0",
      compatibleTrackTypes: ["pvg-ops-heavy-160", "pvg-ops-intercity-200"]
    },
    {
      id: "pvg-ops-high-speed-300", name: "高速铁路列车 300",
      description: "高速铁路专用动车组；300 km/h，8–16节编组。",
      baseIds: ["high-speed-rail", "intercity-rail", "regional-rail", "commuter-rail", "heavy-metro"], speedKph: 300, localSpeedKph: 160,
      capacityPerCar: 120, minCars: 8, maxCars: 16, carsPerCarSet: 8, carLength: 25,
      minTurnRadius: 1400, minStationTurnRadius: 2400, maxSlopePercentage: 3.5,
      stopTimeSeconds: 60, turnaroundTimeSeconds: 300, tphLimit: 18,
      carCost: 2800000, baseTrackCost: 45000, baseStationCost: 55000000,
      trainOperationalCostPerHour: 600, carOperationalCostPerHour: 30,
      trackMaintenanceCostPerMeter: 220, stationMaintenanceCostPerYear: 140000,
      color: "#4C6B73",
      compatibleTrackTypes: ["pvg-ops-high-speed-300"]
    }
  ];

  const TRACK_CLASSES = [
    { id: "light", name: "轻运量 · 80 km/h", trackType: "pvg-ops-light-80", laneSpacing: 5.0, recommendedLength: 120 },
    { id: "medium", name: "中运量 · 120 km/h", trackType: "pvg-ops-medium-120", laneSpacing: 5.5, recommendedLength: 160 },
    { id: "heavy", name: "高运量 · 160 km/h", trackType: "pvg-ops-heavy-160", laneSpacing: 6.0, recommendedLength: 220 },
    { id: "intercity", name: "城际铁路 · 200 km/h", trackType: "pvg-ops-intercity-200", laneSpacing: 6.5, recommendedLength: 260 },
    { id: "high-speed", name: "高速铁路 · 300 km/h", trackType: "pvg-ops-high-speed-300", laneSpacing: 7.0, recommendedLength: 420 }
  ];

  const LEGACY_TYPE_MIGRATIONS = Object.freeze({
    "pvg-ops-metro-local-80": "pvg-ops-light-80",
    "pvg-ops-metro-feeder-100": "pvg-ops-medium-120",
    "pvg-ops-metro-express-120": "pvg-ops-medium-120",
    "pvg-ops-suburban-160": "pvg-ops-heavy-160",
    "pvg-ops-intercity-200": "pvg-ops-intercity-200",
    "pvg-ops-high-speed-350": "pvg-ops-high-speed-300",
    "pvg-ops-maglev-430": "pvg-ops-high-speed-300"
  });

  const COMPATIBILITY = Object.fromEntries(
    TRAIN_PROFILES.map((profile) => [profile.id, [...profile.compatibleTrackTypes]])
  );

  const INTERLOCKING_RULES = [
    {
      id: "shared-track",
      severity: "block",
      description: "两条进路共用同一轨道区段时互斥。"
    },
    {
      id: "same-throat-zone",
      severity: "block",
      description: "同一咽喉冲突区内的交叉进路互斥。"
    },
    {
      id: "reversible-opposite-direction",
      severity: "block",
      description: "可逆单线上的相向进路互斥。"
    },
    {
      id: "storage-mainline-move",
      severity: "warn",
      description: "存车线出入库与共用正线进路必须错开。"
    },
    {
      id: "platform-occupancy",
      severity: "block",
      description: "同一站台股道在列车释放前不能建立第二条进路。"
    }
  ];

  function getOperationPreset(presetId) {
    return OPERATION_PRESETS.find((preset) => preset.id === presetId) || null;
  }

  function applyPresetOptions(rawOptions) {
    const source = rawOptions || {};
    const preset = getOperationPreset(source.operationPresetId);
    if (!preset) return { ...source };
    return {
      ...source,
      templateId: source.templateId || preset.templateId,
      throatMode: source.throatMode || preset.throatMode,
      turnbackMode: source.turnbackMode || preset.turnbackMode,
      storageTracks: source.storageTracks ?? preset.storageTracks,
      operatingMode: source.operatingMode || preset.operatingMode
    };
  }

  function buildLanePlan(templateId, modeId) {
    const template = TEMPLATES.find((item) => item.id === templateId) || TEMPLATES[0];
    const mode = OPERATING_MODES.find((item) => item.id === modeId) || OPERATING_MODES[0];
    const platformLanes = [...new Set(template.platformGroups.flat())];
    const bypassLanes = [...template.bypassLanes];
    const samePlatformPairs = template.platformGroups.filter((lanes) => lanes.length === 2).map((lanes) => [...lanes]);
    const usesBypassAtSkippedStops = ["rapid", "express"].includes(mode.id) && bypassLanes.length > 0;
    return {
      mode: mode.id,
      preferredTrainType: mode.preferredTrainType,
      platformLanes,
      bypassLanes,
      samePlatformPairs,
      stoppingLanes: platformLanes,
      throughLanes: usesBypassAtSkippedStops ? bypassLanes : platformLanes,
      usesBypassAtSkippedStops,
      requiresManualStopConfirmation: true
    };
  }

  function getCompatibilityAdvice(trainType, trackType) {
    const train = TRAIN_PROFILES.find((item) => item.id === trainType);
    const trackClass = TRACK_CLASSES.find((item) => item.trackType === trackType);
    const compatible = canThroughRun(trainType, trackType);
    return {
      compatible,
      trainType,
      trackType,
      message: compatible
        ? (train?.name || trainType) + "可在" + (trackClass?.name || trackType) + "轨道上运行。"
        : (train?.name || trainType) + "不能进入" + (trackClass?.name || trackType) + "轨道；请更换车辆或制式。"
    };
  }

  function getInternalState() {
    const holder = globalThis.__subwayBuilder_storeCallbacks__;
    const state = holder && typeof holder.getState === "function" ? holder.getState() : null;
    return state && typeof state.setTracks === "function" ? state : null;
  }

  function canonicalTypeId(typeId) {
    return LEGACY_TYPE_MIGRATIONS[typeId] || typeId;
  }

  function migrateLegacyInventory() {
    const state = getInternalState();
    if (!state?.ownedCarsByType || !isPvg() || typeof state.setOwnedTrainCount !== "function") return { changed: 0 };
    const inventory = { ...state.ownedCarsByType };
    let changed = 0, cars = 0;
    for (const [oldId, targetId] of Object.entries(LEGACY_TYPE_MIGRATIONS)) {
      const count = Number(inventory[oldId]);
      if (!(count > 0) || !Number.isFinite(count)) continue;
      inventory[targetId] = (Number(inventory[targetId]) || 0) + count;
      inventory[oldId] = 0; changed++; cars += count;
    }
    if (changed) {
      // This game exposes no inventory setter. Rebind the one known field and
      // publish through its native count setter; no save reload or cash change.
      state.ownedCarsByType = inventory;
      state.setOwnedTrainCount(state.ownedTrainCount);
      console.info(TAG + " migrated legacy inventory " + JSON.stringify({ changed, cars }));
    }
    return { changed, cars };
  }

  function migrateLegacyOperationsState() {
    const state = getInternalState();
    if (!state || !isPvg()) return { ok: false, reason: "state-unavailable", changed: 0 };
    let changedTracks = 0;
    let changedGroups = 0;
    let changedRoutes = 0;
    let changedTrains = 0;

    const newTracks = (state.tracks || []).map((track) => {
      const trackType = canonicalTypeId(track.trackType);
      const operationalClass = canonicalTypeId(track.pvgOperationalTrackClass);
      if (trackType === track.trackType && operationalClass === track.pvgOperationalTrackClass) return track;
      changedTracks += 1;
      return {
        ...track,
        trackType,
        ...(track.pvgOperationalTrackClass ? { pvgOperationalTrackClass: operationalClass } : {})
      };
    });
    const newTrackGroups = (state.trackGroups || []).map((group) => {
      const trackType = canonicalTypeId(group.trackType);
      const operationalClass = canonicalTypeId(group.pvgOperationalTrackClass);
      if (trackType === group.trackType && operationalClass === group.pvgOperationalTrackClass) return group;
      changedGroups += 1;
      return {
        ...group,
        trackType,
        ...(group.pvgOperationalTrackClass ? { pvgOperationalTrackClass: operationalClass } : {})
      };
    });
    if (changedTracks || changedGroups) {
      state.setTracks({ newTracks, newTrackGroups, regenStations: false, skipHistory: true });
    }

    const newRoutes = (state.routes || []).map((route) => {
      const trainType = canonicalTypeId(route.trainType);
      const preferred = canonicalTypeId(route.pvgPreferredTrainType);
      if (trainType === route.trainType && preferred === route.pvgPreferredTrainType) return route;
      changedRoutes += 1;
      const profile = TRAIN_PROFILES.find((item) => item.id === trainType);
      const requestedCars = Number(route.carsPerTrain) || profile?.minCars || 2;
      const carsPerTrain = profile
        ? Math.max(profile.minCars, Math.min(profile.maxCars, Math.ceil(requestedCars / profile.carsPerCarSet) * profile.carsPerCarSet))
        : requestedCars;
      return {
        ...route,
        trainType,
        carsPerTrain,
        ...(route.pvgPreferredTrainType ? { pvgPreferredTrainType: preferred } : {})
      };
    });
    if (changedRoutes && typeof state.setRoutes === "function") state.setRoutes(newRoutes, false);

    const newTrains = (state.trains || []).map((train) => {
      const trainType = canonicalTypeId(train.trainType);
      if (trainType === train.trainType) return train;
      changedTrains += 1;
      return { ...train, trainType };
    });
    if (changedTrains && typeof state.setTrains === "function") state.setTrains(newTrains);

    const changed = changedTracks + changedGroups + changedRoutes + changedTrains;
    const result = { ok: true, changed, changedTracks, changedGroups, changedRoutes, changedTrains };
    globalThis.__PVG_OPERATIONS_MIGRATION__ = { ...result, timestamp: Date.now() };
    if (changed) console.info(TAG + " migrated legacy seven-tier operations data to five tiers " + JSON.stringify(result));
    return result;
  }

  function isPvg() {
    return !api.utils || typeof api.utils.getCityCode !== "function" || api.utils.getCityCode() === CITY_CODE;
  }

  function uid(prefix) {
    uidCounter += 1;
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return prefix + "-" + globalThis.crypto.randomUUID();
    }
    return prefix + "-" + Date.now().toString(36) + "-" + uidCounter.toString(36);
  }

  function notify(message, level, title) {
    if (api.ui && typeof api.ui.showNotification === "function") {
      api.ui.showNotification(message, level || "info", title || "上海多制式运营");
    }
  }

  function metersBetween(a, b) {
    const meanLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const east = (b[0] - a[0]) * 111320 * Math.cos(meanLat);
    const north = (b[1] - a[1]) * 110540;
    return Math.hypot(east, north);
  }

  function move(origin, eastMeters, northMeters) {
    const lat = origin[1] + northMeters / 110540;
    const lon = origin[0] + eastMeters / (111320 * Math.cos(origin[1] * Math.PI / 180));
    return [Number(lon.toFixed(8)), Number(lat.toFixed(8))];
  }

  function pointAt(center, forward, perpendicular, along, lateral) {
    return move(
      center,
      forward[0] * along + perpendicular[0] * lateral,
      forward[1] * along + perpendicular[1] * lateral
    );
  }

  function lanesTypeForCount(count) {
    if (count === 4) return "quad";
    if (count === 2) return "parallel";
    return "single";
  }

  function chunksForGroups(indices) {
    const result = [];
    let cursor = 0;
    while (cursor < indices.length) {
      const remaining = indices.length - cursor;
      const size = remaining >= 4 ? 4 : remaining >= 2 ? 2 : 1;
      result.push(indices.slice(cursor, cursor + size));
      cursor += size;
    }
    return result;
  }

  function makeTrack(coords, trackType, type, reversable, elevation) {
    return {
      id: uid("pvg-track"),
      coords,
      buildType: "blueprint",
      displayType: "blueprint",
      type: type || null,
      reversable: Boolean(reversable),
      interactable: true,
      length: metersBetween(coords[0], coords[coords.length - 1]),
      startElevation: elevation,
      endElevation: elevation,
      trackType,
      createdAt: Date.now(),
      curveType: "straight",
      waterIntersectionPercentage: 0
    };
  }

  function makeGroup(tracks, centerLine, trackType, type, extra) {
    return Object.assign({
      id: uid("pvg-group"),
      trackIds: tracks.map((track) => track.id),
      trackLanesType: lanesTypeForCount(tracks.length),
      centerLine,
      type: type || null,
      trackType
    }, extra || {});
  }

  function normalizeBuildOptions(options) {
    options = applyPresetOptions(options);
    const template = TEMPLATES.find((item) => item.id === options.templateId) || TEMPLATES[1];
    const trackClass = TRACK_CLASSES.find((item) => item.id === options.trackClassId) || TRACK_CLASSES[0];
    const mapCenter = api.utils && typeof api.utils.getMap === "function" ? api.utils.getMap()?.getCenter?.() : null;
    const center = Array.isArray(options.center)
      ? options.center
      : mapCenter && Number.isFinite(mapCenter.lng) && Number.isFinite(mapCenter.lat)
        ? [mapCenter.lng, mapCenter.lat]
        : DEFAULT_CENTER;
    const turnbackMode = ["none", "west", "east", "both"].includes(options.turnbackMode) ? options.turnbackMode : "none";
    const storageTracks = [0, 1, 2].includes(Number(options.storageTracks)) ? Number(options.storageTracks) : 0;
    let throatMode = ["none", "double-ladder", "scissors"].includes(options.throatMode) ? options.throatMode : "double-ladder";
    if (throatMode === "none" && (turnbackMode !== "none" || storageTracks > 0)) throatMode = "double-ladder";
    return {
      template,
      trackClass,
      center,
      name: String(options.name || lastStationName).trim() || lastStationName,
      bearing: Number.isFinite(Number(options.bearing)) ? Number(options.bearing) : 90,
      length: Math.max(120, Math.min(450, Number(options.length) || trackClass.recommendedLength || DEFAULT_LENGTH)),
      elevation: Number.isFinite(Number(options.elevation)) ? Number(options.elevation) : DEFAULT_ELEVATION,
      throatMode,
      turnbackMode,
      storageTracks,
      operatingMode: OPERATING_MODES.some((item) => item.id === options.operatingMode) ? options.operatingMode : "local",
      operationPresetId: getOperationPreset(options.operationPresetId)?.id || null
    };
  }

  function createStationTemplate(rawOptions) {
    const options = normalizeBuildOptions(rawOptions || {});
    const { template, trackClass, center, length, bearing, elevation } = options;
    const angle = bearing * Math.PI / 180;
    const forward = [Math.sin(angle), Math.cos(angle)];
    const perpendicular = [Math.cos(angle), -Math.sin(angle)];
    const spacing = trackClass.laneSpacing || DEFAULT_LANE_SPACING;
    const offsets = Array.from({ length: template.laneCount }, (_, index) =>
      (index - (template.laneCount - 1) / 2) * spacing
    );
    const half = length / 2;
    const tracks = [];
    const groups = [];
    const laneTracks = [];
    const stationLaneSet = new Set(template.platformGroups.flat());
    const bypassLaneSet = new Set(template.bypassLanes);

    for (let lane = 0; lane < template.laneCount; lane += 1) {
      const coords = [
        pointAt(center, forward, perpendicular, -half, offsets[lane]),
        pointAt(center, forward, perpendicular, half, offsets[lane])
      ];
      const isStationLane = stationLaneSet.has(lane);
      const track = makeTrack(coords, trackClass.trackType, isStationLane ? "station" : null, isStationLane, elevation);
      track.pvgRole = bypassLaneSet.has(lane) ? "express-bypass" : "platform";
      track.pvgLaneIndex = lane;
      laneTracks.push(track);
      tracks.push(track);
    }

    for (const laneIndices of template.platformGroups) {
      const componentTracks = laneIndices.map((index) => laneTracks[index]);
      const centerOffset = laneIndices.reduce((sum, index) => sum + offsets[index], 0) / laneIndices.length;
      groups.push(makeGroup(
        componentTracks,
        [
          pointAt(center, forward, perpendicular, -half, centerOffset),
          pointAt(center, forward, perpendicular, half, centerOffset)
        ],
        trackClass.trackType,
        "station",
        {
          platformLayout: laneIndices.length === 2 ? "island" : "side-platforms",
          platformWidthScale: laneIndices.length === 2 ? 1.15 : 1,
          pvgComplexId: null,
          pvgPlatformLanes: [...laneIndices],
          pvgDirectionPolicy: laneIndices.length === 1 ? "bidirectional" : "route-assigned"
        }
      ));
    }

    for (const laneChunk of chunksForGroups(template.bypassLanes)) {
      const bypassTracks = laneChunk.map((index) => laneTracks[index]);
      const centerOffset = laneChunk.reduce((sum, index) => sum + offsets[index], 0) / laneChunk.length;
      groups.push(makeGroup(
        bypassTracks,
        [
          pointAt(center, forward, perpendicular, -half, centerOffset),
          pointAt(center, forward, perpendicular, half, centerOffset)
        ],
        trackClass.trackType,
        null,
        { pvgRole: "express-bypass", pvgLaneIndices: [...laneChunk] }
      ));
    }

    const complexId = uid("pvg-station-complex");
    for (const group of groups) {
      if (group.type === "station") group.pvgComplexId = complexId;
    }

    if (options.throatMode !== "none") {
      const sides = [-1, 1];
      for (const side of sides) {
        const stationAlong = side * half;
        const outerAlong = side * (half + THROAT_LENGTH);
        const approachTracks = [];
        for (let lane = 0; lane < template.laneCount; lane += 1) {
          const coords = side < 0
            ? [pointAt(center, forward, perpendicular, outerAlong, offsets[lane]), pointAt(center, forward, perpendicular, stationAlong, offsets[lane])]
            : [pointAt(center, forward, perpendicular, stationAlong, offsets[lane]), pointAt(center, forward, perpendicular, outerAlong, offsets[lane])];
          const track = makeTrack(coords, trackClass.trackType, null, true, elevation);
          track.pvgRole = side < 0 ? "west-throat-approach" : "east-throat-approach";
          track.pvgLaneIndex = lane;
          approachTracks.push(track);
          tracks.push(track);
        }
        for (const laneChunk of chunksForGroups(Array.from({ length: template.laneCount }, (_, index) => index))) {
          const groupedTracks = laneChunk.map((lane) => approachTracks[lane]);
          const centerOffset = laneChunk.reduce((sum, lane) => sum + offsets[lane], 0) / laneChunk.length;
          groups.push(makeGroup(
            groupedTracks,
            [
              pointAt(center, forward, perpendicular, stationAlong, centerOffset),
              pointAt(center, forward, perpendicular, outerAlong, centerOffset)
            ],
            trackClass.trackType,
            null,
            { pvgRole: "throat-approach" }
          ));
        }
        for (let lane = 0; lane < template.laneCount - 1; lane += 1) {
          const diagonalPairs = [[lane, lane + 1]];
          if (options.throatMode === "scissors") diagonalPairs.push([lane + 1, lane]);
          for (const [outerLane, stationLane] of diagonalPairs) {
            const coords = side < 0
              ? [pointAt(center, forward, perpendicular, outerAlong, offsets[outerLane]), pointAt(center, forward, perpendicular, stationAlong, offsets[stationLane])]
              : [pointAt(center, forward, perpendicular, stationAlong, offsets[stationLane]), pointAt(center, forward, perpendicular, outerAlong, offsets[outerLane])];
            const crossover = makeTrack(coords, trackClass.trackType, "scissors-crossover", true, elevation);
            crossover.pvgRole = "crossover";
            crossover.pvgConflictZone = complexId + "-" + (side < 0 ? "A" : "B");
            tracks.push(crossover);
            groups.push(makeGroup(crossover ? [crossover] : [], coords, trackClass.trackType, "scissors-crossover", {
              pvgRole: "crossover",
              pvgConflictZone: crossover.pvgConflictZone
            }));
          }
        }
      }
    }

    const turnbackSides = options.turnbackMode === "both"
      ? [-1, 1]
      : options.turnbackMode === "west"
        ? [-1]
        : options.turnbackMode === "east"
          ? [1]
          : [];
    for (const side of turnbackSides) {
      const innerLeft = Math.floor((template.laneCount - 1) / 2);
      const innerRight = Math.ceil((template.laneCount - 1) / 2);
      const approachAlong = side * (half + THROAT_LENGTH);
      const mergeAlong = side * (half + THROAT_LENGTH + 30);
      const tailAlong = side * (half + THROAT_LENGTH + 30 + TURNBACK_LENGTH);
      const merge = pointAt(center, forward, perpendicular, mergeAlong, 0);
      const tail = pointAt(center, forward, perpendicular, tailAlong, 0);
      const zone = complexId + "-" + (side < 0 ? "A" : "B");
      const leads = [innerLeft, innerRight].map((lane) => {
        const approach = pointAt(center, forward, perpendicular, approachAlong, offsets[lane]);
        const coords = side < 0 ? [merge, approach] : [approach, merge];
        const track = makeTrack(coords, trackClass.trackType, "scissors-crossover", true, elevation);
        track.pvgRole = "turnback-lead";
        track.pvgLaneIndex = lane;
        track.pvgConflictZone = zone;
        tracks.push(track);
        return track;
      });
      const tailCoords = side < 0 ? [tail, merge] : [merge, tail];
      const tailTrack = makeTrack(tailCoords, trackClass.trackType, "yard", true, elevation);
      tailTrack.pvgRole = "turnback";
      tailTrack.pvgConflictZone = zone;
      tracks.push(tailTrack);
      for (const lead of leads) {
        groups.push(makeGroup([lead], lead.coords, trackClass.trackType, "scissors-crossover", {
          pvgRole: "turnback-lead",
          pvgConflictZone: zone,
          pvgTurnbackSide: side < 0 ? "west" : "east"
        }));
      }
      groups.push(makeGroup([tailTrack], tailCoords, trackClass.trackType, "yard", {
        yardRole: "turnback",
        pvgRole: "turnback",
        pvgConflictZone: zone,
        pvgTurnbackSide: side < 0 ? "west" : "east"
      }));
    }

    if (options.storageTracks > 0) {
      const storage = [];
      for (let index = 0; index < options.storageTracks; index += 1) {
        const sourceLane = index === 0 ? 0 : template.laneCount - 1;
        const outward = index === 0 ? -spacing * 1.5 : spacing * 1.5;
        const from = pointAt(center, forward, perpendicular, -half - THROAT_LENGTH, offsets[sourceLane]);
        const to = pointAt(center, forward, perpendicular, -half - THROAT_LENGTH - STORAGE_LENGTH, offsets[sourceLane] + outward);
        const track = makeTrack([from, to], trackClass.trackType, "yard", true, elevation);
        track.pvgRole = "storage";
        track.pvgConflictZone = complexId + "-A";
        storage.push(track);
        tracks.push(track);
      }
      const storageCenterOffset = storage.reduce((sum, track) => sum + track.coords[1][0], 0) / storage.length;
      groups.push(makeGroup(storage, [storage[0].coords[0], storage.at(-1).coords[1]], trackClass.trackType, "yard", {
        yardRole: "berth",
        pvgRole: "storage",
        pvgConflictZone: complexId + "-A",
        pvgStorageTracks: options.storageTracks,
        pvgStorageCenterLongitude: storageCenterOffset
      }));
    }

    return {
      id: complexId,
      name: options.name,
      templateId: template.id,
      trackClassId: trackClass.id,
      trackType: trackClass.trackType,
      center,
      bearing,
      length,
      elevation,
      throatMode: options.throatMode,
      turnbackMode: options.turnbackMode,
      storageTracks: options.storageTracks,
      operatingMode: options.operatingMode,
      operationPresetId: options.operationPresetId,
      tracks,
      trackGroups: groups,
      platformTrackCount: stationLaneSet.size,
      bypassTrackCount: bypassLaneSet.size,
      metadata: {
        stationComponents: template.platformGroups.length,
        physicalTrackCount: template.laneCount,
        supportsSamePlatformTransfer: template.platformGroups.some((group) => group.length === 2),
        supportsOvertake: bypassLaneSet.size > 0,
        supportsTurnback: turnbackSides.length > 0,
        turnbackTrackCount: turnbackSides.length,
        supportsStorage: options.storageTracks > 0,
        lanePlan: buildLanePlan(template.id, options.operatingMode)
      }
    };
  }

  function renameAndGroupNewStations(beforeIds, complex) {
    const state = getInternalState();
    if (!state) return;
    const newStations = (state.stations || []).filter((station) => !beforeIds.has(station.id));
    if (!newStations.length) return;
    for (let index = 0; index < newStations.length; index += 1) {
      const suffix = newStations.length > 1 ? " · 站台" + (index + 1) : "";
      if (typeof api.renameStation === "function") api.renameStation(newStations[index].id, complex.name + suffix);
      else if (api.actions && typeof api.actions.renameStation === "function") api.actions.renameStation(newStations[index].id, complex.name + suffix);
    }
    const refreshed = getInternalState();
    const groups = (refreshed?.stationGroups || []).filter((group) =>
      (group.stationIds || []).some((stationId) => newStations.some((station) => station.id === stationId))
    );
    if (groups.length > 0 && typeof refreshed.setStationGroupCustomName === "function") {
      refreshed.setStationGroupCustomName(groups[0].id, complex.name);
    } else if (groups.length > 0 && api.actions && typeof api.actions.renameStationGroup === "function") {
      api.actions.renameStationGroup(groups[0].id, complex.name);
    }
  }

  function placeTemplate(options) {
    if (!isPvg()) return { success: false, error: "本工具只在上海 PVG 地图中启用。" };
    const state = getInternalState();
    if (!state) return { success: false, error: "当前游戏版本未提供多股道所需的安全状态接口。" };
    const complex = createStationTemplate(options || {});
    lastStationName = complex.name;
    const beforeIds = new Set((state.stations || []).map((station) => station.id));
    try {
      state.setTracks({
        newTracks: [...(state.tracks || []), ...complex.tracks],
        newTrackGroups: [...(state.trackGroups || []), ...complex.trackGroups],
        regenStations: true,
        skipHistory: false
      });
      globalThis.setTimeout(() => renameAndGroupNewStations(beforeIds, complex), 0);
      notify(
        complex.name + "蓝图已放置：" + complex.metadata.physicalTrackCount + "股道、" + complex.metadata.stationComponents + "个站台组件。",
        "success"
      );
      return {
        success: true,
        complexId: complex.id,
        trackIds: complex.tracks.map((track) => track.id),
        trackGroupIds: complex.trackGroups.map((group) => group.id),
        complex
      };
    } catch (error) {
      console.error(TAG, error);
      notify(String(error?.message || error), "error");
      return { success: false, error: String(error?.message || error) };
    }
  }

  async function buildBlueprints() {
    if (!api.build || typeof api.build.buildBlueprints !== "function") {
      return { success: false, error: "游戏未提供蓝图建造接口。" };
    }
    const result = await api.build.buildBlueprints();
    notify(
      result?.success ? "多股道蓝图已建成。请在路线编辑器中分配普通、快车和直通进路。" : String(result?.error || "建造失败"),
      result?.success ? "success" : "error"
    );
    return result;
  }

  function buildStopPlan(stationCount, modeId) {
    const count = Math.max(0, Math.floor(Number(stationCount) || 0));
    const mode = OPERATING_MODES.find((item) => item.id === modeId) || OPERATING_MODES[0];
    if (count === 0) return [];
    const indices = [];
    for (let index = 0; index < count; index += mode.stopStep) indices.push(index);
    if (indices.at(-1) !== count - 1) indices.push(count - 1);
    return indices;
  }

  function canThroughRun(trainType, trackType) {
    const compatible = COMPATIBILITY[trainType];
    return Boolean(compatible && compatible.includes(trackType));
  }

  function routeTrackIds(route) {
    return [...new Set((route?.stCombos || []).flatMap((combo) =>
      (combo.path || []).map((item) => item?.trackId).filter(Boolean)
    ))];
  }

  function routeTrackTypes(state, route) {
    const trackById = state ? getPlanningIndex(state).tracks : new Map();
    return [...new Set(routeTrackIds(route).map((id) => trackById.get(id)?.trackType).filter(Boolean))];
  }

  function recommendRouteDesign(state, route) {
    const trackTypes = routeTrackTypes(state, route);
    const compatible = TRACK_CLASSES.filter((item) => trackTypes.every((type) => canThroughRun(item.trackType, type)));
    const saved = TRACK_CLASSES.find((item) => item.id === route?.pvgTrackClassId);
    const current = TRACK_CLASSES.find((item) => item.trackType === route?.trainType);
    const fromTracks = trackTypes.length ? compatible.find((item) => item.trackType === trackTypes[0]) || compatible[0] : null;
    const trackClass = saved && (!trackTypes.length || compatible.includes(saved))
      ? saved : fromTracks || current || TRACK_CLASSES[1];
    const modeId = OPERATING_MODES.some((mode) => mode.id === route?.pvgOperatingMode)
      ? route.pvgOperatingMode : "local";
    return { trackClassId: trackClass.id, modeId, trackTypes, source: saved && trackClass === saved ? "saved" : trackTypes.length ? "tracks" : current ? "train" : "default" };
  }

  function recommendTrainType(modeId, trackTypes) {
    const types = [...new Set((trackTypes || []).filter(Boolean))];
    if (types.includes("pvg-ops-high-speed-300")) return "pvg-ops-high-speed-300";
    if (types.includes("pvg-ops-intercity-200")) return "pvg-ops-intercity-200";
    if (types.includes("pvg-ops-heavy-160")) return "pvg-ops-heavy-160";
    if (types.includes("pvg-ops-medium-120")) return "pvg-ops-medium-120";
    if (["rapid", "express", "through"].includes(modeId)) return "pvg-ops-medium-120";
    return "pvg-ops-light-80";
  }

  const STATION_ROLE_CONFIG = {
    local: { name: "普通站", presetId: "local-through-station", templateId: "two-track-island" },
    overtake: { name: "越行站", presetId: "express-overtake", templateId: "four-track-express-bypass" },
    interchange: { name: "换乘枢纽", presetId: "cross-platform-hub", templateId: "six-track-triple-island" },
    integrated: { name: "综合枢纽", presetId: "integrated-through-hub", templateId: "eight-track-express-bypass" }
  };

  // The planner is indexed by infrastructure, not by simulation ticks. A train
  // moving must never cause every station and every route to be scanned again.
  let planningIndex = null;
  function getPlanningIndex(state) {
    const refs = [state.tracks, state.stations, state.stationGroups, state.routes, state.trackGroups];
    if (planningIndex && refs.every((ref, i) => ref === planningIndex.refs[i])) return planningIndex;
    const index = { refs, tracks: new Map(), trackGroups: new Map(), nodes: new Map(), stations: new Map(), groups: new Map(), usage: new Map(), families: new Map(), plans: new Map() };
    for (const group of state.trackGroups || []) index.trackGroups.set(group.id, group);
    for (const group of state.stationGroups || []) for (const id of group.stationIds || []) index.groups.set(id, group);
    for (const track of state.tracks || []) index.tracks.set(track.id, track);
    for (const station of state.stations || []) {
      index.stations.set(station.id, station);
      for (const id of station.stNodeIds || []) index.nodes.set(id, { station, group: index.groups.get(station.id) || null });
    }
    index.key = (node) => {
      const item = index.nodes.get(node?.id);
      return item?.group ? "group:" + item.group.id : item?.station ? "station:" + item.station.id : "node:" + node?.id;
    };
    const infrastructureFamilies = new Map();
    const routeNames = new Map((state.routes || []).flatMap((route) => [route.fullName, route.name, route.bullet].filter(Boolean).map((name) => [name, route.id])));
    for (const route of state.routes || []) {
      if (route.tempParentId) continue;
      const signature = routeTrackIds(route).sort().join("|") || [...new Set((route.stNodes || []).map(index.key))].sort().join("|");
      const legacyParents = String(route.pvgParentServiceName || "").split(" + ").map((name) => routeNames.get(name)).filter(Boolean);
      const parent = route.pvgParentRouteId ? [route.pvgParentRouteId, route.pvgThroughRouteId].filter(Boolean).sort().join("+") : (legacyParents.length ? legacyParents.sort().join("+") : null);
      if (!infrastructureFamilies.has(signature)) infrastructureFamilies.set(signature, parent || route.id);
      index.families.set(route.id, parent || infrastructureFamilies.get(signature));
    }
    for (const route of state.routes || []) {
      if (route.tempParentId) continue;
      // A new service uses its parents' corridors. Counting every parent at
      // every through-service stop would turn the whole route into false hubs.
      if (route.pvgParentRouteId && index.families.has(route.pvgParentRouteId)) continue;
      for (const key of new Set((route.stNodes || []).map(index.key))) {
        if (!index.usage.has(key)) index.usage.set(key, new Set());
        for (const family of index.families.get(route.id).split("+")) index.usage.get(key).add(family);
      }
    }
    planningIndex = index;
    return index;
  }

  function routeTopology(state, route) {
    const index = getPlanningIndex(state), sequence = route.stNodes || [];
    const keys = sequence.map(index.key), unique = new Map();
    sequence.forEach((node, i) => { if (!unique.has(keys[i])) unique.set(keys[i], { node, key: keys[i], firstIndex: i }); });
    const closed = keys.length > 2 && keys[0] === keys.at(-1);
    const isLoop = closed && keys.slice(0, -1).length === unique.size;
    const terminals = new Set();
    if (!isLoop && keys.length) {
      terminals.add(keys[0]);
      if (!closed) terminals.add(keys.at(-1));
      for (let i = 1; i < keys.length - 1; i++) if (keys[i - 1] === keys[i + 1] && keys[i] !== keys[i - 1]) terminals.add(keys[i]);
      // A directional pair of platforms may produce A,B,C,C',B',A'. The
      // physical index folds C/C' together; detect the turning plateau too.
      const folded = keys.filter((key, i) => !i || key !== keys[i - 1]);
      for (let i = 1; i < folded.length - 1; i++) if (folded[i - 1] === folded[i + 1]) terminals.add(folded[i]);
    }
    return { sequence, keys, unique: [...unique.values()], terminals, isLoop, closed };
  }

  function planRouteStations(routeId, modeId, trackClassId) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === routeId);
    const mode = OPERATING_MODES.find((item) => item.id === modeId), trackClass = TRACK_CLASSES.find((item) => item.id === trackClassId);
    if (!state || !route || !mode || !trackClass) return { success: false, error: "线路、等级或停站方式无效。" };
    if (route.pvgServiceTransaction && Array.isArray(route.pvgStationPlan)) return {
      success: true, routeId, routeName: route.fullName || route.bullet, modeId: route.pvgOperatingMode,
      trackClassId: route.pvgTrackClassId, trainType: route.trainType, stations: route.pvgStationPlan,
      recommendedStops: (route.stNodes || []).map((node, i) => i),
      counts: Object.fromEntries(Object.keys(STATION_ROLE_CONFIG).map((role) => [role, route.pvgStationPlan.filter((station) => station.role === role).length]))
    };
    const index = getPlanningIndex(state), cacheKey = [routeId, modeId, trackClassId].join(":");
    if (index.plans.has(cacheKey)) return index.plans.get(cacheKey);
    const topology = routeTopology(state, route);
    if (topology.unique.length < 2) return { success: false, error: "请先选择至少两座车站。" };
    const stopKeys = new Set(), step = mode.stopStep || 1;
    // Stop selection is physical-station based. Both directions use exactly
    // the same set; remote terminals and transfer anchors are always retained.
    topology.unique.forEach((entry, i) => {
      if (i % step === 0 || topology.terminals.has(entry.key) || (index.usage.get(entry.key)?.size || 0) > 1) stopKeys.add(entry.key);
    });
    if (stopKeys.size < 2) stopKeys.add(topology.unique.at(-1).key);
    let lastPassingIndex = -Infinity;
    const stations = topology.unique.map((entry, i) => {
      const resolved = index.nodes.get(entry.node.id), station = resolved?.station, group = resolved?.group;
      const familyCount = index.usage.get(entry.key)?.size || 1, terminal = topology.terminals.has(entry.key);
      const components = group ? (group.stationIds || []).map((id) => index.stations.get(id)).filter(Boolean) : station ? [station] : [];
      const physicalTracks = new Set(components.flatMap((item) => item.trackIds || []));
      // Native stations often split one physical track into two halves.
      const groups = new Set(components.map((item) => item.trackGroupId).filter(Boolean));
      const existingTracks = groups.size ? [...groups].map((id) => index.trackGroups.get(id)).filter(Boolean).reduce((sum, item) => sum + (item.trackLanesType === "quad" ? 4 : item.trackLanesType === "parallel" ? 2 : 1), 0) : physicalTracks.size;
      const hasBypass = [...physicalTracks].some((id) => index.tracks.get(id)?.pvgRole === "express-bypass");
      const mixedService = step > 1 && (!route.pvgParentRouteId || (state.routes || []).some((item) => item.id !== routeId && index.families.get(item.id) === index.families.get(routeId) && !["rapid", "express"].includes(item.pvgOperatingMode)));
      let role = familyCount >= 4 ? "integrated" : familyCount >= 2 ? "interchange" : "local";
      // Passing places are spaced proposals, never a claim that signals already
      // arrange an overtake. Do not expand every skipped station.
      if (role === "local" && mixedService && !terminal && !stopKeys.has(entry.key) && i - lastPassingIndex >= 4) {
        role = "overtake"; lastPassingIndex = i;
      }
      const count = role === "integrated" ? 8 : role === "interchange" ? (familyCount >= 3 ? 6 : 4) : role === "overtake" ? 4 : 2;
      const templateId = role === "overtake" ? "four-track-express-bypass" : ({ 2: "two-track-island", 4: "four-track-double-island", 6: "six-track-triple-island", 8: "eight-track-four-island" })[count];
      return { index: i, key: entry.key, stNodeId: entry.node.id, stationId: station?.id || null, stationGroupId: group?.id || null,
        name: group?.name || station?.name || "第 " + (i + 1) + " 站", center: entry.node.center || group?.center || station?.coords,
        role, roleName: STATION_ROLE_CONFIG[role].name, presetId: STATION_ROLE_CONFIG[role].presetId, templateId, trackCount: count,
        existingTracks, needsConstruction: existingTracks < count || (role === "overtake" && !hasBypass), hasBypass, stop: stopKeys.has(entry.key), terminal,
        routeCount: familyCount, reasons: [terminal ? "端点必须停靠" : familyCount > 1 ? familyCount + "条独立走廊交汇" : role === "overtake" ? "快慢混跑，建议预留越行条件" : "按需保留双线"] };
    });
    const plan = { success: true, routeId, routeName: route.fullName || route.name || route.bullet || route.id, modeId,
      trackClassId, trainType: trackClass.trackType, isLoop: topology.isLoop, stations,
      recommendedStops: topology.keys.flatMap((key, i) => stopKeys.has(key) ? [i] : []),
      counts: Object.fromEntries(Object.keys(STATION_ROLE_CONFIG).map((role) => [role, stations.filter((item) => item.role === role).length])) };
    if (index.plans.size >= 64) index.plans.delete(index.plans.keys().next().value);
    index.plans.set(cacheKey, plan);
    return plan;
  }

  function previewRouteOperation(routeId, modeId) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === routeId);
    if (!route) return { success: false, error: "找不到线路。" };
    const suggestion = recommendRouteDesign(state, route), plan = planRouteStations(routeId, modeId, suggestion.trackClassId);
    if (!plan.success) return plan;
    const types = routeTrackTypes(state, route), trainType = TRACK_CLASSES.find((item) => item.id === suggestion.trackClassId).trackType;
    return { success: true, routeId, mode: modeId, routeName: plan.routeName, trackTypes: types, recommendedTrainType: trainType,
      compatible: types.every((type) => canThroughRun(trainType, type)), recommendedStops: plan.recommendedStops,
      warnings: [ ...(!routeTrackIds(route).length ? ["线路尚无完整进路。"] : []),
        ...(["rapid", "express"].includes(modeId) ? ["跳站不等于越行；实际通过进路由游戏寻路验证，未建成的越行设施不计入能力。"] : []) ] };
  }

  function throughCandidates(routeId, trainType) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === routeId);
    if (!route) return [];
    const topology = routeTopology(state, route), family = new Set(getPlanningIndex(state).families.get(routeId).split("+"));
    const seenFamilies = new Set();
    return (state.routes || []).filter((item) => item.id !== routeId && !item.tempParentId && !getPlanningIndex(state).families.get(item.id).split("+").some((id) => family.has(id)))
      .flatMap((candidate) => {
        if (!routeTrackTypes(state, candidate).every((type) => canThroughRun(trainType, type))) return [];
        const other = routeTopology(state, candidate), shared = [...topology.terminals].filter((key) => other.terminals.has(key));
        const familyId = getPlanningIndex(state).families.get(candidate.id);
        if (!topology.closed || !other.closed || shared.length !== 1 || seenFamilies.has(familyId)) return [];
        seenFamilies.add(familyId);
        return [{ routeId: candidate.id, name: candidate.fullName || candidate.bullet || candidate.id, joinKey: shared[0] }];
      });
  }

  // A station GROUP is a passenger interchange, not a single bidirectional
  // track. Select the directed platform for each through movement separately.
  // The final route is still validated by the native path finder.
  function resolveThroughPlatforms(state, nodes, joinKey, trainType) {
    const index = getPlanningIndex(state), key = coords => coords.map(n => Number(n).toFixed(7)).join(",");
    const candidates = (state.stNodes || []).filter(n => index.key(n) === joinKey && n.trackIds?.length === 2 &&
      n.trackIds.every(id => index.tracks.get(id)?.buildType === "constructed" && canThroughRun(trainType, index.tracks.get(id)?.trackType)));
    if (candidates.length < 2) return nodes;
    const graph = new Map();
    const add = (a, b, length) => { if (!graph.has(a)) graph.set(a, []); graph.get(a).push({ to: b, length }); };
    for (const t of state.tracks || []) {
      if (t.buildType !== "constructed" || !t.coords?.length || !canThroughRun(trainType, t.trackType)) continue;
      const a = key(t.coords[0]), b = key(t.coords.at(-1));
      add(a, b, t.length);
      // Do not use a platform against its canonical direction to reach a
      // through platform. That recreates the old head-on terminal conflict.
      if (t.reversable && t.type !== "station") add(b, a, t.length);
    }
    const endpoint = (node, end) => {
      const t = index.tracks.get(node?.trackIds?.[end ? 1 : 0]);
      return t?.coords?.length ? key(end ? t.coords.at(-1) : t.coords[0]) : null;
    };
    const distances = (from, limit) => {
      const result = new Map([[from, 0]]), queue = [from];
      for (let cursor = 0; cursor < queue.length && cursor < 50000; cursor++) {
        const id = queue[cursor], d = result.get(id);
        for (const edge of graph.get(id) || []) {
          const next = d + edge.length;
          if (next <= limit && next < (result.get(edge.to) ?? Infinity)) { result.set(edge.to, next); queue.push(edge.to); }
        }
      }
      return result;
    };
    return nodes.map((node, i) => {
      if (index.key(node) !== joinKey) return node;
      const previous = nodes[(i - 1 + nodes.length - 1) % (nodes.length - 1)], next = nodes[(i + 1) % (nodes.length - 1)];
      const from = endpoint(previous, true), to = endpoint(next, false);
      if (!from || !to || !previous?.center || !next?.center) return node;
      const limit = 2 * (metersBetween(previous.center, node.center) + metersBetween(node.center, next.center)) + 1000;
      const inbound = distances(from, limit);
      const scored = candidates.map(candidate => ({ candidate,
        distance: (inbound.get(endpoint(candidate, false)) ?? Infinity) +
          (distances(endpoint(candidate, true), limit).get(to) ?? Infinity) }));
      scored.sort((a, b) => a.distance - b.distance || (a.candidate.id === node.id ? -1 : 1));
      return Number.isFinite(scored[0].distance) ? scored[0].candidate : node;
    });
  }

  function signalTrackIndex(signals) {
    const result = new Map();
    for (const signal of signals || []) {
      if (signal.buildType === "blueprint") continue;
      for (const part of signal.signalTracks || []) {
        if (!result.has(part.trackId)) result.set(part.trackId, []);
        result.get(part.trackId).push({ signalId: signal.id, areaCovered: part.areaCovered });
      }
    }
    return result;
  }

  function routeSignalRepair(state, allowedTrackIds = null) {
    const index = signalTrackIndex(state.signals), issues = [];
    const allowed = allowedTrackIds && new Set(allowedTrackIds);
    let changedParts = 0;
    const signature = refs => JSON.stringify((refs || []).map(r => [r.signalId, r.areaCovered]).sort((a, b) => a[0].localeCompare(b[0])));
    const repairCombo = combo => {
      let changed = false;
      const path = (combo.path || []).map(part => {
        if(allowed && !allowed.has(part.trackId)) return part;
        // Areas are in physical track coordinates, even for reversed paths.
        const expected = index.get(part.trackId) || [];
        if (signature(part.signals) === signature(expected)) return part;
        changed = true; changedParts++;
        return { ...part, signals: expected.map(ref => ({ ...ref })) };
      });
      return changed ? { ...combo, path } : combo;
    };
    const repairAlternates = value => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value.path)) return repairCombo(value);
      const entries = Object.entries(value).map(([k, v]) => [k, repairAlternates(v)]);
      if (entries.every(([k, v]) => v === value[k])) return value;
      return Array.isArray(value) ? entries.map(([, v]) => v) : Object.fromEntries(entries);
    };
    const routes = (state.routes || []).map(route => {
      const before = changedParts, stCombos = (route.stCombos || []).map(repairCombo);
      const terminusPlatformAlternates = repairAlternates(route.terminusPlatformAlternates);
      if (before === changedParts) return route;
      issues.push({ routeId: route.id, name: route.bullet, changedParts: changedParts - before });
      return { ...route, stCombos, ...(terminusPlatformAlternates ? { terminusPlatformAlternates } : {}) };
    });
    const trains = (state.trains || []).map(train => {
      // Native alternate-platform paths are independent of canonical paths.
      const overrides = train.stComboOverrides;
      let stComboOverrides = overrides;
      if (overrides && typeof overrides === "object") {
        const entries = Object.entries(overrides).map(([i, combo]) => [i, combo?.path ? repairCombo(combo) : combo]);
        if (entries.some(([i, combo]) => combo !== overrides[i])) stComboOverrides = Object.fromEntries(entries);
      }
      let changed = stComboOverrides !== overrides;
      const windows = Object.fromEntries(Object.entries(train.windows || {}).map(([name, window]) => {
        if (!Array.isArray(window.tracks)) return [name, window];
        if(allowed && !window.tracks.some(part=>allowed.has(part.trackId)))return [name,window];
        const tracks = window.tracks.map(part => {
          if(allowed && !allowed.has(part.trackId)) return part;
          const triggeredSignalIds = (index.get(part.trackId) || []).filter(ref => ref.areaCovered === "all" ||
            ref.areaCovered?.start <= part.headProgress && ref.areaCovered?.end >= part.tailProgress).map(ref => ref.signalId);
          return { ...part, triggeredSignalIds };
        });
        const signalIds = [...new Set(tracks.flatMap(part => part.triggeredSignalIds || []))];
        if (JSON.stringify(signalIds) === JSON.stringify(window.signalIds) && tracks.every((part, i) =>
          JSON.stringify(part.triggeredSignalIds) === JSON.stringify(window.tracks[i].triggeredSignalIds))) return [name, window];
        changed = true;
        return [name, { ...window, tracks, signalIds }];
      }));
      return changed ? { ...train, windows, ...(overrides ? { stComboOverrides } : {}) } : train;
    });
    return { routes, trains, issues, changedParts };
  }

  // Native setTracks regenerates signal objects globally even for add-only
  // construction. Preserve the old physical resources/occupations and route
  // identities, then update ONLY the vacant connection's path references.
  function setExpansionTracks(payload, affectedTrackIds, requireVacancy = true) {
    const core=globalThis.PVGExpansionCore,state=getInternalState();
    if(!core || !state?.setSignals || !state?.setRoutes || !state?.setTrains)throw Error("安全接轨接口未就绪。");
    if(state.routes.some(r=>r.disruption))throw Error("请先处理已有线路中断；原生施工会重算这些线路，不能保证原车连续运行。");
    if(requireVacancy && !core.vacant(state,affectedTrackIds))throw Error("接轨区仍有列车或已预留进路，请稍后重试；原线继续运行。");
    const oldSignals=state.signals,oldRoutes=state.routes,oldTrains=state.trains;
    const originalSignals=state.setSignals,originalTracks=state.setTracks;
    state.setSignals=function(update){
      const ids=new Set(affectedTrackIds),own=new Set(payload.newTracks.filter(t=>t.pvgExpansionId).map(t=>t.id));
      const connections=update.signals.filter(s=>(s.signalTracks || []).some(p=>own.has(p.trackId)));
      for(const signal of connections)for(const part of signal.signalTracks || [])ids.add(part.trackId);
      if(requireVacancy && !core.vacant(getInternalState(),[...ids]))throw Error("原生接轨信号涉及仍在使用的进路，本次未施工。");
      const built=new Map(payload.newTracks.map(t=>[t.id,t.buildType]));
      const applicable=oldSignals.filter(s=>s.buildType!=="blueprint" || !(s.signalTracks || []).some(p=>own.has(p.trackId)&&built.get(p.trackId)==="constructed"));
      const preserved=core.preserveSignals(applicable,update.signals,payload.newTracks.map(t=>t.id),[...own]);
      // The native setter also uses this same array after setSignals returns.
      // In-place replacement preserves those IDs for its stale-ref guard.
      update.signals.splice(0,update.signals.length,...preserved);
      return originalSignals.call(this,update);
    };
    try {
      originalTracks.call(state,{...payload,regenRoutesWithTrackIDs:[],skipHistory:true});
    } finally {
      const current=getInternalState();
      if(current?.setSignals===state.setSignals)current.setSignals=originalSignals;
      state.setSignals=originalSignals;
    }
    const after=getInternalState();
    const validSignalIds=new Set(after.signals.map(s=>s.id));
    const onlyStaleSignalCleanup=(before,current)=>{
      if(before===current)return true;
      const expected={...before,stCombos:(before.stCombos || []).map(c=>({...c,path:(c.path || []).map(p=>({
        ...p,...(Array.isArray(p.signals)?{signals:p.signals.filter(ref=>validSignalIds.has(ref.signalId))}:{})
      }))}))};
      // Native setTracks strips references to removed resources on undo.
      // Accept exactly that transformation, not a route/path/schedule change.
      return JSON.stringify(expected)===JSON.stringify(current);
    };
    if(after.routes.length!==oldRoutes.length || after.routes.some((r,i)=>!onlyStaleSignalCleanup(oldRoutes[i],r)) ||
      after.trains.length!==oldTrains.length || after.trains.some((t,i)=>t!==oldTrains[i]))throw Error("原生版本未保留原线路/列车，停止后续自动施工并保留诊断。");
    if(requireVacancy) {
      const repaired=routeSignalRepair(after,affectedTrackIds);
      if(repaired.changedParts)after.setRoutes(repaired.routes,false);
      if(repaired.trains.some((t,i)=>t!==after.trains[i]))getInternalState().setTrains(repaired.trains);
    }
    return {success:true,originalTrainsPreserved:true};
  }

  let expansionInFlight=false;
  const expansionPlans=new Map();
  function planStationExpansion(routeId,stNodeId) {
    if(!isPvg())return {success:false,error:"自动接轨仅在上海 PVG 启用。"};
    try {
      const state=getInternalState(),node=state.routes.find(r=>r.id===routeId)?.stNodes.find(n=>n.id===stNodeId);
      const type=node && state.tracks.find(t=>t.id===node.trackIds[0])?.trackType;
      const profile=api.trains.getTrainType(type);
      const plan=globalThis.PVGExpansionCore.planBypass(state,routeId,stNodeId,{minimumRadius:profile?.stats?.minTurnRadius,
        exclusionGeometries:globalThis.PVGExpansionBoundaries?.geometries,id:uid("pvg-expansion")});
      const result={...plan,success:true};
      expansionPlans.set(plan.id,JSON.stringify(result));
      if(expansionPlans.size>20)expansionPlans.delete(expansionPlans.keys().next().value);
      return result;
    } catch(error) {return {success:false,error:String(error?.message || error)};}
  }

  async function buildStationExpansion(plan) {
    if(!isPvg() || !plan?.success || !plan.exclusionVerified || !plan.tracks?.length)return {success:false,error:"请先生成有效接轨方案。"};
    if(expansionPlans.get(plan.id)!==JSON.stringify(plan))return {success:false,error:"接轨方案已被修改或过期，请重新生成。"};
    if(expansionInFlight)return {success:false,error:"已有一项接轨施工正在处理。"};
    const core=globalThis.PVGExpansionCore,state=getInternalState(),owned=new Set(plan.tracks.map(t=>t.id));
    if(!state?.buildBlueprints || !state.setSignals)return {success:false,error:"原生施工接口未就绪。"};
    if(core.networkKey(state)!==plan.baseline)return {success:false,error:"轨道已有改动，请重新预览接轨方案。"};
    // Scope the native quote to owned blueprints during its synchronous
    // preparation only. Restore unrelated drafts before the first await yields.
    // Native collision validation/cost calculation are kept intact.
    const unowned=state.tracks.filter(t=>t.buildType==="blueprint"),unownedIds=new Set(unowned.map(t=>t.id));
    if(state.trackGroups.some(g=>g.trackIds.some(id=>unownedIds.has(id))&&g.trackIds.some(id=>!unownedIds.has(id))))return {success:false,error:"其它草稿与已建轨道共用轨道组，请先完成这份草稿，本次不改动它。"};
    if(!core.vacant(state,plan.affectedTrackIds))return {success:false,pending:true,error:"接轨区正在运行或已有预留，请稍后重试；无需暂停全网。"};
    expansionInFlight=true;let staged=false,committed=false,commitError=null,nativeSetTracks;
    try {
      setExpansionTracks({newTracks:[...state.tracks,...plan.tracks],newTrackGroups:[...state.trackGroups,...plan.trackGroups],regenStations:true},plan.affectedTrackIds);
      staged=true;
      const stagedState=getInternalState(),fingerprint=core.networkKey(stagedState);
      let preservedHistory=stagedState.blueprintHistory;
      nativeSetTracks=stagedState.setTracks;
      const scoped=function(payload) {
        const ownCommit=payload.regenRoutesWithTrackIDs==="every" && plan.tracks.every(t=>payload.newTracks?.some(p=>p.id===t.id&&p.buildType==="constructed"));
        if(!ownCommit)return nativeSetTracks.call(this,payload);
        try {
          const fresh=getInternalState();
          if(core.networkKey(fresh)!==fingerprint)throw Error("等待施工期间轨道已被修改，报价已取消。");
          // The backend received only our blueprints. Restore the untouched
          // player's drafts to its add-only commit array before native events.
          for(const draft of unowned)if(!payload.newTracks.some(t=>t.id===draft.id))payload.newTracks.push(draft);
          const oldIds=new Set(fresh.tracks.filter(t=>!owned.has(t.id)).map(t=>t.id));
          if(payload.newTracks.length!==fresh.tracks.length || payload.newTracks.some(t=>!oldIds.has(t.id)&&!owned.has(t.id)))throw Error("原生施工返回了非本次轨道，已拒绝。");
          const index=new Map(payload.newTracks.map(t=>[t.id,t]));
          if(fresh.tracks.some(t=>!owned.has(t.id)&&core.physicalKey(t)!==core.physicalKey(index.get(t.id))))throw Error("原生施工修改了既有轨道，已拒绝。");
          setExpansionTracks({...payload,newTrackGroups:fresh.trackGroups,regenStations:true},plan.affectedTrackIds);
          preservedHistory=fresh.blueprintHistory;
          committed=true;
        } catch(error) {commitError=error;throw error;}
      };
      stagedState.setTracks=scoped;
      try {
        const fullTracks=stagedState.tracks,fullGroups=stagedState.trackGroups,fullSignals=stagedState.signals;
        let nativeBuild;
        try {
          stagedState.tracks=fullTracks.filter(t=>!unownedIds.has(t.id));
          stagedState.trackGroups=fullGroups.filter(g=>!g.trackIds.some(id=>unownedIds.has(id)));
          stagedState.signals=fullSignals.filter(s=>!(s.signalTracks || []).some(p=>unownedIds.has(p.trackId)));
          nativeBuild=stagedState.buildBlueprints();
        } finally {
          stagedState.tracks=fullTracks;stagedState.trackGroups=fullGroups;stagedState.signals=fullSignals;
        }
        await nativeBuild;
      }
      finally {
        const fresh=getInternalState();if(fresh?.setTracks===scoped)fresh.setTracks=nativeSetTracks;
        stagedState.setTracks=nativeSetTracks;
      }
      const fresh=getInternalState();
      if(committed&&unowned.length&&preservedHistory)fresh.blueprintHistory=preservedHistory;
      if(!committed || !plan.tracks.every(t=>fresh.tracks.some(p=>p.id===t.id&&p.buildType==="constructed")))throw commitError || Error("原生施工未完成；没有把蓝图当成已建成。");
      const receipt={id:plan.id,routeId:plan.routeId,stNodeId:plan.stNodeId,trackIds:[...owned],affectedTrackIds:plan.affectedTrackIds,
        tracksFingerprint:JSON.stringify(fresh.tracks.filter(t=>owned.has(t.id)).map(core.physicalKey).sort()),createdAt:Date.now()};
      const groups=fresh.trackGroups.map(g=>g.pvgExpansionId===plan.id?{...g,pvgExpansionReceipt:receipt}:g);
      // Group metadata only: do not run native setTracks a second time.
      fresh.trackGroups.splice(0,fresh.trackGroups.length,...groups);
      return {success:true,expansionId:plan.id,builtTrackIds:[...owned],originalTrainsPreserved:true,
        message:"通过线已按原生费用施工并接回正线；现有列车位置未重置。仅后续新增服务寻路使用新轨道。"};
    } catch(error) {
      if(getInternalState()?.tracks?.some(t=>owned.has(t.id)&&t.buildType==="constructed"))committed=true;
      if(staged&&!committed) {
        const fresh=getInternalState();
        setExpansionTracks({newTracks:fresh.tracks.filter(t=>!owned.has(t.id)),newTrackGroups:fresh.trackGroups.filter(g=>g.pvgExpansionId!==plan.id),regenStations:true},plan.affectedTrackIds,false);
      }
      return {success:false,partiallyCommitted:committed,error:String(error?.message || error)};
    } finally {expansionInFlight=false;}
  }

  function undoStationExpansion(expansionId) {
    const state=getInternalState(),core=globalThis.PVGExpansionCore;
    const receipt=state?.trackGroups.find(g=>g.pvgExpansionId===expansionId)?.pvgExpansionReceipt;
    if(!isPvg() || !receipt || expansionInFlight)return {success:false,error:"没有可撤销的本次接轨，或施工尚未结束。"};
    const owned=new Set(receipt.trackIds);
    if(state.routes.some(r=>routeTrackIds(r).some(id=>owned.has(id))))return {success:false,error:"新增轨道已有线路使用，请先撤销使用它的新服务。"};
    if(!core.vacant(state,[...receipt.trackIds,...receipt.affectedTrackIds]))return {success:false,error:"接轨区仍有列车或预留，请稍后撤销。"};
    if(JSON.stringify(state.tracks.filter(t=>owned.has(t.id)).map(core.physicalKey).sort())!==receipt.tracksFingerprint)return {success:false,error:"轨道已被手动修改，不能用旧凭据撤销。"};
    try {
      setExpansionTracks({newTracks:state.tracks.filter(t=>!owned.has(t.id)),newTrackGroups:state.trackGroups.filter(g=>g.pvgExpansionId!==expansionId),regenStations:true},receipt.affectedTrackIds);
      return {success:true,message:"仅拆除了本次新增接轨；原线与车辆保留，建设费用不虚构返还。"};
    } catch(error) {return {success:false,error:String(error?.message || error)};}
  }

  function repairSharedSectionSignals() {
    const state = getInternalState();
    if (!state || !Array.isArray(state.signals)) return { success: false, error: "原生信号资料尚未就绪。" };
    if (typeof state.setRoutes !== "function" || typeof state.setTrains !== "function" || typeof state.setSignals !== "function") return { success: false, error: "安全信号同步接口不可用。" };
    const repaired = routeSignalRepair(state), now = state.timeConfig.elapsedSeconds;
    const occupations = new Map();
    for (const train of repaired.trains) for (const id of train.windows?.train?.signalIds || []) {
      if (!occupations.has(id)) occupations.set(id, new Set()); occupations.get(id).add(train.id);
    }
    // Add the real current occupants of newly linked signals. Never clear an
    // occupation/reservation or change train position, timing, speed or demand.
    const signals = state.signals.map(signal => {
      const extra = [...(occupations.get(signal.id) || [])].filter(id => !(signal.status?.occupations || []).some(o => o.trainId === id && o.timeVerified >= now - 1));
      return extra.length ? { ...signal, status: { ...signal.status, occupations: [...(signal.status?.occupations || []), ...extra.map(trainId => ({ trainId, timeVerified: now }))] } } : signal;
    });
    if (repaired.changedParts) state.setRoutes(repaired.routes, false);
    if (repaired.trains.some((train, i) => train !== state.trains[i])) getInternalState().setTrains(repaired.trains);
    if (signals.some((signal, i) => signal !== state.signals[i])) getInternalState().setSignals({ signals });
    return { success: true, changedParts: repaired.changedParts, routes: repaired.issues };
  }

  function snapshotDispatchConflicts(state = getInternalState()) {
    const now = state?.timeConfig?.elapsedSeconds, signals = new Map((state?.signals || []).map(s => [s.id, s]));
    const trains = new Map((state?.trains || []).map(t => [t.id, t])), occupied = new Map(), edges = [];
    for (const t of trains.values()) for (const part of t.windows?.train?.tracks || []) {
      if (!occupied.has(part.trackId)) occupied.set(part.trackId, []);
      occupied.get(part.trackId).push({ trainId: t.id, lo: Math.min(part.headProgress, part.tailProgress), hi: Math.max(part.headProgress, part.tailProgress) });
    }
    const seen = new Set(), add = (t, owner, resource, kind) => {
      if (owner === t.id || !trains.has(owner)) return;
      const key = [t.id, owner, resource].join("|"); if (seen.has(key)) return; seen.add(key);
      edges.push({ trainId: t.id, routeId: t.routeId, waitsFor: owner, ownerRouteId: trains.get(owner).routeId, resource, kind });
    };
    for (const t of trains.values()) {
      if ((t.motion?.speed || 0) > 0.05 || t.currentStComboInfo?.timeAtStop != null) continue;
      for (const w of [t.windows?.warning, t.windows?.warningExtra]) {
        for (const id of w?.signalIds || []) {
          const signal = signals.get(id);
          for (const o of signal?.status?.occupations || []) if (o.timeVerified >= now - 1) add(t, o.trainId, id, "signal-occupied");
          const r = signal?.status?.reservedBy;
          if (r) add(t, r.trainId, id, "signal-reserved");
        }
        for (const p of w?.tracks || []) for (const o of occupied.get(p.trackId) || []) {
          if (o.lo <= Math.max(p.headProgress, p.tailProgress) && o.hi >= Math.min(p.headProgress, p.tailProgress)) add(t, o.trainId, p.trackId, "track-occupied");
        }
      }
    }
    const adjacency = new Map();
    for (const edge of edges) { if (!adjacency.has(edge.trainId)) adjacency.set(edge.trainId, new Set()); adjacency.get(edge.trainId).add(edge.waitsFor); }
    // Strongly connected components identify mutual waits, not every red
    // signal. A snapshot is diagnostic evidence, never permission to release.
    let sequence = 0; const visited = new Map(), low = new Map(), stack = [], onStack = new Set(), cycles = [];
    function visit(id) {
      visited.set(id, sequence); low.set(id, sequence++); stack.push(id); onStack.add(id);
      for (const next of adjacency.get(id) || []) {
        if (!visited.has(next)) { visit(next); low.set(id, Math.min(low.get(id), low.get(next))); }
        else if (onStack.has(next)) low.set(id, Math.min(low.get(id), visited.get(next)));
      }
      if (low.get(id) === visited.get(id)) {
        const component = []; let next;
        do { next = stack.pop(); onStack.delete(next); component.push(next); } while (next !== id);
        if (component.length > 1) cycles.push(component);
      }
    }
    for (const id of adjacency.keys()) if (!visited.has(id)) visit(id);
    return { at: now, edges, cycles };
  }

  function serviceStopSequence(routeId, trackClassId, modeId, throughRouteId) {
    const state = getInternalState(), base = state?.routes?.find((route) => route.id === routeId);
    const plan = planRouteStations(routeId, modeId, trackClassId);
    if (!plan.success) return plan;
    if (base.pvgServiceTransaction) return { success: true, nodes: base.stNodes, plan, throughRouteId: base.pvgThroughRouteId || null };
    const index = getPlanningIndex(state), indices = new Set(plan.recommendedStops);
    let servicePlan = plan;
    let throughJoinKey = null;
    let nodes = (base.stNodes || []).filter((node, i) => indices.has(i));
    if (throughRouteId) {
      const candidate = throughCandidates(routeId, plan.trainType).find((item) => item.routeId === throughRouteId);
      if (!candidate) return { success: false, error: "直通需要唯一共用端点、闭合往返进路及兼容车辆；不能仅因车站相近就直通。" };
      throughJoinKey = candidate.joinKey;
      const partner = state.routes.find((route) => route.id === throughRouteId), otherPlan = planRouteStations(throughRouteId, modeId, trackClassId);
      const otherStops = new Set(otherPlan.recommendedStops), other = partner.stNodes.filter((node, i) => otherStops.has(i));
      const at = nodes.findIndex((node) => index.key(node) === candidate.joinKey), offset = other.findIndex((node) => index.key(node) === candidate.joinKey);
      const cycle = other.slice(0, -1), excursion = [...cycle.slice(offset), ...cycle.slice(0, offset), cycle[offset]];
      nodes = [...nodes.slice(0, at + 1), ...excursion.slice(1), ...nodes.slice(at + 1)];
      nodes = resolveThroughPlatforms(state, nodes, candidate.joinKey, plan.trainType);
      const combined = new Map([...plan.stations, ...otherPlan.stations].map((station) => [station.key, station]));
      const stations = [...combined.values()].map((station, i) => ({ ...station, index: i }));
      servicePlan = { ...plan, stations, counts: Object.fromEntries(Object.keys(STATION_ROLE_CONFIG).map((role) => [role, stations.filter((station) => station.role === role).length])) };
    }
    if (nodes.length < 3 || nodes[0].id !== nodes.at(-1).id) return { success: false, error: "线路必须有闭合的往返或环线进路，不能凭空补一条回程。" };
    return { success: true, nodes, plan: servicePlan, throughRouteId: throughRouteId || null, throughJoinKey };
  }

  function chooseFreeDeparture(state, selected) {
    const nodes = selected.nodes, index = getPlanningIndex(state);
    const occupied = new Set((state.trains || []).flatMap((train) => (train.windows?.train?.tracks || []).map((part) => part.trackId)));
    // A platform reserved by an approaching train is not a free departure
    // point. Native reservations have no age-based expiry: a train waiting
    // at red may keep its reservation across frames. Never clear claims or
    // move the original train to make room. Occupations use fresh records.
    const now=state.timeConfig?.elapsedSeconds,liveIds=new Set((state.trains || []).map(train=>train.id));
    for(const signal of state.signals || []) {
      const claims=[...(signal.status?.occupations || []),signal.status?.reservedBy];
      if(!signal.status?.reservedBy && !claims.some(claim=>claim && liveIds.has(claim.trainId) && claim.timeVerified>=now-1))continue;
      for(const part of signal.signalTracks || [])occupied.add(part.trackId);
    }
    const trackIds = (node) => node.trackIds?.length ? node.trackIds : index.nodes.get(node.id)?.station?.trackIds || [];
    const free = (node) => trackIds(node).length > 0 && trackIds(node).every((id) => !occupied.has(id));
    if (free(nodes[0]) || !trackIds(nodes[0]).some((id) => occupied.has(id))) return { nodes, changed: false };
    const terminals = new Set(selected.plan.stations.filter((station) => station.terminal && station.key !== selected.throughJoinKey).map((station) => station.key));
    const cycle = nodes.slice(0, -1), at = cycle.findIndex((node, i) => i > 0 && terminals.has(index.key(node)) && free(node));
    if (at < 0) return { nodes, changed: false };
    // Rotate an existing closed stop cycle; preserve every directed edge.
    // Only the new service's starting point changes. Native dispatch still
    // validates signals, physical conflicts and the resulting route.
    const rotated = [...cycle.slice(at), ...cycle.slice(0, at)];
    return { nodes: [...rotated, rotated[0]], changed: true,
      name: selected.plan.stations.find((station) => station.key === index.key(rotated[0]))?.name || "另一端点" };
  }

  function fleetAdvice(routeId, trainType, options = {}) {
    const state = getInternalState(), route = options.route || state?.routes?.find((item) => item.id === routeId);
    const profile = TRAIN_PROFILES.find((item) => item.id === trainType);
    if (!route || !profile) return { success: false, error: "缺少线路或车辆资料。" };
    const index = getPlanningIndex(state), nodes = options.nodes || route.stNodes || [];
    let platformCars = profile.maxCars;
    for (const node of nodes) {
      const station = index.nodes.get(node.id)?.station;
      const lengths = (node.trackIds || station?.trackIds || []).map((id) => index.tracks.get(id)).filter(Boolean);
      // maxCars is a native, already validated bound. Do not infer one platform's
      // length by summing separate parallel lanes.
      if (Number.isFinite(station?.maxCars)) platformCars = Math.min(platformCars, station.maxCars);
      if (lengths.length && (node.trackIds?.length === 2 || !station?.maxCars)) {
        const halves = lengths.map((track) => Number(track.length)).filter((length) => length > 0);
        if (halves.length) platformCars = Math.min(platformCars, Math.floor(Math.min(...halves) * 2 / profile.carLength));
      }
    }
    platformCars = Math.floor(platformCars / profile.carsPerCarSet) * profile.carsPerCarSet;
    if (platformCars < profile.minCars) return { success: false, error: "最短站台容不下该车型的最小编组，请先延长站台或选择较短车型。" };
    const cars = Math.max(profile.minCars, Math.min(platformCars, Math.floor((Number(options.cars) || route.carsPerTrain || profile.minCars) / profile.carsPerCarSet) * profile.carsPerCarSet));
    const timings = route.stComboTimings || [], nativeSeconds = Number(timings.at(-1)?.arrivalTime) - Number(timings[0]?.arrivalTime);
    const distance = (route.stCombos || []).reduce((sum, combo) => sum + (Number(combo.distance) || 0), 0);
    const cycleSeconds = nativeSeconds > 0 ? nativeSeconds : distance / (profile.speedKph / 3.6 * 0.55) + nodes.length * profile.stopTimeSeconds + profile.turnaroundTimeSeconds * 2;
    const headwayMinutes = Math.max(3, Math.min(30, Number(options.headwayMinutes) || (["intercity", "high-speed"].some((name) => trainType.includes(name)) ? 10 : 6)));
    const recommendedTrains = Math.max(1, Math.ceil(cycleSeconds * 1.1 / (headwayMinutes * 60)));
    const routeById = new Map((state.routes || []).map((item) => [item.id, item]));
    const runningCounts = new Map();
    for (const train of state.trains || []) {
      const owner = routeById.get(train.routeId)?.tempParentId || train.routeId;
      runningCounts.set(owner, (runningCounts.get(owner) || 0) + 1);
    }
    const reservedCars = (state.routes || []).filter((item) => item.id !== options.excludeRouteId && !item.tempParentId && item.trainType === trainType).reduce((sum, item) => {
      const running = runningCounts.get(item.id) || 0;
      return sum + Math.max(running, Number(item.idealTrainCount) || 0, ...Object.values(item.trainSchedule || {}).filter(Number.isFinite)) * (item.carsPerTrain || profile.minCars);
    }, 0);
    const availableCars = Math.max(0, (Number(state.ownedCarsByType?.[trainType]) || 0) - reservedCars);
    const shortageCars = Math.max(0, recommendedTrains * cars - availableCars);
    return { success: true, carsPerTrain: cars, platformMaxCars: platformCars, cycleSeconds, timingSource: nativeSeconds > 0 ? "native" : "estimate", headwayMinutes,
      recommendedTrains, availableCars, shortageCars, purchaseCost: shortageCars * profile.carCost,
      affordableTrains: Math.min(recommendedTrains, Math.floor(availableCars / cars)),
      capacityPerTrain: cars * profile.capacityPerCar,
      hourlyOperatingCost: recommendedTrains * (profile.trainOperationalCostPerHour + cars * profile.carOperationalCostPerHour),
      demandSource: "按目标间隔估算；不是实测客流预测" };
  }

  // Keep the native editor's automatic pause from becoming a global stop.
  // Preserve explicit user pause changes, including changes made mid-edit.
  function installNonstopPlanning() {
    const state = getInternalState();
    if (!state?.setPreviewRoute || !state.setTimeConfig) return { success: false, error: "运行状态接口尚未就绪。" };
    if (state.setPreviewRoute.pvgNonstop) return { success: true };
    const original = state.setPreviewRoute;
    const wrapped = function (preview) {
      const before = getInternalState(), paused = before?.timeConfig?.paused;
      const result = original.call(this, preview);
      if (isPvg() && typeof paused === "boolean" && getInternalState()?.timeConfig?.paused !== paused) getInternalState().setTimeConfig({ paused });
      return result;
    };
    wrapped.pvgNonstop = true;
    state.setPreviewRoute = wrapped;
    return { success: true };
  }

  let dispatchRuntime = null;
  function dynamicOvertakeStatus() {
    if (!dispatchRuntime) return { enabled: false, nativeSteps: 0, holdsStarted: 0 };
    const { enabled, nativeSteps, holdsStarted, peakDecisionMs, lastDecisionMs, lastError, events, memory, platformEgressSteps } = dispatchRuntime;
    return { enabled, nativeSteps, holdsStarted, peakDecisionMs, lastDecisionMs, lastError,platformEgressSteps,
      activeHolds: memory.holds.length, throatGrants: dispatchRuntime.throats?.grants?.length || 0,
      throatWaits: dispatchRuntime.throats?.holds?.length || 0, diagnostics: memory.diagnostics, events: events.slice(-30) };
  }

  function installDynamicOvertaking(options = {}) {
    const state = getInternalState(), core = globalThis.PVGDispatchCore;
    if (options.enabled === false) {
      if (dispatchRuntime?.wrapped && state?.handleIncrementGameState === dispatchRuntime.wrapped) state.handleIncrementGameState = dispatchRuntime.original;
      if (dispatchRuntime) dispatchRuntime.enabled = false;
      return { success: true, enabled: false };
    }
    if (!core || !isPvg() || typeof state?.handleIncrementGameState !== "function" || !api.stations?.getStationTypes || !api.trains?.getTrainTypes) {
      return { success: false, error: "原生逐步调度接口尚未就绪。" };
    }
    if (dispatchRuntime?.enabled && state.handleIncrementGameState === dispatchRuntime.wrapped) return { success: true, enabled: true };
    const runtime = { enabled: true, original: state.handleIncrementGameState, memory: { holds: [], completedStops: [] },
      nativeSteps: 0, holdsStarted: 0, platformEgressSteps:0, peakDecisionMs: 0, lastDecisionMs: 0,
      lastTime: state.timeConfig.elapsedSeconds,networkTracks:state.tracks, events: [] };
    runtime.wrapped = function (...args) {
      const before = getInternalState();
      if (!runtime.enabled || !isPvg() || before?.timeConfig?.paused) return runtime.original.apply(this,args);
      const now = before.timeConfig.elapsedSeconds;
      if (now < runtime.lastTime || before.tracks!==runtime.networkTracks) {
        runtime.memory = { holds: [], completedStops: [] }; runtime.throats = {};runtime.networkTracks=before.tracks;
      }
      const start = globalThis.performance?.now?.() ?? Date.now();
      let called = false;
      try {
      const decision = core.planDispatch(before,runtime.memory,runtime.throats,options);
      const plan = decision.overtaking;
      runtime.throats = decision.throats;
      const combined={holds:[...plan.holds,...(runtime.throats?.holds || [])]};
      runtime.lastDecisionMs = (globalThis.performance?.now?.() ?? Date.now())-start;
      runtime.peakDecisionMs = Math.max(runtime.peakDecisionMs,runtime.lastDecisionMs);
      runtime.memory = plan;
      runtime.holdsStarted += plan.events.filter(e=>e.type==="hold").length;
      runtime.events.push(...[...plan.events,...(runtime.throats?.events || [])].map(e=>({...e,time:now})));
      runtime.events = runtime.events.slice(-100);
        const nativeStep=()=>core.withLiveNativeDwell(before,combined,api.stations.getStationTypes(),api.trains.getTrainTypes(),()=>{
          called = true; return runtime.original.apply(this,args);
        });
        const result=options.platformEgress===true?core.withLivePlatformEgress(before,nativeStep,()=>runtime.platformEgressSteps++):nativeStep();
        // Current native desktop updates are synchronous even though the
        // method returns a Promise. A future worker build needs a separate
        // adapter: do not silently claim to control its independent registry.
        const after = getInternalState();
        if (!(after.timeConfig.elapsedSeconds > now)) {
          runtime.enabled = false; runtime.lastError = "原生仿真接口改为异步或没有推进，本次自动待避已停用。";
        } else { runtime.nativeSteps++; runtime.lastTime = after.timeConfig.elapsedSeconds; }
        return result;
      } catch (error) {
        runtime.enabled = false; runtime.lastError = String(error?.message || error);
        console.error(TAG + " dynamic overtaking adapter disabled",error);
        // Setup errors may return to the intact native method. Never run a
        // native step twice when its own execution has already started.
        if (!called) return runtime.original.apply(this,args);
        throw error;
      }
    };
    dispatchRuntime = runtime;
    state.handleIncrementGameState = runtime.wrapped;
    return { success: true, enabled: true };
  }

  function serviceFingerprint(route) {
    return JSON.stringify([route.trainType, route.carsPerTrain, (route.stNodes || []).map((node) => node.id), routeTrackIds(route), route.trainSchedule, route.idealTrainCount]);
  }

  function retryServiceDeparture(routeId) {
    const state=getInternalState(),route=state?.routes?.find(r=>r.id===routeId),receipt=route?.pvgServiceTransaction;
    if(!route?.pvgPendingDeparture || !receipt || receipt.id!==routeId || receipt.parentRouteId!==route.pvgParentRouteId || !state.routes.some(r=>r.id===receipt.parentRouteId))return {success:false,error:"没有可安全管理的待发新服务。"};
    const loading=Array.isArray(state.loadingState)?state.loadingState.some(item=>item.status==="loading"):state.loadingState?.status==="loading";
    const blockedBy=loading?"loading":state.timeConfig?.paused?"paused":state.previewRoute?"native-editor":state.pendingStNodeChanges?.length?"pending-nodes":state.processingStNodeChanges?.length?"processing-nodes":null;
    if(blockedBy)return {success:true,pending:true,changed:false,blockedBy};
    // Ownership and the complete current route fingerprint prevent a saved
    // pending flag from rewriting a player-edited or foreign route.
    if(receipt.baseline!==serviceFingerprint(route))return {success:false,error:"服务已另行修改，停止自动选择发车端点。"};
    const ids=new Set([routeId,...state.routes.filter(r=>r.tempParentId===routeId).map(r=>r.id)]);
    if(state.trains.some(t=>ids.has(t.routeId))) {
      state.setRoutes(state.routes.map(r=>r.id===routeId?{...r,pvgPendingDeparture:false}:r),false);
      return {success:true,pending:false,changed:false};
    }
    if(!Object.values(route.trainSchedule || {}).some(n=>Number.isFinite(n) && n>0)) {
      state.setRoutes(state.routes.map(r=>r.id===routeId?{...r,pvgPendingDeparture:false}:r),false);
      return {success:true,pending:false,changed:false};
    }
    if(!Array.isArray(route.pvgStationPlan) || typeof state.setPreviewRoute!=="function" || typeof state.confirmRouteChange!=="function")return {success:false,error:"待发服务缺少安全规划信息。"};
    if(route.stNodes?.length<3 || route.stNodes[0].id!==route.stNodes.at(-1).id)return {success:false,error:"待发服务没有完整闭合往返进路。"};
    const departure=chooseFreeDeparture(state,{nodes:route.stNodes,plan:{stations:route.pvgStationPlan},throughJoinKey:route.pvgThroughJoinKey});
    if(!departure.changed)return {success:true,pending:true,changed:false};
    // No train in this service exists, so rotating its CLOSED native stop
    // cycle cannot relocate a vehicle. Original routes remain untouched.
    installNonstopPlanning();
    state.setPreviewRoute({...route,stNodes:departure.nodes});
    let answer;
    try {answer=getInternalState().confirmRouteChange({clampSchedule:true});}
    catch(error) {
      if(getInternalState().previewRoute?.id===routeId)getInternalState().setPreviewRoute(null);
      throw error;
    }
    if(!answer?.success) {
      if(getInternalState().previewRoute?.id===routeId)getInternalState().setPreviewRoute(null);
      return {success:false,error:"原生发车端点复核失败。"};
    }
    const current=getInternalState(),applied=current.routes.find(r=>r.id===routeId);
    if(!applied || applied.disruption || applied.stNodes.map(n=>n.id).join("|")!==departure.nodes.map(n=>n.id).join("|"))return {success:false,error:"原生进路未按闭合停站序列完成。"};
    const updated={...applied,pvgServiceTransaction:{...receipt,baseline:serviceFingerprint(applied)}};
    current.setRoutes(current.routes.map(r=>r.id===routeId?updated:r),false);
    return {success:true,pending:true,changed:true,name:departure.name};
  }

  const pendingDepartureRuntime={checks:0,services:0,lastChecks:[]};
  function pendingDepartureStatus() {
    return {installed:Boolean(window.__PVG_PENDING_DEPARTURE_WATCH__),checks:pendingDepartureRuntime.checks,
      services:pendingDepartureRuntime.services,lastChecks:pendingDepartureRuntime.lastChecks.slice(-8)};
  }
  function installPendingDepartureWatcher() {
    if(!window.document || typeof window.setInterval!=="function" || window.__PVG_PENDING_DEPARTURE_WATCH__)return;
    // Outside native simulation calls: no nested physics tick, registry
    // accessor, global train reset, or changes to another editor's draft.
    window.__PVG_PENDING_DEPARTURE_WATCH__=window.setInterval(()=>{
      const state=getInternalState();
      pendingDepartureRuntime.checks++;
      if(!isPvg() || !state?.routes)return;
      for(const route of state.routes.filter(r=>r.pvgPendingDeparture && r.pvgServiceTransaction)) {
        try {
          const result=retryServiceDeparture(route.id);
          pendingDepartureRuntime.services++;
          pendingDepartureRuntime.lastChecks.push({routeId:route.id,time:state.timeConfig?.elapsedSeconds,...result});
          pendingDepartureRuntime.lastChecks=pendingDepartureRuntime.lastChecks.slice(-8);
          if(!result.success) {
            const current=getInternalState();
            current.setRoutes(current.routes.map(r=>r.id===route.id?{...r,pvgPendingDeparture:false}:r),false);
            console.warn(TAG+" pending departure stopped: "+result.error);
          }
        }catch(error){
          const current=getInternalState();
          current.setRoutes(current.routes.map(r=>r.id===route.id?{...r,pvgPendingDeparture:false}:r),false);
          console.warn(TAG+" pending departure stopped after native error",error);
        }
      }
    },1000);
  }

  const AUTO_STATION_TYPES = { local: "pvg-ops-local-station", overtake: "pvg-ops-overtake-station", interchange: "pvg-ops-express-hub", integrated: "pvg-ops-through-hub" };
  function strongestStationType(owners, baseType) {
    const ranks = ["local", "overtake", "interchange", "integrated"];
    const baseRole = Object.keys(AUTO_STATION_TYPES).find((role) => AUTO_STATION_TYPES[role] === baseType);
    const rank = Math.max(baseRole ? ranks.indexOf(baseRole) : 0, ...Object.values(owners).map((role) => ranks.indexOf(role)));
    return AUTO_STATION_TYPES[ranks[rank]];
  }

  function updateAutomaticStationRoles(serviceId, plan, remove = false) {
    const state = getInternalState();
    if (typeof state?.setStations !== "function") return { applied: 0, pending: plan?.stations?.length || 0 };
    const index = getPlanningIndex(state), desired = new Map();
    for (const item of plan?.stations || []) {
      if (item.needsConstruction || (item.role === "overtake" && !item.hasBypass)) continue;
      const resolved = index.nodes.get(item.stNodeId);
      for (const id of resolved?.group?.stationIds || (resolved?.station ? [resolved.station.id] : [])) desired.set(id, item.role);
    }
    let applied = 0;
    const updated = state.stations.map((station) => {
      const record = station.pvgAutomaticRole;
      if (remove && !record?.owners?.[serviceId]) return station;
      if (!remove && !desired.has(station.id)) return station;
      // Respect a user/manual or another mod's station type. These claims only
      // manage native defaults and types owned by this mod, never other mods.
      if (!record && station.stationType && !["standard", "default", "normal", ...Object.values(AUTO_STATION_TYPES)].includes(station.stationType)) return station;
      const baseType = record ? record.baseType : station.stationType ?? null;
      const baseHadType = record ? record.baseHadType ?? record.baseType !== null : Object.prototype.hasOwnProperty.call(station, "stationType");
      const owners = { ...(record?.owners || {}) };
      if (remove) delete owners[serviceId]; else owners[serviceId] = desired.get(station.id);
      const previousExpected = record ? strongestStationType(record.owners, baseType) : station.stationType;
      const externallyChanged = record && station.stationType !== previousExpected;
      if (externallyChanged) {
        if (!remove) return station;
        // Undo must retain the player's replacement type, but must not leave
        // ownership behind for a service that no longer exists.
        applied++;
        const result = { ...station };
        if (Object.keys(owners).length) result.pvgAutomaticRole = { ...record, owners };
        else delete result.pvgAutomaticRole;
        return result;
      }
      applied++;
      const result = { ...station, stationType: Object.keys(owners).length ? strongestStationType(owners, baseType) : baseType };
      if (Object.keys(owners).length) result.pvgAutomaticRole = { baseType, baseHadType, owners };
      else { delete result.pvgAutomaticRole; if (!baseHadType) delete result.stationType; }
      return result;
    });
    if (applied) state.setStations(updated);
    return { applied, pending: (plan?.stations || []).filter((station) => station.needsConstruction || (station.role === "overtake" && !station.hasBypass)).length };
  }

  function validateServiceSchedule(routeId) {
    const state = getInternalState(), route = state.routes.find((item) => item.id === routeId);
    state.setPreviewRoute(route);
    const result = getInternalState().confirmRouteChange({ clampSchedule: true });
    if (!result?.success) {
      if (getInternalState().previewRoute?.id === routeId) getInternalState().setPreviewRoute(null);
      throw Error("原生班次容量检查未通过。");
    }
    return getInternalState().routes.find((item) => item.id === routeId);
  }

  function applyRouteDesign(routeId, trackClassId, modeId, options = {}) {
    const state = getInternalState(), base = state?.routes?.find((route) => route.id === routeId);
    if (base?.pvgServiceTransaction) return { success: false, error: "请从原线路创建新方案；已应用的服务可配车或撤销，不能重复叠加跳站。" };
    const selected = serviceStopSequence(routeId, trackClassId, modeId, options.throughRouteId);
    if (!selected.success) return selected;
    if (state.previewRoute || state.pendingStNodeChanges?.length || state.processingStNodeChanges?.length) return { success: false, error: "请先完成或取消正在编辑的原生线路，避免覆盖未完成的草稿。" };
    if (!["setPreviewRoute", "confirmRouteChange", "setRoutes", "deleteRoute"].every((key) => typeof state[key] === "function")) return { success: false, error: "此游戏版本缺少安全应用接口，未修改任何线路。" };
    if (!routeTrackTypes(state, base).every((type) => canThroughRun(selected.plan.trainType, type))) return { success: false, error: "所选车辆与已有轨道不兼容。" };
    if (!routeTrackIds(base).length) return { success: false, error: "请先完成基础线路的实际轨道进路。" };
    const departure = chooseFreeDeparture(state, selected);
    selected.nodes = departure.nodes;
    const previewFleet = fleetAdvice(routeId, selected.plan.trainType, { ...options, nodes: selected.nodes });
    if (!previewFleet.success) return previewFleet;
    const requestKey = JSON.stringify([routeId, trackClassId, modeId, options.throughRouteId || null]);
    if (state.routes.some((route) => route.pvgServiceTransaction?.requestKey === requestKey)) return { success: false, error: "这个运营方案已经应用，请先撤销或在原生编辑器调整，避免重复开行。" };
    const createdId = uid("pvg-service"), label = (modeId === "express" ? "急行" : modeId === "rapid" ? "快车" : "普通") + (options.throughRouteId ? "·直通" : "");
    // The base route remains in service. Only this new service is passed to the
    // game's own path finder and schedule validator. Never reset all trains.
    const service = { ...base, id: createdId, bullet: (base.bullet || selected.plan.routeName) + "·" + label,
      fullName: selected.plan.routeName + "·" + label, stNodes: [], stCombos: [], stComboTimings: [],
      trainType: selected.plan.trainType, carsPerTrain: previewFleet.carsPerTrain, idealTrainCount: 0,
      trainSchedule: { highDemand: 0, mediumDemand: 0, lowDemand: 0, veryLowDemand: 0 }, timetableSchedule: undefined,
      disruption: undefined, tempParentId: null, createdAt: Date.now(), pvgParentRouteId: routeId,
      pvgOperatingMode: modeId === "through" ? "local" : modeId, pvgThroughRouteId: options.throughRouteId || null, pvgThroughJoinKey:selected.throughJoinKey,
      pvgTrackClassId: trackClassId, pvgHeadwayMinutes: previewFleet.headwayMinutes, pvgStationPlanVersion: 2, pvgStationPlan: selected.plan.stations,
      pvgServiceTransaction: undefined };
    const untouched = new Map((state.trains || []).map((train) => [train.id, train]));
    try {
      installNonstopPlanning();
      state.setRoutes([...state.routes, service], false);
      getInternalState().setPreviewRoute({ ...service, stNodes: selected.nodes });
      const result = getInternalState().confirmRouteChange({ clampSchedule: true });
      if (!result?.success) throw Error("原生寻路或进路检查未通过，方案没有应用。");
      let current = getInternalState(), applied = current.routes.find((route) => route.id === createdId);
      if (!applied || applied.disruption || applied.stCombos?.length !== selected.nodes.length - 1 || applied.stNodes.map((node) => node.id).join("|") !== selected.nodes.map((node) => node.id).join("|")) throw Error("游戏返回的进路或停站与方案不一致，已取消。");
      if (!(applied.stCombos || []).every((combo) => combo.path?.length && combo.path.every((part) => getPlanningIndex(current).tracks.has(part.trackId)))) throw Error("新服务包含缺失轨道，已取消。");
      if (!routeTrackTypes(current, applied).every((type) => canThroughRun(applied.trainType, type))) throw Error("实际寻路经过不兼容轨道，已取消。");
      const fleet = fleetAdvice(createdId, applied.trainType, { ...options, route: applied, excludeRouteId: createdId });
      if (!fleet.success) throw Error(fleet.error);
      // Reserve only already-owned rolling stock. Buying is a separate explicit
      // action with the real native cost; undo never invents a cash refund.
      const count = fleet.affordableTrains;
      applied = { ...applied, idealTrainCount: count, trainSchedule: { highDemand: count, mediumDemand: count, lowDemand: count, veryLowDemand: count } };
      current.setRoutes(current.routes.map((route) => route.id === createdId ? applied : route), false);
      applied = validateServiceSchedule(createdId);
      applied = { ...applied, pvgPendingDeparture:Object.values(applied.trainSchedule || {}).some(n=>Number.isFinite(n) && n>0), pvgServiceTransaction: { id: createdId, requestKey, createdAt: Date.now(), baseline: serviceFingerprint(applied), parentRouteId: routeId } };
      getInternalState().setRoutes(getInternalState().routes.map((route) => route.id === createdId ? applied : route), false);
      const stationRoles = updateAutomaticStationRoles(createdId, selected.plan);
      current = getInternalState();
      const currentTrainsById = new Map((current.trains || []).map((train) => [train.id, train]));
      const preserved = [...untouched].every(([id, train]) => currentTrainsById.get(id) === train);
      if (!preserved) console.warn(TAG + " native editor changed train references; verify live continuity before release");
      clearPlanPreview();
      return { ...selected.plan, success: true, applied: true, serviceRouteId: createdId, fleet, stationRoles, activeTrains: applied.trainSchedule?.highDemand || 0, originalTrainsPreserved: preserved,
        warnings: ["已新增独立运营服务；原线路不变。", ...(departure.changed ? ["原起点被占用，新服务从空闲端点「" + departure.name + "」开始；原车未移动，仍由原生信号检查放行。"] : []), ...(count === 0 ? ["当前没有闲置的兼容车厢，新服务暂不发车；配车助手可购买并开行。"] : []),
          ...((applied.trainSchedule?.highDemand || 0) < count ? ["共用轨道容量不足，原生检查已将新服务高峰配车限制为 " + (applied.trainSchedule?.highDemand || 0) + " 列；未削减原线班次。"] : []),
          "已自动设置具备条件的车站类型；" + stationRoles.pending + " 座待改造车站未拆建。"] };
    } catch (error) {
      const current = getInternalState();
      updateAutomaticStationRoles(createdId, null, true);
      if (current.previewRoute?.id === createdId) current.setPreviewRoute(null);
      for (const train of current.trains || []) if (train.routeId === createdId) current.deleteTrain?.(train.id);
      if (getInternalState().routes.some((route) => route.id === createdId)) getInternalState().deleteRoute(createdId);
      return { success: false, error: String(error.message || error) };
    }
  }

  function undoRouteDesign(serviceRouteId) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === serviceRouteId), transaction = route?.pvgServiceTransaction;
    if (!transaction) return { success: false, error: "没有可撤销的本工具方案。" };
    if (state.previewRoute) return { success: false, error: "请先退出线路编辑。" };
    if (transaction.baseline !== serviceFingerprint(route)) return { success: false, error: "这条服务已在其他地方修改；为保护后续操作，不能直接撤销。" };
    if (typeof state.deleteTrain !== "function" || typeof state.deleteRoute !== "function") return { success: false, error: "安全撤销接口不可用。" };
    const ownIds = new Set([serviceRouteId, ...state.routes.filter((item) => item.tempParentId === serviceRouteId).map((item) => item.id)]);
    for (const train of state.trains || []) if (ownIds.has(train.routeId)) getInternalState().deleteTrain(train.id);
    getInternalState().deleteRoute(serviceRouteId);
    updateAutomaticStationRoles(serviceRouteId, null, true);
    clearPlanPreview();
    return { success: true, message: "新增服务已撤销，原线路保持运行；购买的车厢保留为库存。" };
  }

  function purchaseServiceFleet(serviceRouteId, quotedCost, options = {}) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === serviceRouteId);
    if (!route?.pvgServiceTransaction || typeof state.buyTrains !== "function") return { success: false, error: "请先应用服务方案。" };
    if (state.previewRoute) return { success: false, error: "请先完成当前线路编辑。" };
    if (route.pvgServiceTransaction.baseline !== serviceFingerprint(route)) return { success: false, error: "服务已被另外修改，请在原生编辑器配车。" };
    const fleet = fleetAdvice(serviceRouteId, route.trainType, { ...options, excludeRouteId: serviceRouteId });
    if (!fleet.success) return fleet;
    if (fleet.purchaseCost !== quotedCost) return { success: false, error: "库存或报价已变化，请刷新配车建议后再确认。" };
    if (fleet.purchaseCost > (Number(state.money) || 0)) return { success: false, error: "资金不足；原有线路不受影响。" };
    const current = getInternalState(), updated = { ...current.routes.find((item) => item.id === serviceRouteId), idealTrainCount: fleet.recommendedTrains,
      trainSchedule: Object.fromEntries(["highDemand", "mediumDemand", "lowDemand", "veryLowDemand"].map((key) => [key, fleet.recommendedTrains])) };
    current.setRoutes(current.routes.map((item) => item.id === serviceRouteId ? updated : item), false);
    let purchasedCars = 0;
    try {
      const validated = validateServiceSchedule(serviceRouteId);
      const allowedCount = Math.min(fleet.recommendedTrains, Math.max(0, ...Object.values(validated.trainSchedule || {}).filter(Number.isFinite)));
      if (!allowedCount) throw Error("共用轨道没有额外班次容量，未购买车厢，也未削减原线班次。");
      const neededCars = Math.max(0, allowedCount * fleet.carsPerTrain - fleet.availableCars);
      if (neededCars > 0) {
        const result = getInternalState().buyTrains(neededCars, route.trainType);
        if (!result?.success) throw Error(result?.message || "购买失败。");
        purchasedCars = neededCars;
      }
      const finalRoute = { ...validated, idealTrainCount: allowedCount, pvgHeadwayMinutes: fleet.headwayMinutes, pvgPendingDeparture:true };
      finalRoute.pvgServiceTransaction = { ...validated.pvgServiceTransaction, baseline: serviceFingerprint(finalRoute) };
      getInternalState().setRoutes(getInternalState().routes.map((item) => item.id === serviceRouteId ? finalRoute : item), false);
      return { success: true, fleet, purchasedCars, allowedCount, message: "已补足 " + purchasedCars + " 节车厢，设置 " + allowedCount + " 列发车计划；实际出库由游戏调度。" };
    } catch (error) {
      getInternalState().setRoutes(getInternalState().routes.map((item) => item.id === serviceRouteId ? route : item), false);
      return { success: false, error: error.message + (purchasedCars ? "已购买车厢仍在库存，未作虚假退款。" : "") };
    }
  }

  const PREVIEW_SOURCE = "pvg-operation-preview";
  function serviceLiveStatus(routeId) {
    const state = getInternalState(), route = state?.routes?.find((item) => item.id === routeId);
    if (!route) return null;
    const routeIds = new Set([routeId, ...(state.routes || []).filter((item) => item.tempParentId === routeId).map((item) => item.id)]);
    const actual = (state.trains || []).filter((train) => routeIds.has(train.routeId)).length;
    const scheduled = Math.max(0, ...Object.values(route.trainSchedule || {}).filter(Number.isFinite));
    return { actual, scheduled, message: route.disruption ? "进路中断，请检查轨道。" : !scheduled ? "尚未配车，或共享轨道没有额外班次容量。" : !actual ? "计划已设定，正在等待原生调度出库；站台、信号或车场可能占用。" : "已有 " + actual + " 列上线；高峰计划 " + scheduled + " 列。" };
  }
  function clearPlanPreview() {
    const map = api.utils?.getMap?.();
    for (const id of [PREVIEW_SOURCE + "-labels", PREVIEW_SOURCE + "-stations", PREVIEW_SOURCE + "-line"]) if (map?.getLayer?.(id)) map.removeLayer(id);
    if (map?.getSource?.(PREVIEW_SOURCE)) map.removeSource(PREVIEW_SOURCE);
  }

  function showPlanPreview(routeId, modeId, trackClassId, throughRouteId) {
    const state = getInternalState(), plan = planRouteStations(routeId, modeId, trackClassId), map = api.utils?.getMap?.();
    if (!plan.success) return plan;
    if (!map?.addSource || !map.addLayer) return { success: false, error: "地图尚未准备好。" };
    const index = getPlanningIndex(state), features = [], ids = new Set();
    const plans = [plan];
    if (throughRouteId && !state.routes.find((route) => route.id === routeId)?.pvgServiceTransaction) {
      const other = planRouteStations(throughRouteId, modeId, trackClassId);
      if (!other.success) return other;
      plans.push(other);
    }
    for (const item of plans) {
      const route = state.routes.find((candidate) => candidate.id === item.routeId);
      for (const id of routeTrackIds(route)) {
        if (ids.has(id)) continue;
        ids.add(id); const track = index.tracks.get(id);
        if (track?.coords?.length > 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: track.coords }, properties: { kind: "track" } });
      }
      for (const station of item.stations) if (Array.isArray(station.center)) features.push({ type: "Feature", geometry: { type: "Point", coordinates: station.center }, properties: { kind: "station", name: station.name, stop: station.stop, role: station.roleName } });
    }
    const data = { type: "FeatureCollection", features };
    if (map.getSource?.(PREVIEW_SOURCE)) map.getSource(PREVIEW_SOURCE).setData(data);
    else {
      map.addSource(PREVIEW_SOURCE, { type: "geojson", data });
      map.addLayer({ id: PREVIEW_SOURCE + "-line", type: "line", source: PREVIEW_SOURCE, filter: ["==", ["get", "kind"], "track"], paint: { "line-color": "#087f8c", "line-width": 4, "line-opacity": 0.8 } });
      map.addLayer({ id: PREVIEW_SOURCE + "-stations", type: "circle", source: PREVIEW_SOURCE, filter: ["==", ["get", "kind"], "station"], paint: { "circle-radius": ["case", ["get", "stop"], 6, 3], "circle-color": ["case", ["get", "stop"], "#087f8c", "#ffffff"], "circle-stroke-width": 2, "circle-stroke-color": "#087f8c" } });
      map.addLayer({ id: PREVIEW_SOURCE + "-labels", type: "symbol", source: PREVIEW_SOURCE, filter: ["==", ["get", "kind"], "station"], minzoom: 10, layout: { "text-field": ["get", "name"], "text-size": 12, "text-offset": [0, 1.2] }, paint: { "text-color": "#07555e", "text-halo-color": "#fff", "text-halo-width": 2 } });
    }
    const centers = plans.flatMap((item) => item.stations.map((station) => station.center)).filter(Array.isArray);
    if (centers.length) map.fitBounds?.([[Math.min(...centers.map((p) => p[0])), Math.min(...centers.map((p) => p[1]))], [Math.max(...centers.map((p) => p[0])), Math.max(...centers.map((p) => p[1]))]], { padding: 80, duration: 450, maxZoom: 13 });
    return { success: true, featureCount: features.length };
  }

  function evaluatePathConflict(pathA, pathB, tracksInput) {
    const tracks = Array.isArray(tracksInput) ? tracksInput : getInternalState()?.tracks || [];
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const idsA = new Set((pathA || []).map((item) => typeof item === "string" ? item : item.trackId).filter(Boolean));
    const idsB = new Set((pathB || []).map((item) => typeof item === "string" ? item : item.trackId).filter(Boolean));
    const sharedTrackIds = [...idsA].filter((trackId) => idsB.has(trackId));
    const zonesFor = id => [...(trackById.get(id)?.pvgConflictZones || []), trackById.get(id)?.pvgConflictZone].filter(Boolean);
    const zonesA = new Set([...idsA].flatMap(zonesFor));
    const zonesB = new Set([...idsB].flatMap(zonesFor));
    const sharedConflictZones = [...zonesA].filter((zone) => zonesB.has(zone));
    const storageConflict = [...idsA].some((trackId) => trackById.get(trackId)?.pvgRole === "storage")
      !== [...idsB].some((trackId) => trackById.get(trackId)?.pvgRole === "storage");
    const directionFor = (path, trackId) => {
      const item = (path || []).find((entry) => typeof entry !== "string" && entry?.trackId === trackId);
      if (!item) return null;
      if (typeof item.reverse === "boolean") return item.reverse ? -1 : 1;
      if (typeof item.reversed === "boolean") return item.reversed ? -1 : 1;
      if (item.direction === -1 || item.direction === "reverse") return -1;
      if (item.direction === 1 || item.direction === "forward") return 1;
      return null;
    };
    const oppositeDirectionTrackIds = sharedTrackIds.filter((trackId) => {
      if (trackById.get(trackId)?.reversable !== true) return false;
      const directionA = directionFor(pathA, trackId);
      const directionB = directionFor(pathB, trackId);
      return directionA !== null && directionB !== null && directionA !== directionB;
    });
    const sharedPlatformTrackIds = sharedTrackIds.filter((trackId) => trackById.get(trackId)?.pvgRole === "platform");
    return {
      conflict: sharedTrackIds.length > 0 || sharedConflictZones.length > 0,
      sharedTrackIds,
      sharedConflictZones,
      oppositeDirectionTrackIds,
      sharedPlatformTrackIds,
      storageConflict,
      rules: [
        ...(sharedTrackIds.length ? ["shared-track"] : []),
        ...(sharedConflictZones.length ? ["same-throat-zone"] : []),
        ...(oppositeDirectionTrackIds.length ? ["reversible-opposite-direction"] : []),
        ...(storageConflict && sharedConflictZones.length ? ["storage-mainline-move"] : []),
        ...(sharedPlatformTrackIds.length ? ["platform-occupancy"] : [])
      ]
    };
  }

  function setRouteOperatingMode(routeId, modeId) {
    const state = getInternalState();
    const mode = OPERATING_MODES.find((item) => item.id === modeId);
    if (!state || !mode) return { success: false, error: "找不到线路或运行模式。" };
    const route = (state.routes || []).find((item) => item.id === routeId);
    if (!route) return { success: false, error: "找不到线路。" };
    const plan = previewRouteOperation(routeId, modeId);
    if (!plan.success) return plan;
    const routes = state.routes.map((item) => item.id === routeId ? {
      ...item,
      pvgOperatingMode: mode.id,
      pvgRecommendedStops: plan.recommendedStops,
      pvgPreferredTrainType: plan.recommendedTrainType,
      pvgOperationWarnings: plan.warnings
    } : item);
    state.setRoutes?.(routes, false);
    return {
      success: true,
      routeId,
      mode: mode.id,
      recommendedStops: plan.recommendedStops,
      recommendedTrainType: plan.recommendedTrainType,
      compatible: plan.compatible,
      warnings: plan.warnings,
      note: "已记录运行模式、车辆建议和建议停站。实际停站和进路仍由游戏路线编辑器控制。"
    };
  }

  function auditNetwork() {
    const state = getInternalState();
    if (!state) return { ok: false, errors: ["内部状态接口不可用"], warnings: [], counts: {} };
    const errors = [];
    const warnings = [];
    const tracks = state.tracks || [];
    const groups = state.trackGroups || [];
    const routes = state.routes || [];
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const customComplexGroups = groups.filter((group) => group.pvgComplexId);
    const complexes = new Map();

    for (const group of customComplexGroups) {
      const record = complexes.get(group.pvgComplexId) || { groupIds: [], trackIds: new Set(), platformComponents: 0 };
      record.groupIds.push(group.id);
      record.platformComponents += group.type === "station" ? 1 : 0;
      for (const trackId of group.trackIds || []) record.trackIds.add(trackId);
      complexes.set(group.pvgComplexId, record);
    }

    const conflictUse = new Map();
    for (const route of routes) {
      const compatible = COMPATIBILITY[route.trainType];
      const routeTrackIds = new Set();
      for (const combo of route.stCombos || []) {
        for (const pathItem of combo.path || []) routeTrackIds.add(pathItem.trackId);
      }
      if (compatible) {
        for (const trackId of routeTrackIds) {
          const trackType = trackById.get(trackId)?.trackType;
          if (trackType && !compatible.includes(trackType)) {
            errors.push((route.bullet || route.id) + " 使用不兼容轨道：" + route.trainType + " → " + trackType);
          }
        }
      }
      for (const trackId of routeTrackIds) {
        const track = trackById.get(trackId);
        if (!track?.pvgConflictZone) continue;
        const users = conflictUse.get(track.pvgConflictZone) || new Set();
        users.add(route.id);
        conflictUse.set(track.pvgConflictZone, users);
      }
      if (["rapid", "express"].includes(route.pvgOperatingMode) && !routeTrackIds.size) {
        warnings.push((route.bullet || route.id) + " 已标记快车但没有完整进路。 ");
      }
      if (route.pvgOperatingMode && !OPERATING_MODES.some((mode) => mode.id === route.pvgOperatingMode)) {
        errors.push((route.bullet || route.id) + " 使用未知运行模式：" + route.pvgOperatingMode);
      }
      if (["rapid", "express"].includes(route.pvgOperatingMode)
          && routeTrackIds.size
          && ![...routeTrackIds].some((trackId) => trackById.get(trackId)?.pvgRole === "express-bypass")) {
        warnings.push((route.bullet || route.id) + " 没有使用无站台通过线，无法在本站组织越行。 ");
      }
    }

    for (const [zone, routeIds] of conflictUse) {
      if (routeIds.size > 1) warnings.push(zone + " 有 " + routeIds.size + " 条线路共用渡线，需错开进路。 ");
    }
    for (const [complexId, record] of complexes) {
      if (![1, 2, 3, 4].includes(record.platformComponents)) {
        errors.push(complexId + " 的站台组件数无效：" + record.platformComponents);
      }
    }
    for (const group of groups.filter((item) => item.type === "station" && item.trackLanesType === "single")) {
      const hasFixedDirection = Object.hasOwn(group, "direction") || Object.hasOwn(group, "laneDirection") || Object.hasOwn(group, "lanes");
      if (hasFixedDirection || group.pvgDirectionPolicy !== "bidirectional") {
        errors.push(group.id + " 的单股道车站错误设置了固定方向。");
      }
      for (const trackId of group.trackIds || []) {
        if (trackById.get(trackId)?.reversable !== true) errors.push(group.id + " 的单股道站线不是双向可用。");
      }
    }

    const storageTracks = tracks.filter((track) => track.pvgRole === "storage");
    const turnbackTracks = tracks.filter((track) => track.pvgRole === "turnback");
    const turnbackLeads = tracks.filter((track) => track.pvgRole === "turnback-lead");
    const bypassTracks = tracks.filter((track) => track.pvgRole === "express-bypass");
    const crossovers = tracks.filter((track) => track.pvgRole === "crossover");
    const result = {
      ok: errors.length === 0,
      errors,
      warnings,
      counts: {
        stationComplexes: complexes.size,
        platformComponents: customComplexGroups.length,
        bypassTracks: bypassTracks.length,
        crossovers: crossovers.length,
        turnbackTracks: turnbackTracks.length,
        turnbackLeads: turnbackLeads.length,
        storageTracks: storageTracks.length,
        routes: routes.length
      },
      compatibility: COMPATIBILITY
    };
    globalThis.__PVG_OPERATIONS_LAST_AUDIT__ = result;
    return result;
  }

  function registerStationTypes() {
    if (!api.stations || typeof api.stations.registerStationType !== "function") return 0;
    const definitions = [
      {
        id: "pvg-ops-local-station",
        name: "普通站",
        description: "普通站站停车站。",
        catchmentMultiplier: 1,
        transferRadiusMultiplier: 1,
        walkSpeedMultiplier: 1,
        extraDwellTime: 0,
        icon: "MapPin",
        color: "#009944"
      },
      {
        id: "pvg-ops-overtake-station",
        name: "越行站",
        description: "已经具备通过线的快慢车车站；停站与进路仍由原生调度执行。",
        catchmentMultiplier: 1,
        transferRadiusMultiplier: 1,
        walkSpeedMultiplier: 1,
        extraDwellTime: 0,
        icon: "Route",
        color: "#E87722"
      },
      {
        id: "pvg-ops-express-hub",
        name: "换乘枢纽",
        description: "支持同台换乘和越行组织的主要车站。",
        catchmentMultiplier: 1.15,
        transferRadiusMultiplier: 2.5,
        walkSpeedMultiplier: 1.15,
        extraDwellTime: 8,
        icon: "Network",
        color: "#0072CE"
      },
      {
        id: "pvg-ops-through-hub",
        name: "综合枢纽",
        description: "跨线、市域和城际直通换乘枢纽。",
        catchmentMultiplier: 1.25,
        transferRadiusMultiplier: 3,
        walkSpeedMultiplier: 1.2,
        extraDwellTime: 12,
        icon: "Route",
        color: "#9C2AA0"
      }
    ];
    for (const definition of definitions) api.stations.registerStationType(definition);
    return definitions.length;
  }

  function registerTrainProfiles() {
    if (!api.trains || typeof api.trains.getTrainType !== "function" || typeof api.trains.registerTrainType !== "function") return 0;
    let registered = 0;
    for (const profile of TRAIN_PROFILES) {
      const base = profile.baseIds.map((id) => api.trains.getTrainType(id)).find(Boolean);
      if (!base || !base.stats) {
        console.warn(TAG + " no base train type for " + profile.id);
        continue;
      }
      const carLength = profile.carLength;
      const stats = {
        ...base.stats,
        maxSpeed: profile.speedKph / 3.6,
        maxSpeedLocalStation: profile.localSpeedKph / 3.6,
        capacityPerCar: profile.capacityPerCar,
        minCars: profile.minCars,
        maxCars: profile.maxCars,
        carsPerCarSet: profile.carsPerCarSet,
        carLength,
        minStationLength: profile.minCars * carLength,
        maxStationLength: profile.maxCars * carLength + 20,
        minTurnRadius: profile.minTurnRadius,
        minStationTurnRadius: profile.minStationTurnRadius,
        maxSlopePercentage: profile.maxSlopePercentage,
        stopTimeSeconds: profile.stopTimeSeconds,
        turnaroundTimeSeconds: profile.turnaroundTimeSeconds,
        tphLimit: profile.tphLimit,
        carCost: profile.carCost,
        baseTrackCost: profile.baseTrackCost,
        baseStationCost: profile.baseStationCost,
        trainOperationalCostPerHour: profile.trainOperationalCostPerHour,
        carOperationalCostPerHour: profile.carOperationalCostPerHour,
        trackMaintenanceCostPerMeter: profile.trackMaintenanceCostPerMeter,
        stationMaintenanceCostPerYear: profile.stationMaintenanceCostPerYear
      };
      api.trains.registerTrainType({
        ...base,
        id: profile.id,
        name: profile.name,
        description: profile.description,
        stats,
        compatibleTrackTypes: [...profile.compatibleTrackTypes],
        appearance: { ...(base.appearance || {}), color: profile.color },
        pvgInfrastructureClass: profile.id.split("-").slice(2, -1).join("-"),
        pvgDesignSpeedKph: profile.speedKph
      });
      registered += 1;
    }
    return registered;
  }

  function registerLegacyTrainAliases() {
    if (!api.trains || typeof api.trains.getTrainType !== "function" || typeof api.trains.registerTrainType !== "function") return 0;
    let registered = 0;
    for (const [legacyId, currentId] of Object.entries(LEGACY_TYPE_MIGRATIONS)) {
      if (legacyId === currentId) continue;
      const target = api.trains.getTrainType(currentId);
      if (!target) continue;
      api.trains.registerTrainType({
        ...target,
        id: legacyId,
        name: "旧存档兼容（载入后自动迁移）",
        description: "仅用于读取旧版上海存档；地图载入后会转换并从选择列表移除。",
        pvgCompatibilityAlias: true,
        pvgMigratesTo: currentId
      });
      registered += 1;
    }
    return registered;
  }

  function removeLegacyTrainAliases() {
    const registry = api.trains?.getTrainTypes?.();
    if (!registry || typeof registry !== "object") return 0;
    let removed = 0;
    for (const [legacyId, currentId] of Object.entries(LEGACY_TYPE_MIGRATIONS)) {
      if (legacyId === currentId || registry[legacyId]?.pvgCompatibilityAlias !== true) continue;
      delete registry[legacyId];
      removed += 1;
    }
    if (removed) console.info(TAG + " removed " + removed + " temporary legacy train aliases from selectors");
    return removed;
  }

  // The native construction picker reads the process-wide train registry and
  // therefore mixes every enabled rolling-stock mod into its "track type"
  // menu. On PVG, expose only this map's five deliberately broad tiers. Keep
  // the removed definitions in memory and restore them when another city is
  // loaded, so this remains a map-scoped presentation rule rather than a
  // permanent change to other mods.
  function restrictPvgTrainCatalog() {
    const registry = api.trains?.getTrainTypes?.();
    if (!registry || typeof registry !== "object" || !isPvg()) {
      return { ok: false, reason: "registry-or-city-unavailable", hidden: 0, visible: 0 };
    }
    const allowed = new Set(TRAIN_PROFILES.map((profile) => profile.id));
    let hidden = 0;
    for (const [id, definition] of Object.entries(registry)) {
      if (allowed.has(id)) continue;
      if (!externalTrainTypeBackup.has(id)) externalTrainTypeBackup.set(id, definition);
      delete registry[id];
      hidden += 1;
    }
    const visible = Object.keys(registry).filter((id) => allowed.has(id)).length;
    const result = { ok: visible === allowed.size, hidden, visible, allowed: [...allowed] };
    globalThis.__PVG_TRAIN_CATALOG__ = { ...result, scopedTo: CITY_CODE, timestamp: Date.now() };
    if (hidden) console.info(TAG + " hid " + hidden + " external train types from the PVG construction picker");
    return result;
  }

  function restoreExternalTrainCatalog() {
    const registry = api.trains?.getTrainTypes?.();
    if (!registry || typeof registry !== "object") return 0;
    let restored = 0;
    for (const [id, definition] of externalTrainTypeBackup.entries()) {
      if (!registry[id]) {
        registry[id] = definition;
        restored += 1;
      }
    }
    externalTrainTypeBackup.clear();
    if (restored) console.info(TAG + " restored " + restored + " external train types outside PVG");
    return restored;
  }

  function OperationsPanel() {
    const React = api.utils.React, h = React.createElement, state = getInternalState();
    const [requestedId, setRequestedId] = React.useState("");
    const [draft, setDraft] = React.useState({});
    const [feedback, setFeedback] = React.useState("");
    const [revision, setRevision] = React.useState(0);
    const routes = (state?.routes || []).filter((route) => !route.tempParentId);
    const route = routes.find((item) => item.id === requestedId) || routes[0], routeId = route?.id || "";
    const managed = Boolean(route?.pvgServiceTransaction), liveStatus = managed ? serviceLiveStatus(routeId) : null;
    const suggested = recommendRouteDesign(state, route), choices = draft.routeId === routeId ? draft : {};
    const classId = choices.trackClassId || suggested.trackClassId, modeId = choices.modeId || (suggested.modeId === "through" ? "local" : suggested.modeId);
    const trackClass = TRACK_CLASSES.find((item) => item.id === classId) || TRACK_CLASSES[1];
    const throughRouteId = managed ? route.pvgThroughRouteId || "" : choices.throughRouteId || "", headwayMinutes = choices.headwayMinutes || route?.pvgHeadwayMinutes || (classId === "intercity" || classId === "high-speed" ? 10 : 6);
    const basePlan = route ? planRouteStations(routeId, modeId, classId) : null;
    const selected = basePlan?.success ? serviceStopSequence(routeId, classId, modeId, throughRouteId) : basePlan;
    const plan = selected?.plan || basePlan;
    const fleet = route ? fleetAdvice(routeId, trackClass.trackType, { nodes: selected?.nodes, headwayMinutes, excludeRouteId: route.pvgServiceTransaction ? routeId : undefined }) : null;
    const candidates = route ? throughCandidates(routeId, trackClass.trackType) : [];
    if (managed && throughRouteId && !candidates.some((item) => item.routeId === throughRouteId)) {
      const partner = routes.find((item) => item.id === throughRouteId);
      candidates.push({ routeId: throughRouteId, name: partner?.fullName || partner?.bullet || "原直通线路" });
    }
    const compatible = routeTrackTypes(state, route).every((type) => canThroughRun(trackClass.trackType, type));
    const muted = { color: "hsl(var(--muted-foreground))", fontSize: "12px", lineHeight: 1.6 };
    const card = { padding: "12px", border: "1px solid hsl(var(--border))", borderRadius: "12px", marginBottom: "10px" };
    const button = { padding: "9px 12px", border: "1px solid hsl(var(--border))", borderRadius: "9px", background: "hsl(var(--background))", color: "hsl(var(--foreground))", cursor: "pointer" };
    const change = (patch) => { if (managed && !Object.hasOwn(patch, "headwayMinutes")) { setFeedback("这是已应用的服务；调整停站请从原线路重新规划，或使用原生编辑器。"); return; } clearPlanPreview(); setDraft({ routeId, trackClassId: classId, modeId, throughRouteId, headwayMinutes, ...patch }); setFeedback(""); };
    const report = (result) => { setFeedback(result.success ? result.message || "已完成。" : result.error); setRevision(revision + 1); };
    React.useEffect?.(() => () => clearPlanPreview(), []);
    React.useEffect?.(() => {
      if (!managed || !window.setInterval) return;
      const handle = window.setInterval(() => setRevision((value) => value + 1), 2000);
      return () => window.clearInterval(handle);
    }, [routeId, managed]);
    return h("div", { style: { padding: "16px", maxHeight: "78vh", overflowY: "auto" } }, [
      h("div", { key: "intro", style: { marginBottom: "14px" } }, [
        h("p", { key: "hint", style: { ...muted, margin: 0 } }, managed ? "已应用的服务 · 可配车、预览或撤销" : "选线路 → 看方案 → 开行。原线路继续运行。")
      ]),
      h("select", { key: "routes", value: routeId, style: { ...button, width: "100%", marginBottom: "12px" }, onChange: (event) => { clearPlanPreview(); setRequestedId(event.target.value); setFeedback(""); } }, routes.length ? routes.map((item) => h("option", { key: item.id, value: item.id }, item.fullName || item.name || item.bullet || item.id)) : h("option", {}, "请先建立基础线路")),
      route ? h("div", { key: "choices", style: card }, [
        h("div", { key: "modes", style: { display: "flex", gap: "6px" } }, [["local", "普通"], ["rapid", "快车"], ["express", "急行"]].map(([id, name]) => h("button", { key: id, type: "button", disabled: managed, "aria-pressed": modeId === id, style: { ...button, flex: 1, fontWeight: 700, cursor: managed ? "default" : "pointer", ...(modeId === id ? { background: "#087f8c", color: "#fff", borderColor: "#087f8c" } : {}) }, onClick: () => change({ modeId: id }) }, name))),
        h("label", { key: "through", style: { display: "block", marginTop: "12px", fontSize: "12px" } }, [
          "跨线直通", h("select", { key: "target", value: throughRouteId, disabled: managed || !candidates.length, style: { ...button, width: "100%", marginTop: "5px" }, onChange: (event) => change({ throughRouteId: event.target.value }) }, [h("option", { key: "none", value: "" }, candidates.length ? "不直通" : "暂无可接续线路"), ...candidates.map((item) => h("option", { key: item.routeId, value: item.routeId }, "接续 " + item.name))])
        ]),
        h("details", { key: "advanced", style: { marginTop: "12px" } }, [
          h("summary", { key: "title", style: { ...muted, cursor: "pointer" } }, "调整速度与发车间隔"),
          h("select", { key: "speed", value: classId, disabled: managed, style: { ...button, width: "100%", marginTop: "8px" }, onChange: (event) => change({ trackClassId: event.target.value, throughRouteId: "" }) }, TRACK_CLASSES.map((item) => h("option", { key: item.id, value: item.id }, item.name))),
          h("label", { key: "headway", style: { ...muted, display: "block", marginTop: "8px" } }, ["目标间隔（分钟） ", h("input", { key: "input", type: "number", min: 3, max: 30, value: headwayMinutes, style: { ...button, width: "72px" }, onChange: (event) => change({ headwayMinutes: Math.max(3, Math.min(30, Number(event.target.value) || 6)) }) })])
        ])
      ]) : null,
      plan?.success ? h("div", { key: "stops", style: card }, [
        h("strong", { key: "count" }, "停 " + plan.stations.filter((item) => item.stop).length + " / " + plan.stations.length + " 站" + (throughRouteId ? " · 叠加直通" : "")),
        h("p", { key: "note", style: { ...muted, margin: "6px 0" } }, Object.entries(plan.counts).filter(([, count]) => count).map(([role, count]) => count + " " + STATION_ROLE_CONFIG[role].name).join(" · ")),
        h("details", { key: "station-details" }, [
          h("summary", { key: "summary", style: { ...muted, cursor: "pointer" } }, "查看逐站停靠与待改造项目"),
          h("div", { key: "list", style: { maxHeight: "190px", overflowY: "auto", marginTop: "6px" } }, plan.stations.map((station) => h("button", { key: station.key, type: "button", style: { ...button, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", border: 0, padding: "6px 2px", fontSize: "12px", textAlign: "left" }, onClick: () => { if (station.center) api.utils?.getMap?.()?.flyTo?.({ center: station.center, zoom: 14, duration: 450 }); } }, [
          h("span", { key: "name" }, (station.stop ? "● " : "○ ") + station.name),
          h("span", { key: "role", style: muted }, station.roleName + (station.needsConstruction ? " · 待改造" : ""))
          ])))
        ]),
        plan.stations.some((station) => station.needsConstruction) ? h("p", { key: "construction", style: { ...muted, marginBottom: 0 } }, plan.stations.filter((station) => station.needsConstruction).length + " 座待改造 · 不自动拆建，不计为已有越行能力。") : null
      ]) : h("p", { key: "no-plan", style: muted }, plan?.error || "在原生编辑器选好沿线车站后，回来规划运营。"),
      fleet?.success ? h("div", { key: "fleet", style: card }, [
        h("strong", { key: "title" }, "配车助手"),
        liveStatus ? h("p", { key: "live", role: "status", style: muted }, liveStatus.message) : null,
        h("p", { key: "summary", style: { margin: "8px 0", fontSize: "14px" } }, fleet.carsPerTrain + " 节 / 列 · 建议 " + fleet.recommendedTrains + " 列 · " + fleet.headwayMinutes + " 分钟间隔"),
        h("div", { key: "inventory", style: muted }, "现有闲置车厢可配 " + fleet.affordableTrains + " 列；补足需 $" + fleet.purchaseCost.toLocaleString()),
        h("details", { key: "fleet-details", style: { marginTop: "6px" } }, [
          h("summary", { key: "summary", style: { ...muted, cursor: "pointer" } }, "容量、费用与估算依据"),
          h("div", { key: "cost", style: muted }, "约 " + Math.round(fleet.cycleSeconds / 60) + " 分钟一圈 · 每列 " + fleet.capacityPerTrain + " 人 · 运营约 $" + fleet.hourlyOperatingCost.toLocaleString() + "/小时"),
          h("div", { key: "estimate", style: muted }, (fleet.timingSource === "native" ? "使用现有进路时间，应用后按新进路复算。" : "时间为估算，应用后按原生寻路复算。") + (throughRouteId ? "直通报价需应用后复核。" : ""))
        ]),
        route?.pvgServiceTransaction ? h("button", { key: "buy", style: { ...button, marginTop: "10px", width: "100%" }, onClick: () => report(purchaseServiceFleet(routeId, fleet.purchaseCost, { headwayMinutes })) }, fleet.purchaseCost > 0 ? "购买缺少的车厢并开行 · $" + fleet.purchaseCost.toLocaleString() : "使用库存配车并开行") : null
      ]) : route ? h("p", { key: "fleet-error", role: "alert", style: muted }, fleet?.error) : null,
      !compatible || (selected && !selected.success) ? h("p", { key: "error", role: "alert", style: { color: "#b45309", fontSize: "12px" } }, !compatible ? "车辆与现有轨道不兼容。" : selected.error) : null,
      route ? h("div", { key: "actions", style: { display: "flex", gap: "8px" } }, [
        h("button", { key: "preview", type: "button", style: { ...button, flex: 1 }, disabled: !plan?.success, onClick: () => { const result = showPlanPreview(routeId, modeId, classId, throughRouteId); if (!result.success) report(result); } }, "地图预览"),
        !managed ? h("button", { key: "apply", type: "button", disabled: !selected?.success || !fleet?.success || !compatible, style: { ...button, flex: 1, background: "#087f8c", color: "#fff" }, onClick: () => {
          const result = applyRouteDesign(routeId, classId, modeId, { throughRouteId, headwayMinutes });
          report({ ...result, message: result.success ? "运营服务已建立，原线路未改动。" + result.warnings.join(" ") : undefined });
          if (result.success) { setRequestedId(result.serviceRouteId); setDraft({}); }
        } }, "应用为新增服务") : null
      ]) : null,
      route?.pvgServiceTransaction ? h("button", { key: "undo", type: "button", style: { ...button, marginTop: "10px", width: "100%" }, onClick: () => { const result = undoRouteDesign(routeId); report(result); if (result.success) setRequestedId(route.pvgParentRouteId); } }, "撤销这次方案") : null,
      feedback ? h("p", { key: "feedback", role: "status", style: { ...muted, padding: "10px", background: "hsl(var(--muted))", borderRadius: "10px" } }, feedback) : null,
      h("p", { key: "safety", style: { ...muted, marginBottom: 0 } }, "不改原线、不自动购车。方案可撤销，已购车厢保留；跳站不等于越行。")
    ]);
  }

  function registerUi() {
    if (!api.ui || typeof api.ui.addToolbarPanel !== "function" || !api.utils?.React) return false;
    api.ui.addToolbarPanel({
      id: "pvg-operations-builder",
      icon: "Network",
      tooltip: "一键规划上海线路",
      title: "上海线路规划",
      width: 500,
      render: OperationsPanel
    });
    return true;
  }

  function initializeCore() {
    if (coreInitialized) return globalThis.__PVG_OPERATIONS__;
    coreInitialized = true;
    const stationTypes = registerStationTypes();
    const trainTypes = registerTrainProfiles();
    const legacyAliases = registerLegacyTrainAliases();
    globalThis.__PVG_OPERATIONS__ = {
      version: VERSION,
      cityCode: CITY_CODE,
      status: getInternalState() ? "ready" : "catalog-only",
      templates: TEMPLATES,
      operationPresets: OPERATION_PRESETS,
      trackClasses: TRACK_CLASSES,
      trainProfiles: TRAIN_PROFILES,
      operatingModes: OPERATING_MODES,
      compatibility: COMPATIBILITY,
      interlockingRules: INTERLOCKING_RULES,
      createStationTemplate,
      placeTemplate,
      buildBlueprints,
      buildStopPlan,
      buildLanePlan,
      canThroughRun,
      getCompatibilityAdvice,
      previewRouteOperation,
      planRouteStations,
      recommendRouteDesign,
      applyRouteDesign,
      undoRouteDesign,
      throughCandidates,
      serviceStopSequence,
      chooseFreeDeparture,
      serviceFingerprint,
      retryServiceDeparture,
      pendingDepartureStatus,
      resolveThroughPlatforms,
      routeSignalRepair,
      planStationExpansion,
      buildStationExpansion,
      undoStationExpansion,
      repairSharedSectionSignals,
      snapshotDispatchConflicts,
      fleetAdvice,
      purchaseServiceFleet,
      serviceLiveStatus,
      installNonstopPlanning,
      installDynamicOvertaking,
      dynamicOvertakeStatus,
      showPlanPreview,
      clearPlanPreview,
      evaluatePathConflict,
      setRouteOperatingMode,
      auditNetwork,
      migrateLegacyOperationsState,
      migrateLegacyInventory,
      removeLegacyTrainAliases,
      restrictPvgTrainCatalog,
      restoreExternalTrainCatalog,
      repairLegacySaveEntry,
      stopSaveEntryWatcher,
      inspectTileSources,
      repairPvgTileSources,
      registered: { stationTypes, trainTypes, legacyAliases, uiReady: false }
    };
    console.info(TAG + " v" + VERSION + " ready; " + trainTypes + " train types, " + legacyAliases + " temporary legacy aliases, " + TEMPLATES.length + " station templates");
    return globalThis.__PVG_OPERATIONS__;
  }

  function inspectTileSources(map, phase) {
    if (!map || typeof map.getStyle !== "function" || !isPvg()) return [];
    const sources = map.getStyle()?.sources || {};
    const snapshot = Object.entries(sources).flatMap(([id, source]) => {
      const tiles = Array.isArray(source?.tiles) ? source.tiles.filter((url) => typeof url === "string") : [];
      return tiles.length ? [{ id, type: source.type, tiles }] : [];
    });
    globalThis.__PVG_TILE_SOURCE_SNAPSHOT__ = { phase, timestamp: Date.now(), sources: snapshot };
    console.info(TAG + " tile sources " + phase + " " + JSON.stringify(snapshot));
    return snapshot;
  }

  function getRailyardTileOrigin() {
    const candidates = [];
    try {
      const cities = api.utils?.getCities?.() || [];
      for (const city of cities) {
        if (city?.code !== CITY_CODE) continue;
        const image = city.mapImageUrl || city.mapImageURL || "";
        if (/^http:\/\/127\.0\.0\.1:\d+\/thumbnails\/PVG\.svg$/i.test(image)) candidates.push(image);
      }
    } catch (error) {
      console.warn(TAG + " could not inspect registered cities", error);
    }
    try {
      for (const entry of globalThis.performance?.getEntriesByType?.("resource") || []) {
        if (/^http:\/\/127\.0\.0\.1:\d+\/(?:thumbnails\/)?PVG(?:\.svg|\/)/i.test(entry?.name || "")) candidates.push(entry.name);
      }
    } catch {}
    for (const candidate of candidates) {
      try { return new URL(candidate).origin; } catch {}
    }
    return null;
  }

  function repairPvgTileSources(map, phase = "manual") {
    if (!map || typeof map.getStyle !== "function") return { ok: false, reason: "map-unavailable", changed: 0 };
    const origin = getRailyardTileOrigin();
    if (!origin) return { ok: false, reason: "railyard-origin-unavailable", changed: 0 };
    const sources = map.getStyle()?.sources || {};
    let changed = 0;
    for (const [id, definition] of Object.entries(sources)) {
      const tiles = Array.isArray(definition?.tiles) ? definition.tiles : [];
      const legacy = tiles.find((url) => /^map:\/\/PVG(?:_foundations)?\/tiles\//i.test(url));
      if (!legacy) continue;
      const archive = /PVG_foundations/i.test(legacy) || /foundation/i.test(id) ? "PVG_foundations" : CITY_CODE;
      const replacement = origin + "/" + archive + "/{z}/{x}/{y}.mvt";
      const source = map.getSource?.(id);
      if (!source || typeof source.setTiles !== "function") continue;
      source.setTiles([replacement]);
      changed += 1;
      console.info(TAG + " repaired " + id + " tile source during " + phase + " → " + replacement);
    }
    if (changed > 0 && typeof map.jumpTo === "function") {
      map.jumpTo({ center: DEFAULT_CENTER, zoom: 9.3, bearing: 0 });
      console.info(TAG + " restored PVG view to Shanghai after tile-source repair");
    }
    const result = { ok: true, origin, changed, phase };
    globalThis.__PVG_TILE_REPAIR__ = { ...result, timestamp: Date.now() };
    return result;
  }

  function schedulePvgTileRepair(cityCode) {
    if (cityCode !== CITY_CODE) {
      restoreExternalTrainCatalog();
      return;
    }
    const sequence = ++tileRepairSequence;
    let attempts = 0;
    const attempt = () => {
      if (sequence !== tileRepairSequence || api.utils?.getCityCode?.() !== CITY_CODE) return;
      attempts += 1;
      const result = repairPvgTileSources(api.utils?.getMap?.(), "city-load-attempt-" + attempts);
      if (result.changed > 0) {
        inspectTileSources(api.utils?.getMap?.(), "after-early-repair");
        return;
      }
      if (attempts < 120) window.setTimeout?.(attempt, 250);
    };
    attempt();
  }

  function initializeMapUi(map) {
    const publicApi = initializeCore();
    if (uiInitialized || !isPvg()) return;
    publicApi.registered.nonstopPlanning = installNonstopPlanning().success;
    installPendingDepartureWatcher();
    const migration = migrateLegacyOperationsState();
    migrateLegacyInventory();
    if (migration.ok) removeLegacyTrainAliases();
    const catalog = restrictPvgTrainCatalog();
    publicApi.registered.externalTrainTypesHidden = catalog.hidden;
    publicApi.registered.visibleTrainTypes = catalog.visible;
    repairPvgTileSources(map, "map-ready");
    inspectTileSources(map, "map-ready");
    window.setTimeout?.(() => inspectTileSources(map, "map-ready+1s"), 1000);
    window.setTimeout?.(() => inspectTileSources(map, "map-ready+5s"), 5000);
    uiInitialized = registerUi();
    publicApi.registered.uiReady = uiInitialized;
    publicApi.status = getInternalState() ? "ready" : "catalog-only";
    if (uiInitialized) {
      notify("2/4/6/8股道车站与五档轨道/车辆工具已加载。", "success", "上海多制式运营 v" + VERSION);
    }
  }

  if (api.hooks && typeof api.hooks.onGameInit === "function") api.hooks.onGameInit(initializeCore);
  if (api.hooks && typeof api.hooks.onCityLoad === "function") api.hooks.onCityLoad(schedulePvgTileRepair);
  if (api.hooks && typeof api.hooks.onMapReady === "function") api.hooks.onMapReady(initializeMapUi);
  initializeCore();
})();
