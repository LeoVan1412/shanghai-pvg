"use strict";
const assert=require("node:assert/strict");
require("./test_operations_mod");
const {fixture,options}=require("./test_expansion_core");
const mod=global.__PVG_OPERATIONS__,core=global.PVGExpansionCore;
const state=global.__PVG_OPERATIONS_TEST_STATE__;
global.PVGExpansionBoundaries={geometries:options.exclusionGeometries};
let expenses=0,builds=0,duringBuild=null,forceFailure=false;
function reset(){
  Object.assign(state,fixture(),{stations:[],stationGroups:[],previewRoute:null,trackGroups:[],
    setSignals({signals}){this.signals=signals;},setRoutes(routes){this.routes=routes;},setTrains(trains){this.trains=trains;},
    setTracks(payload){
      assert.deepEqual(payload.regenRoutesWithTrackIDs,[],"construction must not regenerate original services");
      const signals=this.signals.map(s=>({...s,id:s.id+"-regenerated",status:{occupations:[],reservedBy:null}}));
      this.setSignals({signals,tracks:payload.newTracks});
      this.tracks=payload.newTracks;this.trackGroups=payload.newTrackGroups || this.trackGroups;
      const valid=new Set(this.signals.map(s=>s.id));
      this.routes=this.routes.map(r=>r.stCombos.some(c=>c.path.some(p=>p.signals?.some(ref=>!valid.has(ref.signalId))))?
        {...r,stCombos:r.stCombos.map(c=>({...c,path:c.path.map(p=>p.signals?{...p,signals:p.signals.filter(ref=>valid.has(ref.signalId))}:p)}))}:r);
    },
    async buildBlueprints(){
      const quotedTracks=this.tracks,quotedGroups=this.trackGroups;
      builds++;await Promise.resolve();if(duringBuild)await duringBuild();
      try {
        if(forceFailure)throw Error("native refused");
        const newTracks=quotedTracks.map(t=>t.buildType==="blueprint"?{...t,buildType:"constructed"}:t);
        this.setTracks({newTracks,signalsUpdate:{action:"replace",signals:[]},regenRoutesWithTrackIDs:"every"});expenses++;
        this.blueprintHistory={past:[],future:[]};
      }catch(error){/* Native UI displays failures but returns undefined. */}
    }});
  state.signals=[{id:"old-resource",type:"v-merge",buildType:"constructed",signalTracks:[{trackId:"prev1",areaCovered:"all"}],status:{occupations:[{trainId:"unrelated",timeVerified:100}],reservedBy:null}}];
  state.trains=[{id:"unrelated",routeId:"local",motion:{speed:8},windows:{train:{tracks:[{trackId:"prev1",headProgress:60,tailProgress:20}]}}}];
  expenses=0;builds=0;duringBuild=null;forceFailure=false;
}
async function main(){
  reset();const originalTrain=state.trains[0],originalMotion=originalTrain.motion,originalRoutes=state.routes;
  const originalSignal=state.signals[0];
  let plan=mod.planStationExpansion("local","b");assert.equal(plan.success,true,plan.error);
  duringBuild=async()=>{state.timeConfig.elapsedSeconds+=8;originalTrain.windows.train.tracks[0].headProgress+=50;originalSignal.status.occupations[0].timeVerified+=8;};
  let result=await mod.buildStationExpansion(plan);assert.equal(result.success,true,result.error);
  assert.equal(expenses,1);assert.equal(state.trains[0],originalTrain);assert.equal(originalTrain.motion,originalMotion);
  assert.equal(originalTrain.windows.train.tracks[0].headProgress,110,"unrelated train continues during the awaited native construction");
  assert.equal(state.routes[0].stNodes,originalRoutes[0].stNodes);assert.ok(state.signals.includes(originalSignal));
  assert.equal(state.signals.find(s=>s.id==="old-resource").status.occupations[0].timeVerified,108);
  assert.ok(state.tracks.some(t=>t.pvgExpansionId===plan.id&&t.buildType==="constructed"));
  // Serialize ownership. Unused rails can be removed without touching cash.
  const receipt=JSON.parse(JSON.stringify(state.trackGroups.find(g=>g.pvgExpansionId===plan.id).pvgExpansionReceipt));
  assert.equal(receipt.id,plan.id);result=mod.undoStationExpansion(plan.id);assert.equal(result.success,true,result.error);
  assert.equal(state.tracks.length,fixture().tracks.length);assert.equal(expenses,1);assert.equal(state.trains[0],originalTrain);
  reset();plan=mod.planStationExpansion("local","b");state.trains.push({id:"busy",windows:{warning:{tracks:[{trackId:"in"}]}}});
  result=await mod.buildStationExpansion(plan);assert.equal(result.pending,true);assert.equal(builds,0);
  reset();plan=mod.planStationExpansion("local","b");forceFailure=true;
  result=await mod.buildStationExpansion(plan);assert.equal(result.success,false);assert.equal(expenses,0);
  assert.equal(state.tracks.length,fixture().tracks.length,"native swallowed failure must remove only own staged blueprints");
  reset();plan=mod.planStationExpansion("local","b");duringBuild=async()=>{state.trains.push({id:"arrived",windows:{train:{tracks:[{trackId:"in"}]}}});};
  result=await mod.buildStationExpansion(plan);assert.equal(result.success,false);assert.equal(expenses,0);assert.equal(state.trains.length,2);
  reset();plan=mod.planStationExpansion("local","b");duringBuild=async()=>{state.tracks.push({...state.tracks[0],id:"player-draft",buildType:"blueprint"});};
  result=await mod.buildStationExpansion(plan);assert.equal(result.success,false);assert.equal(expenses,0);
  assert.ok(state.tracks.some(t=>t.id==="player-draft"),"rollback preserves concurrent manual drafts");
  reset();plan=mod.planStationExpansion("local","b");plan.tracks[0].coords[1]=[0,0];
  result=await mod.buildStationExpansion(plan);assert.equal(result.success,false);assert.equal(builds,0);
  reset();plan=mod.planStationExpansion("local","b");result=await mod.buildStationExpansion(plan);assert.equal(result.success,true);
  state.routes.push({id:"new-user",stCombos:[{path:[{trackId:plan.tracks[0].id}]}]});assert.equal(mod.undoStationExpansion(plan.id).success,false);
  reset();
  const draft={...state.tracks[0],id:"unrelated-draft",buildType:"blueprint"};state.tracks.push(draft);
  state.trackGroups.push({id:"unrelated-draft-group",trackIds:[draft.id]});
  const history={past:[{tracks:[draft]}],future:[]};state.blueprintHistory=history;
  plan=mod.planStationExpansion("local","b");result=await mod.buildStationExpansion(plan);assert.equal(result.success,true,result.error);
  assert.equal(state.tracks.find(t=>t.id===draft.id),draft,"unowned blueprints are neither built nor erased");
  assert.equal(state.blueprintHistory,history,"unrelated blueprint undo history survives the native build");
  reset();plan=mod.planStationExpansion("local","b");result=await mod.buildStationExpansion(plan);assert.equal(result.success,true);
  state.signals.push({id:"own-merge",buildType:"constructed",type:"v-merge",signalTracks:[{trackId:plan.tracks[0].id,areaCovered:"all"},{trackId:"in",areaCovered:"all"}],status:{occupations:[],reservedBy:null}});
  state.routes[0].stCombos[0].path.find(p=>p.trackId==="in").signals=[{signalId:"own-merge",areaCovered:"all"}];
  result=mod.undoStationExpansion(plan.id);assert.equal(result.success,true,result.error);
  assert.deepEqual(state.routes[0].stCombos[0].path.find(p=>p.trackId==="in").signals,[],"native stale-ref cleanup on unused expansion undo is allowed without rerouting trains");
  console.log(JSON.stringify({ok:true,scope:"native-shaped transaction mock; ongoing trains, fresh occupations, own-scope build/undo, rollback and native swallowed failures"}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
