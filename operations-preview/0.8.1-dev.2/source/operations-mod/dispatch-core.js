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
