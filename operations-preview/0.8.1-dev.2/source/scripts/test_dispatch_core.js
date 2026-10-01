"use strict";
const assert = require("node:assert/strict");
const core = require("../operations-mod/dispatch-core");
function fixture() {
  const track = (id,length,role) => ({id,length,pvgRole:role,buildType:"constructed"});
  const tracks = [track("p1",100),track("p2",100),track("out",100),track("entry",400),track("bypass",300,"express-bypass"),track("merge",100),track("exit",1000)];
  const combo = (ids,start) => ({startStNodeId:start,endStNodeId:"end",path:ids.map(id=>({trackId:id,length:tracks.find(t=>t.id===id).length,reversed:false}))});
  const routes = [{id:"local",pvgOperatingMode:"local",stNodes:[{id:"slow-node",trackIds:["p1","p2"]}],stCombos:[combo(["p1","p2","out","merge","exit"],"slow-node")]},
    {id:"express",pvgOperatingMode:"express",stCombos:[combo(["entry","bypass","merge","exit"],"fast-node")]}];
  const trains = [{id:"slow",routeId:"local",trainType:"test",length:120,motion:{speed:0},currentStComboInfo:{index:0,timeAtStop:80,timeAtStopEnd:null,reversesAtStop:false},windows:{train:{tracks:[{trackId:"p1"},{trackId:"p2"}],headStComboProgress:160,tailStComboProgress:40}}},
    {id:"fast",routeId:"express",trainType:"test",length:120,motion:{speed:20},currentStComboInfo:{index:0,timeAtStop:null,timeAtStopEnd:null},windows:{train:{tracks:[{trackId:"entry"}],headStComboProgress:200,tailStComboProgress:80}}}];
  return {tracks,routes,trains,signals:[],stations:[{id:"station",stNodeIds:["slow-node","opposite-node"],stationType:"standard",buildType:"constructed"}],timeConfig:{elapsedSeconds:100}};
}
let s=fixture(), before=structuredClone(s), plan=core.planOvertakes(s);
assert.equal(plan.holds.length,1);assert.deepEqual(s,before,"planner never mutates simulation");
const first=plan.holds[0];assert.equal(first.fastId,"fast");
s.trains[1].windows.train={tracks:[{trackId:"merge"}],headStComboProgress:850,tailStComboProgress:730};
assert.equal(core.planOvertakes(s,plan).holds.length,1,"head passing does not release the slow train");
s.trains[1].windows.train={tracks:[{trackId:"exit"}],headStComboProgress:950,tailStComboProgress:830};
let released=core.planOvertakes(s,plan);assert.equal(released.holds.length,0);assert.equal(released.events[0].reason,"tail-cleared");
s=fixture();s.timeConfig.elapsedSeconds=first.deadline;
released=core.planOvertakes(s,plan);assert.equal(released.holds.length,0);assert.equal(released.events[0].reason,"bounded-wait-expired");
assert.equal(core.planOvertakes(s,released).holds.length,0,"do not hold the same stopped train repeatedly");
// Entry lookahead and whole-train exit are different constraints. A nearby
// independent bypass must not be rejected just because its merge is >3km
// away; a bounded wait and real exit berth remain mandatory.
s=fixture();s.tracks.find(t=>t.id==="bypass").length=3300;
s.routes[1].stCombos[0].path.find(p=>p.trackId==="bypass").length=3300;
s.trains[1].motion.speed=30;
plan=core.planOvertakes(s,{}, {maxWaitSeconds:180,diagnostics:true});
assert.equal(plan.holds.length,1,"near entry, longer bypass, enough actual exit and bounded wait");
assert.equal(core.planOvertakes(s,{}, {maxWaitSeconds:100,diagnostics:true}).diagnostics.rejections["clearance-outside-wait-budget"],1);
s.tracks.find(t=>t.id==="entry").length=4000;
s.routes[1].stCombos[0].path[0].length=4000;
assert.equal(core.planOvertakes(s,{}, {maxWaitSeconds:180,diagnostics:true}).diagnostics.rejections["outside-approach-window"],1,"distant entry remains rejected");
for(const alter of [
  x=>{x.tracks.find(t=>t.id==="bypass").pvgRole=null;},
  x=>{x.tracks.find(t=>t.id==="bypass").buildType="blueprint";},
  x=>{x.routes[1].stCombos[0].path.find(p=>p.trackId==="merge").reversed=true;},
  x=>{x.trains[0].motion.speed=1;},
  x=>{x.trains[1].motion.speed=0;},
  x=>{x.trains[0].length=210;},
  x=>{x.trains.push({id:"occupied",windows:{train:{tracks:[{trackId:"merge"}]}}});},
  x=>{x.signals=[{signalTracks:[{trackId:"merge"}],status:{reservedBy:{trainId:"another",timeVerified:100}}}];}
]) {s=fixture();alter(s);assert.equal(core.planOvertakes(s).holds.length,0);}
s=fixture();plan=core.planOvertakes(s);
const types={standard:{id:"standard",extraDwellTime:5,catchmentRadius:500}}, trainTypes={test:{stats:{stopTimeSeconds:30}}};
const original=structuredClone(types);
core.withNativeDwell(s,plan,types,trainTypes,({stations,stNodeIdToStationMap})=>{
  assert.equal(stations,s.stations);assert.equal(stNodeIdToStationMap.get("opposite-node").stationType,"standard");
  const held=types[stNodeIdToStationMap.get("slow-node").stationType];
  assert.equal(held.extraDwellTime,110);assert.equal(held.catchmentRadius,500);
});
assert.deepEqual(types,original);
assert.throws(()=>core.withNativeDwell(s,plan,types,trainTypes,()=>{throw Error("native failed");}));assert.deepEqual(types,original);
assert.throws(()=>core.withNativeDwell(s,{holds:[...plan.holds,...plan.holds]},types,trainTypes,()=>{}));assert.deepEqual(types,original,"setup failure cleans all temporary definitions");

// Shared-zone atomic arbitration, tail release, exit and native reservations.
s=fixture();s.tracks.push({id:"other-throat",length:100,buildType:"constructed",pvgConflictZones:["west","east"]});
s.tracks.find(t=>t.id==="merge").pvgConflictZone="east";
const req=(trainId,throatTrackIds,requestedAt)=>({trainId,throatTrackIds,exitTrackIds:["exit"],requestedAt});
let a=core.arbitrateThroats(s,[req("fast",["other-throat"],90),req("slow",["merge"],80)]);
assert.equal(a.grants.length,1);assert.equal(a.grants[0].trainId,"slow");assert.equal(a.waiting.length,1);
s.trains[0].windows.train.tracks=[{trackId:"merge"}];
a=core.arbitrateThroats(s,[],a.grants);assert.equal(a.grants[0].entered,true);
s.trains[0].windows.train.tracks=[{trackId:"exit"}];
a=core.arbitrateThroats(s,[],a.grants);assert.equal(a.grants.length,1,"tail in exit berth retains complete throat");
s.trains[0].windows.train.tracks=[];
assert.equal(core.arbitrateThroats(s,[],a.grants).grants.length,0);
s=fixture();s.signals=[{signalTracks:[{trackId:"exit"}],status:{occupations:[{trainId:"fast",timeVerified:100}]}}];
assert.equal(core.arbitrateThroats(s,[req("slow",["merge"],80)]).grants.length,0);
s=fixture();s.tracks.find(t=>t.id==="exit").length=100;
assert.equal(core.arbitrateThroats(s,[{...req("slow",["merge"],80),exitTrackIds:["exit","exit"]}]).grants.length,0,"duplicated exit IDs cannot manufacture berth capacity");
s=fixture();s.tracks.find(t=>t.id==="merge").pvgConflictZone="shared";
s.tracks.push({id:"crossing",length:200,pvgConflictZones:["shared"],buildType:"constructed"});
s.trains[1].windows.train.tracks=[{trackId:"crossing"}];
assert.equal(core.arbitrateThroats(s,[req("slow",["merge"],80)]).grants.length,0,"native occupation of another rail in the same conflict zone is authoritative");
s=fixture();s.tracks.find(t=>t.id==="merge").pvgConflictZone="shared";
s.trains[1].windows.train.tracks=[{trackId:"merge"}];
let gate=core.planThroatDepartures(s);
assert.equal(gate.holds.length,1);assert.equal(gate.holds[0].kind,"throat-admission");
s.timeConfig.elapsedSeconds=gate.holds[0].deadline;
let bounded=core.planThroatDepartures(s,gate);assert.equal(bounded.holds.length,0);
assert.ok(bounded.diagnostics.some(d=>d.reason==="bounded-admission-wait-expired"));
assert.equal(core.planThroatDepartures(s,bounded).holds.length,0,"never hide a deadlock by re-holding the same stop forever");
s=fixture();plan=core.planOvertakes(s);
const descriptors=s.trains.map(t=>Object.getOwnPropertyDescriptor(t,"currentStComboInfo"));
core.withLiveNativeDwell(s,plan,types,trainTypes,()=>{
  void s.trains[0].currentStComboInfo.index;assert.equal(types.standard.extraDwellTime,110);
  void s.trains[1].currentStComboInfo.index;assert.equal(types.standard.extraDwellTime,5,"another train at the same physical station must keep its own dwell");
  s.trains[0].currentStComboInfo={...s.trains[0].currentStComboInfo,nativeUpdated:true};
});
assert.equal(s.trains[0].currentStComboInfo.nativeUpdated,true,"native assignments survive accessor cleanup");
assert.ok(s.trains.every((t,i)=>Object.getOwnPropertyDescriptor(t,"currentStComboInfo").get===undefined));
assert.deepEqual(types,original);
assert.throws(()=>core.withLiveNativeDwell(s,plan,types,trainTypes,()=>{throw Error("native failure");}));assert.deepEqual(types,original);
assert.ok(s.trains.every(t=>Object.getOwnPropertyDescriptor(t,"currentStComboInfo").get===undefined));
// Reconnection at a short downstream platform requires actual forward native
// continuation, not adding the duplicated platform lengths to available space.
function nextLegFixture() {
  const s=fixture(),r=s.routes[1];
  s.tracks.find(t=>t.id==="merge").type="station";
  s.tracks.find(t=>t.id==="exit").length=100;s.tracks.find(t=>t.id==="exit").type="station";
  r.stCombos[0].path.at(-1).length=100;r.stCombos[0].endStNodeId="next-platform";
  s.tracks.push({id:"beyond",length:1000,buildType:"constructed"});
  r.stCombos.push({startStNodeId:"next-platform",endStNodeId:"far",
    path:[...structuredClone(r.stCombos[0].path.slice(-2)),{trackId:"beyond",length:1000,reversed:false}]});
  return s;
}
s=nextLegFixture();plan=core.planOvertakes(s);assert.equal(plan.holds.length,1);
assert.equal(plan.holds[0].nextClearAt,125);assert.deepEqual(plan.holds[0].exitTrackIds,["exit","beyond"]);
s.routes[1].stComboTimings=[{stNodeIndex:1,arrivalTime:150,departureTime:270}];
assert.equal(core.planOvertakes(s,{}, {diagnostics:true}).diagnostics.rejections["clearance-outside-wait-budget"],1,"native downstream dwell is part of the wait forecast");
assert.equal(core.planOvertakes(s,{}, {maxWaitSeconds:180}).holds.length,1,"forecast can admit but never release a bounded hold");
s.routes[1].stComboTimings=undefined;
s.trains[1].currentStComboInfo.index=1;
s.trains[1].timings=[{stNodeId:"next-platform",stNodeIndex:1,arrivalTime:110}];
s.trains[1].windows.train={tracks:[{trackId:"exit"}],headStComboProgress:240,tailStComboProgress:120};
assert.equal(core.planOvertakes(s,plan).holds.length,1,"arrival / combo transition is not tail-clear proof");
core.withLiveNativeDwell(s,plan,types,trainTypes,()=>{
  void s.trains[0].currentStComboInfo.index;assert.equal(types.standard.extraDwellTime,110,"hold survives native arrival transition");
  s.trains[1].windows.train.tailStComboProgress=126;
  void s.trains[0].currentStComboInfo.index;assert.equal(types.standard.extraDwellTime,5,"observed next-leg tail + 25m releases within a batch");
});
assert.equal(core.planOvertakes(s,plan).events[0].reason,"tail-cleared");
for(const alter of [
  x=>{x.routes[1].stCombos[1].path[0].reversed=true;},
  x=>{x.routes[1].stCombos[1].startStNodeId="different";},
  x=>{x.routes[1].stCombos[1].path.at(-1).length=20;},
  x=>{x.trains.push({id:"third",windows:{train:{tracks:[{trackId:"beyond"}]}}});},
  x=>{x.signals=[{signalTracks:[{trackId:"beyond"}],status:{reservedBy:{trainId:"orphan",timeVerified:0}}}];}
]) {s=nextLegFixture();alter(s);assert.equal(core.planOvertakes(s).holds.length,0,String(alter));}
for(const alter of [
  x=>{x.trains[1].currentStComboInfo.index=2;},
  x=>{x.trains[1].timings=[];},
  x=>{x.trains[1].currentStComboInfo.reversesAtStop=true;},
  x=>{x.routes[1].stCombos[1].path[0].length+=1;},
  x=>{x.trains[1].windows.train.tracks=[];}
]) {
  s=nextLegFixture();plan=core.planOvertakes(s);s.trains[1].currentStComboInfo.index=1;
  s.trains[1].timings=[{stNodeId:"next-platform",stNodeIndex:1,arrivalTime:110}];
  s.trains[1].windows.train={tracks:[{trackId:"beyond"}],headStComboProgress:400,tailStComboProgress:280};
  alter(s);assert.equal(core.planOvertakes(s,plan).events[0].reason,"path-changed-or-unobserved-exit");
}
s.signals=[];s.tracks.find(t=>t.id==="exit").length=100;
assert.equal(core.arbitrateThroats(s,[req("slow",["merge"],80)]).grants.length,0);
console.log(JSON.stringify({ok:true,scope:"dispatch decision and native-dwell adapter units; not loaded-game validation"}));
module.exports={fixture};
