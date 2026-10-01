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
