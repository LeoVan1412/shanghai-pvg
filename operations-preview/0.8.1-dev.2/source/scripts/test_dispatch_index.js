"use strict";
const assert=require("node:assert/strict");
const core=require("../operations-mod/dispatch-core");
const {fixture}=require("./test_dispatch_core");
const naiveOwners=(s,ids)=>{
  const wanted=new Set(ids),owners=new Set();
  for(const t of s.trains)if(t.windows?.train?.tracks.some(p=>wanted.has(p.trackId)))owners.add(t.id);
  for(const signal of s.signals)if(signal.signalTracks?.some(p=>wanted.has(p.trackId))) {
    for(const o of (signal.status?.occupations || []).filter(Boolean))
      if(o.timeVerified>=s.timeConfig.elapsedSeconds-1)owners.add(o.trainId);
    if(signal.status?.reservedBy)owners.add(signal.status.reservedBy.trainId);
  }
  return [...owners].sort();
};
for(let seed=0;seed<80;seed++){
  const s=fixture();
  s.signals=Array.from({length:20},(_,i)=>({type:i%2?"v-merge":"station",
    signalTracks:[{trackId:s.tracks[(i+seed)%s.tracks.length].id}],
    status:{occupations:[{trainId:"owner-"+i,timeVerified:100-(i+seed)%3}],
      reservedBy:{trainId:"reserved-"+i,timeVerified:100-(i*3+seed)%3}}}));
  const ids=s.tracks.filter((_,i)=>(i+seed)%3===0).map(t=>t.id);
  assert.deepEqual([...core.resourceOwners(s,ids)].sort(),naiveOwners(s,ids));
  const before=structuredClone(s),shared=core.planDispatch(s);
  const overtaking=core.planOvertakes(s),throats=core.planThroatDepartures(s,{},overtaking.holds.flatMap(h=>[h.slowId,h.fastId]));
  assert.deepEqual(shared,{overtaking,throats});
  assert.deepEqual(s,before,"index building must not change native state");
}
const s=fixture();
assert.equal(core.planDispatch(s).overtaking.holds.length,1);
// Native signal/trains can mutate in place. Even at the SAME clock value or
// after a save reload, the next decision must never reuse prior vacancy.
s.signals.push({signalTracks:[{trackId:"merge"}],status:{reservedBy:{trainId:"other",timeVerified:100}}});
assert.equal(core.planDispatch(s).overtaking.holds.length,0);
s.signals[0].status.reservedBy.timeVerified=0;
assert.equal(core.planDispatch(s).overtaking.holds.length,0,"native reservations remain authoritative regardless of record age");
s.signals[0].status.reservedBy=null;
assert.equal(core.planDispatch(s).overtaking.holds.length,1);
s.tracks.find(t=>t.id==="bypass").buildType="blueprint";
assert.equal(core.planDispatch(s).overtaking.holds.length,0);
s.tracks.find(t=>t.id==="bypass").buildType="constructed";
s.routes[1].stCombos[0].path.find(p=>p.trackId==="merge").reversed=true;
assert.equal(core.planDispatch(s).overtaking.holds.length,0);
assert.deepEqual(core.planDispatch(fixture(),undefined,undefined,{throatAdmission:false}).throats,{});
assert.ok(core.planOvertakes(fixture(),undefined,{diagnostics:true}).diagnostics.priorityPairs>0);
console.log(JSON.stringify({ok:true,scope:"single-frame shared indexes; ownership equivalence, in-place mutations, same-time reload safety, no native state writes"}));
