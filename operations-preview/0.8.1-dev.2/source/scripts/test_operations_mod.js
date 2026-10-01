#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const callbacks = { gameInit: [], cityLoad: [], mapReady: [] };
const trainRegistrations = [];
const stationRegistrations = [];
const panels = [];
const notifications = [];
const windowEvents = {};
let entryWatcher;
let clearedEntryWatchers = 0;
const intervalCallbacks=new Map();let nextIntervalId=0;
global.__PVG_TEST_INTERVALS__=intervalCallbacks;

const baseStats = {
  maxSpeed: 25,
  maxAcceleration: 1,
  maxDeceleration: 1.2,
  maxLateralAcceleration: 0.9,
  maxSlopePercentage: 4,
  maxSpeedLocalStation: 12,
  crossoverSpeed: 6.7,
  stopTimeSeconds: 30,
  turnaroundTimeSeconds: 120,
  minTurnRadius: 75,
  minStationTurnRadius: 300,
  parallelTrackSpacing: 4,
  trackClearance: 1,
  minCars: 4,
  maxCars: 8,
  carsPerCarSet: 2,
  capacityPerCar: 200,
  carLength: 20,
  trainWidth: 3,
  minStationLength: 80,
  maxStationLength: 180,
  carCost: 2000000,
  baseTrackCost: 20000,
  baseStationCost: 30000000,
  trainOperationalCostPerHour: 300,
  carOperationalCostPerHour: 30,
  trackMaintenanceCostPerMeter: 200,
  stationMaintenanceCostPerYear: 80000,
  tphLimit: 36
};

const builtIns = new Map(["heavy-metro", "commuter-rail", "regional-rail", "intercity-rail", "high-speed-rail", "maglev"].map((id) => [id, {
  id,
  name: id,
  description: id,
  stats: { ...baseStats },
  compatibleTrackTypes: [id],
  appearance: { color: "#333333" },
  elevationMultipliers: { AT_GRADE: 1, STANDARD_TUNNEL: 2 }
}]));
const trainRegistry = Object.fromEntries(builtIns);
const stationRegistry = {standard:{id:"standard",extraDwellTime:0}};

let state = {
  tracks: [],
  trackGroups: [],
  stations: [],
  stationGroups: [],
  routes: [],
  trains: [],
  setTracks(payload) {
    this.tracks = payload.newTracks;
    this.trackGroups = payload.newTrackGroups;
  },
  setRoutes(routes) { this.routes = routes; },
  setTrains(trains) { this.trains = trains; },
  setStationGroupCustomName() {}
};

global.window = {
  document: {},
  addEventListener(name, callback) { windowEvents[name] = callback; },
  setInterval(callback) { const id=++nextIntervalId;intervalCallbacks.set(id,callback);if(id===1)entryWatcher=callback;return id; },
  clearInterval(handle) { assert.equal(handle, 1); clearedEntryWatchers += 1; },
  SubwayBuilderAPI: {
    utils: {
      getCityCode: () => "PVG",
      getCities: () => [{ code: "PVG", uid: "com.railyard.maploader:PVG", mapImageUrl: "http://127.0.0.1:54226/thumbnails/PVG.svg" }],
      getMap: () => ({ getCenter: () => ({ lng: 121.4737, lat: 31.2304 }) }),
      React: {
        createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
        useState(value) {
          const index = global.__PVG_TEST_HOOK_INDEX__++;
          if (!(index in global.__PVG_TEST_HOOKS__)) global.__PVG_TEST_HOOKS__[index] = value;
          return [global.__PVG_TEST_HOOKS__[index], (next) => { global.__PVG_TEST_HOOKS__[index] = next; }];
        }
      }
    },
    hooks: {
      onGameInit(callback) { callbacks.gameInit.push(callback); },
      onCityLoad(callback) { callbacks.cityLoad.push(callback); },
      onMapReady(callback) { callbacks.mapReady.push(callback); }
    },
    trains: {
      getTrainType(id) { return trainRegistry[id] || null; },
      getTrainTypes() { return trainRegistry; },
      registerTrainType(definition) { trainRegistrations.push(definition); trainRegistry[definition.id] = definition; }
    },
    stations: {
      getStationTypes(){return stationRegistry;},
      registerStationType(definition) { stationRegistrations.push(definition); stationRegistry[definition.id]=definition; }
    },
    ui: {
      addToolbarPanel(panel) { panels.push(panel); },
      showNotification(message, level, title) { notifications.push({ message, level, title }); }
    },
    build: {
      async buildBlueprints() { return { success: true, builtTrackCount: state.tracks.length }; }
    },
    renameStation() {}
  },
  setTimeout(callback) { callback(); }
};
global.globalThis = global;
global.__PVG_TEST_HOOKS__ = [];
global.__PVG_TEST_HOOK_INDEX__ = 0;
global.__subwayBuilder_storeCallbacks__ = { getState: () => state };

require(path.join(__dirname, "..", "operations-mod", "dispatch-core.js"));
require(path.join(__dirname, "..", "operations-mod", "expansion-core.js"));
require(path.join(__dirname, "..", "operations-mod", "index.js"));

const mod = global.__PVG_OPERATIONS__;
assert.ok(mod, "operations API must be exposed");
const modSource = require("node:fs").readFileSync(path.join(__dirname, "..", "operations-mod", "index.js"), "utf8");
assert.ok(modSource.includes('"上海线路规划"'));
assert.ok(modSource.includes('"应用为新增服务"'));
assert.ok(modSource.includes('"调整速度与发车间隔"'));
assert.equal(typeof windowEvents.hashchange, "function");
let repairedUrl = null;
let entryReloads=0;
assert.equal(mod.repairLegacySaveEntry({href:"file:///game/index.html#/game?city=PVG&mode=sandbox",replace(url){repairedUrl=url;},reload(){entryReloads++;}}),true);
const normalized = new URL(repairedUrl);
assert.equal(new URLSearchParams(normalized.hash.split("?")[1]).get("city"),"com.railyard.maploader:PVG");
assert.equal(new URLSearchParams(normalized.hash.split("?")[1]).get("mode"),"sandbox");
assert.equal(normalized.search, "");
assert.equal(entryReloads,1);
assert.equal(mod.repairLegacySaveEntry({href:repairedUrl,replace(){throw Error("redirect loop");}}),false);
const repeatedEntry = new URL(repairedUrl);
repeatedEntry.hash = "/game?city=PVG";
assert.equal(mod.repairLegacySaveEntry({href:repeatedEntry.href,replace(url){repairedUrl=url;}}),true);
assert.equal(new URL(repairedUrl).search, "");
assert.equal(mod.repairLegacySaveEntry({href:"file:///game/index.html#/game?city=TYO",replace(){throw Error("other city modified");}}),false);
assert.equal(mod.repairLegacySaveEntry({href:"file:///game/index.html#/",replace(){throw Error("menu modified");}}),false);
let redirectCalls=0;
window.location={href:"file:///game/index.html#/game?city=PVG",hash:"#/game?city=PVG",replace(){redirectCalls++;}};
entryWatcher(); entryWatcher(); windowEvents.hashchange();
assert.equal(redirectCalls,1,"an in-flight navigation must not be repeatedly cancelled");
delete window.location;
const nativeNavigations=[];
window.location={href:"file:///game/index.html#/game?city=PVG",replace(){throw Error("browser navigation used instead of native reload");}};
window.history={state:{test:true},replaceState(state,title,url){nativeNavigations.push({state,url});}};
window.electron={reloadWindow(){nativeNavigations.push("native-reload");}};
assert.equal(mod.repairLegacySaveEntry(window.location),true);
assert.equal(nativeNavigations.length,2);
assert.equal(nativeNavigations[1],"native-reload");
assert.deepEqual(nativeNavigations[0].state,{test:true});
assert(new URL(nativeNavigations[0].url).hash.includes("com.railyard.maploader%3APVG"));
delete window.location; delete window.history; delete window.electron;
window.location={hash:"#/game?city=com.railyard.maploader%3APVG"};
entryWatcher();
assert.equal(clearedEntryWatchers,1,"legacy URL watcher must stop after the namespaced map has loaded");
assert.equal(window.__PVG_SAVE_ENTRY_WATCH__,null);
delete window.location;
assert.equal(mod.status, "ready");
assert.equal(mod.version, require("../operations-mod/manifest.json").version);
assert.equal(mod.templates.length, 7);
assert.equal(mod.operationPresets.length, 6);
assert.equal(mod.registered.trainTypes, 5);
assert.equal(mod.registered.legacyAliases, 6);
assert.equal(mod.registered.stationTypes, 4);
const tileDefinition = { type: "vector", tiles: ["map://PVG/tiles/{z}/{x}/{y}.mvt"] };
let repairedView = null;
const tileMap = {
  getStyle: () => ({ sources: { "general-tiles": tileDefinition } }),
  getSource: (id) => id === "general-tiles" ? { setTiles(tiles) { tileDefinition.tiles = tiles; } } : null,
  jumpTo: (view) => { repairedView = view; }
};
const tileRepair = mod.repairPvgTileSources(tileMap, "unit-test");
assert.equal(tileRepair.ok, true);
assert.equal(tileRepair.changed, 1);
assert.deepEqual(tileDefinition.tiles, ["http://127.0.0.1:54226/PVG/{z}/{x}/{y}.mvt"]);
assert.deepEqual(repairedView, { center: [121.4737, 31.2304], zoom: 9.3, bearing: 0 });
assert.equal(trainRegistrations.length, 11);
assert.equal(stationRegistrations.length, 4);
assert.equal(panels.length, 0, "toolbar panel must wait for map readiness");
callbacks.mapReady.forEach((callback) => callback());
assert.equal(panels.length, 1);
assert.equal(mod.registered.uiReady, true);
assert.deepEqual(Object.keys(trainRegistry).filter((id) => id.startsWith("pvg-ops-")).sort(), [
  "pvg-ops-heavy-160", "pvg-ops-high-speed-300", "pvg-ops-intercity-200", "pvg-ops-light-80", "pvg-ops-medium-120"
]);
assert.deepEqual(Object.keys(trainRegistry).sort(), [
  "pvg-ops-heavy-160", "pvg-ops-high-speed-300", "pvg-ops-intercity-200", "pvg-ops-light-80", "pvg-ops-medium-120"
], "PVG native picker must expose exactly five types, including types registered by other mods");
assert.equal(mod.registered.externalTrainTypesHidden, builtIns.size);
assert.equal(mod.registered.visibleTrainTypes, 5);
assert.equal(mod.restoreExternalTrainCatalog(), builtIns.size);
assert.ok([...builtIns.keys()].every((id) => trainRegistry[id]), "external types must be restorable outside PVG");
assert.equal(mod.restrictPvgTrainCatalog().visible, 5);
assert.equal(Object.keys(trainRegistry).length, 5);
assert.equal("addBulkPurchaseControls" in mod, false, "removed purchase controls must not remain in the public API");
assert.equal("installBulkPurchaseControls" in mod, false, "removed purchase observer must not remain in the public API");

const visibleTrainRegistrations = trainRegistrations.filter((train) => !train.pvgCompatibilityAlias);
assert.deepEqual(visibleTrainRegistrations.map((train) => Math.round(train.stats.maxSpeed * 3.6)), [80, 120, 160, 200, 300]);
assert.deepEqual(visibleTrainRegistrations.map((train) => train.stats.capacityPerCar), [180, 260, 340, 190, 120]);
assert.deepEqual(visibleTrainRegistrations.map((train) => train.stats.trainOperationalCostPerHour), [160, 220, 300, 420, 600]);
assert.deepEqual(visibleTrainRegistrations.map((train) => train.stats.carOperationalCostPerHour), [12, 16, 20, 25, 30]);
assert.deepEqual(mod.trackClasses.map((trackClass) => trackClass.name), [
  "轻运量 · 80 km/h", "中运量 · 120 km/h", "高运量 · 160 km/h", "城际铁路 · 200 km/h", "高速铁路 · 300 km/h"
]);
assert.deepEqual(mod.compatibility["pvg-ops-high-speed-300"], ["pvg-ops-high-speed-300"]);
assert.ok(mod.compatibility["pvg-ops-heavy-160"].includes("pvg-ops-intercity-200"));
assert.equal(mod.canThroughRun("pvg-ops-heavy-160", "pvg-ops-intercity-200"), true);
assert.equal(mod.canThroughRun("pvg-ops-high-speed-300", "pvg-ops-heavy-160"), false);
assert.equal(mod.canThroughRun("pvg-ops-light-80", "pvg-ops-heavy-160"), true);
assert.equal(mod.getCompatibilityAdvice("pvg-ops-heavy-160", "pvg-ops-intercity-200").compatible, true);
assert.equal(mod.getCompatibilityAdvice("pvg-ops-high-speed-300", "pvg-ops-light-80").compatible, false);
assert.ok(trainRegistrations.every((train) => Object.values(train.stats).every((value) => typeof value !== "number" || Number.isFinite(value))));

const two = mod.createStationTemplate({ templateId: "two-track-island", throatMode: "none", storageTracks: 0 });
assert.equal(two.metadata.physicalTrackCount, 2);
assert.equal(two.platformTrackCount, 2);
assert.equal(two.bypassTrackCount, 0);
assert.equal(two.trackGroups.filter((group) => group.type === "station").length, 1);
assert.equal(two.trackGroups.find((group) => group.type === "station").platformLayout, "island");

const four = mod.createStationTemplate({ templateId: "four-track-double-island", throatMode: "none" });
assert.equal(four.metadata.physicalTrackCount, 4);
assert.equal(four.trackGroups.filter((group) => group.type === "station").length, 2);
assert.equal(new Set(four.trackGroups.filter((group) => group.type === "station").map((group) => group.pvgComplexId)).size, 1);

const singlePlatformComponents = mod.createStationTemplate({ templateId: "four-track-express-bypass", throatMode: "none" });
const singleStationGroups = singlePlatformComponents.trackGroups.filter((group) => group.type === "station");
assert.equal(singleStationGroups.length, 2);
assert.ok(singleStationGroups.every((group) => group.trackLanesType === "single"));
assert.ok(singleStationGroups.every((group) => group.pvgDirectionPolicy === "bidirectional"));
assert.ok(singleStationGroups.every((group) => !("direction" in group) && !("laneDirection" in group) && !("lanes" in group)));
assert.ok(singleStationGroups.flatMap((group) => group.trackIds).every((trackId) =>
  singlePlatformComponents.tracks.find((track) => track.id === trackId).reversable === true
));

const six = mod.createStationTemplate({ templateId: "six-track-express-bypass", throatMode: "double-ladder", storageTracks: 2 });
assert.equal(six.metadata.physicalTrackCount, 6);
assert.equal(six.platformTrackCount, 4);
assert.equal(six.bypassTrackCount, 2);
assert.equal(six.metadata.stationComponents, 2);
assert.equal(six.tracks.filter((track) => track.pvgRole === "express-bypass").length, 2);
assert.equal(six.tracks.filter((track) => track.pvgRole === "storage").length, 2);
assert.equal(six.tracks.filter((track) => track.pvgRole === "crossover").length, 10);
assert.ok(six.tracks.every((track) => track.coords.every((coord) => coord.every(Number.isFinite))));
const crossovers = six.tracks.filter((track) => track.pvgRole === "crossover");
const conflict = mod.evaluatePathConflict(
  [{ trackId: crossovers[0].id }],
  [{ trackId: crossovers[1].id }],
  six.tracks
);
assert.equal(conflict.conflict, true);
assert.ok(conflict.rules.includes("same-throat-zone"));

const regionalPreset = mod.createStationTemplate({
  operationPresetId: "regional-express-hub",
  trackClassId: "heavy",
  name: "市域测试枢纽"
});
assert.equal(regionalPreset.templateId, "six-track-express-bypass");
assert.equal(regionalPreset.turnbackMode, "both");
assert.equal(regionalPreset.storageTracks, 2);
assert.equal(regionalPreset.metadata.supportsTurnback, true);
assert.equal(regionalPreset.metadata.turnbackTrackCount, 2);
assert.equal(regionalPreset.tracks.filter((track) => track.pvgRole === "turnback").length, 2);
assert.equal(regionalPreset.tracks.filter((track) => track.pvgRole === "turnback-lead").length, 4);
assert.equal(regionalPreset.metadata.lanePlan.usesBypassAtSkippedStops, true);
const westStorage = regionalPreset.tracks.find((track) => track.pvgRole === "storage");
const westCrossover = regionalPreset.tracks.find((track) => track.pvgRole === "crossover" && track.pvgConflictZone.endsWith("-A"));
const storageConflict = mod.evaluatePathConflict(
  [{ trackId: westStorage.id }],
  [{ trackId: westCrossover.id }],
  regionalPreset.tracks
);
assert.equal(storageConflict.conflict, true);
assert.ok(storageConflict.rules.includes("storage-mainline-move"));

const localLanePlan = mod.buildLanePlan("four-track-express-bypass", "local");
const expressLanePlan = mod.buildLanePlan("four-track-express-bypass", "express");
assert.deepEqual(localLanePlan.throughLanes, localLanePlan.platformLanes);
assert.deepEqual(expressLanePlan.throughLanes, [1, 2]);
assert.equal(expressLanePlan.samePlatformPairs.length, 0);

const sharedReversible = regionalPreset.tracks.find((track) => track.pvgRole === "platform");
const directionConflict = mod.evaluatePathConflict(
  [{ trackId: sharedReversible.id, direction: "forward" }],
  [{ trackId: sharedReversible.id, direction: "reverse" }],
  regionalPreset.tracks
);
assert.ok(directionConflict.rules.includes("reversible-opposite-direction"));
assert.ok(directionConflict.rules.includes("platform-occupancy"));

const eight = mod.createStationTemplate({ templateId: "eight-track-four-island", throatMode: "scissors" });
assert.equal(eight.metadata.physicalTrackCount, 8);
assert.equal(eight.metadata.stationComponents, 4);
assert.equal(eight.tracks.filter((track) => track.pvgRole === "crossover").length, 28);

const placement = mod.placeTemplate({
  templateId: "eight-track-express-bypass",
  trackClassId: "heavy",
  name: "测试枢纽",
  throatMode: "double-ladder",
  storageTracks: 1
});
assert.equal(placement.success, true);
assert.ok(state.tracks.length > 8);
assert.ok(state.trackGroups.some((group) => group.pvgComplexId === placement.complexId));
assert.ok(notifications.some((item) => item.level === "success"));

assert.deepEqual(mod.buildStopPlan(10, "local"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(mod.buildStopPlan(10, "rapid"), [0, 2, 4, 6, 8, 9]);
assert.deepEqual(mod.buildStopPlan(10, "express"), [0, 3, 6, 9]);

state.routes = [{
  id: "route-1",
  bullet: "R",
  trainType: "pvg-ops-high-speed-300",
  stNodes: [{ id: "a" }, { id: "b" }],
  stCombos: [{ path: [{ trackId: state.tracks.find((track) => track.trackType === "pvg-ops-heavy-160").id }] }]
}];
const incompatibleAudit = mod.auditNetwork();
assert.equal(incompatibleAudit.ok, false);
assert.ok(incompatibleAudit.errors.some((message) => message.includes("不兼容轨道")));

const setMode = mod.setRouteOperatingMode("route-1", "express");
assert.equal(setMode.success, true);
assert.equal(state.routes[0].pvgOperatingMode, "express");
assert.equal(state.routes[0].pvgPreferredTrainType, "pvg-ops-heavy-160");

const planningNodes = Array.from({ length: 10 }, (_, index) => ({ id: "plan-node-" + index, center: [121.4 + index * 0.01, 31.2] }));
state.stations = planningNodes.map((node, index) => ({
  id: "plan-station-" + index,
  name: "规划站" + (index + 1),
  stNodeIds: [node.id],
  routeIds: index === 3 ? ["plan-route", "cross-route"] : index === 6 ? ["plan-route", "cross-route", "regional-route"] : ["plan-route"]
}));
state.stationGroups = planningNodes.map((node, index) => ({
  id: "plan-group-" + index,
  name: "规划站" + (index + 1),
  stationIds: ["plan-station-" + index],
  center: node.center
}));
state.routes = [
  { id: "plan-route", bullet: "规划测试线", trainType: "pvg-ops-medium-120", stNodes: [...planningNodes, ...planningNodes.slice(0, -1).reverse()], stCombos: [] },
  { id: "cross-route", bullet: "换乘测试线", pvgTrackClassId: "light", pvgOperatingMode: "through", stNodes: [planningNodes[3], planningNodes[6]], stCombos: [] },
  { id: "regional-route", bullet: "综合测试线", stNodes: [planningNodes[6]], stCombos: [] }
];
assert.deepEqual(mod.recommendRouteDesign(state, state.routes[0]), { trackClassId: "medium", modeId: "local", trackTypes: [], source: "train" });
assert.deepEqual(mod.recommendRouteDesign(state, state.routes[1]), { trackClassId: "light", modeId: "through", trackTypes: [], source: "saved" });

const renderPanel = () => { global.__PVG_TEST_HOOK_INDEX__ = 0; return panels[0].render(); };
const flatten = (node) => Array.isArray(node) ? node.flatMap(flatten)
  : !node || typeof node !== "object" ? [node] : [node, ...(node.props?.children || []).flatMap(flatten)];
let panelTree = renderPanel();
assert.ok(flatten(panelTree).some((node) => node === "调整速度与发车间隔"));
assert.ok(flatten(panelTree).some((node) => node === "应用为新增服务"));
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "speed")?.props?.value, "medium");
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "advanced")?.props?.open, undefined, "advanced choices must be collapsed initially");
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "station-details")?.type, "details");
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "station-details")?.props?.open, undefined, "long station lists stay collapsed initially");
flatten(panelTree).find((node) => node?.type === "select").props.onChange({ target: { value: "cross-route" } });
panelTree = renderPanel();
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "speed")?.props?.value, "light", "changing routes loads their own settings");
flatten(panelTree).find((node) => node?.type === "select").props.onChange({ target: { value: "plan-route" } });
panelTree = renderPanel();
assert.equal(flatten(panelTree).find((node) => node?.props?.key === "speed")?.props?.value, "medium", "switching back does not leak choices");
const automaticPlan = mod.planRouteStations("plan-route", "rapid", "heavy");
assert.equal(automaticPlan.success, true);
assert.equal(automaticPlan.stations.length, 10);
assert.equal(automaticPlan.isLoop, false);
assert.equal(automaticPlan.stations[2].role, "local");
assert.equal(automaticPlan.stations[3].role, "interchange");
assert.equal(automaticPlan.stations[6].role, "interchange");
assert.equal(automaticPlan.stations[6].trackCount, 6);
assert.equal(automaticPlan.stations[0].role, "local");
assert.deepEqual(automaticPlan.counts, { local: 6, overtake: 2, interchange: 2, integrated: 0 });
assert.ok(automaticPlan.recommendedStops.includes(9), "remote terminus must not be skipped");
assert.equal(automaticPlan.stations[0].trackCount, 2);
const appliedPlan = mod.applyRouteDesign("plan-route", "heavy", "rapid");
assert.equal(appliedPlan.success, false, "without native path confirmation no fake application is allowed");
assert.equal(state.routes.length, 3);

state.tracks = [{ id: "existing-high-speed", trackType: "pvg-ops-high-speed-300" }];
state.routes[0].stCombos = [{ path: [{ trackId: "existing-high-speed" }] }];
const routeBeforeRejectedDesign = state.routes[0];
const rejectedDesign = mod.applyRouteDesign("plan-route", "medium", "local");
assert.equal(rejectedDesign.success, false);
assert.equal(state.routes[0], routeBeforeRejectedDesign, "incompatible choices must not change a save");
assert.equal(mod.recommendRouteDesign(state, state.routes[0]).trackClassId, "high-speed", "actual track compatibility takes precedence over a stale saved class");

state.tracks = [{ id: "legacy-track", trackType: "pvg-ops-maglev-430", pvgOperationalTrackClass: "pvg-ops-maglev-430" }];
state.trackGroups = [{ id: "legacy-group", trackIds: ["legacy-track"], trackType: "pvg-ops-maglev-430" }];
state.routes = [{ id: "legacy-route", trainType: "pvg-ops-maglev-430", pvgPreferredTrainType: "pvg-ops-high-speed-350", carsPerTrain: 4 }];
state.trains = [{ id: "legacy-train", trainType: "pvg-ops-metro-feeder-100" }];
const migration = mod.migrateLegacyOperationsState();
assert.equal(migration.changed, 4);
assert.equal(state.tracks[0].trackType, "pvg-ops-high-speed-300");
assert.equal(state.trackGroups[0].trackType, "pvg-ops-high-speed-300");
assert.equal(state.routes[0].trainType, "pvg-ops-high-speed-300");
assert.equal(state.routes[0].pvgPreferredTrainType, "pvg-ops-high-speed-300");
assert.equal(state.routes[0].carsPerTrain, 8);
assert.equal(state.trains[0].trainType, "pvg-ops-medium-120");

global.__PVG_OPERATIONS_TEST_STATE__ = state;

console.log(JSON.stringify({
  version: mod.version,
  templates: mod.templates.length,
  trainTypes: visibleTrainRegistrations.length,
  temporaryLegacyAliases: trainRegistrations.filter((train) => train.pvgCompatibilityAlias).length,
  stationTypes: stationRegistrations.length,
  placedTracks: state.tracks.length,
  auditErrors: incompatibleAudit.errors.length
}, null, 2));
