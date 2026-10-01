"use strict";
const assert = require("node:assert/strict");
require("./test_operations_mod.js");
const mod = global.__PVG_OPERATIONS__, state = global.__PVG_OPERATIONS_TEST_STATE__;
const combo = { path: [{ trackId: "t", reversed: true, length: 100, signals: [] }], distance: 100 };
const train = { id: "a", routeId: "r", stComboOverrides: { 0: combo }, motion: { speed: 4 }, timings: [1],
  windows: { train: { tracks: [{ trackId: "t", headProgress: 80, tailProgress: 60 }], signalIds: [] } } };
Object.assign(state, { routes: [{ id: "r", stCombos: [combo] }], trains: [train], timeConfig: { elapsedSeconds: 100 },
  signals: [{ id: "merge", signalTracks: [{ trackId: "t", areaCovered: { start: 70, end: 90 } }], status: { occupations: [{ trainId: "old", timeVerified: 100 }], reservedBy: { trainId: "other", timeVerified: 100 } } }],
  setSignals({ signals }) { this.signals = signals; } });
const repaired = mod.repairSharedSectionSignals();
assert.equal(repaired.success, true);
assert.equal(repaired.changedParts, 2);
assert.deepEqual(state.routes[0].stCombos[0].path[0].signals[0].areaCovered, { start: 70, end: 90 }, "reverse paths use physical coordinates, not mirrored signal areas");
assert.equal(state.trains[0].motion, train.motion); assert.equal(state.trains[0].timings, train.timings);
assert.equal(state.trains[0].windows.train.tracks[0].headProgress, 80);
assert.deepEqual(state.signals[0].status.occupations.map(o => o.trainId), ["old", "a"]);
assert.equal(state.signals[0].status.reservedBy.trainId, "other", "never clear a native reservation");
const previous = state.trains[0];
assert.equal(mod.repairSharedSectionSignals().changedParts, 0); assert.equal(state.trains[0], previous);
state.trains = ["a", "b"].map(id => ({ id, routeId: id, motion: { speed: 0 }, currentStComboInfo: { timeAtStop: null }, windows: { warning: { tracks: [], signalIds: [id === "a" ? "sb" : "sa"] } } }));
state.signals = ["a", "b"].map(id => ({ id: "s" + id, status: { occupations: [{ trainId: id, timeVerified: 100 }], reservedBy: null } }));
let diagnostic = mod.snapshotDispatchConflicts(state);
assert.equal(diagnostic.cycles.length, 1); assert.deepEqual(diagnostic.cycles[0].sort(), ["a", "b"]);
state.signals[0].status.occupations[0].timeVerified = 98;
assert.equal(mod.snapshotDispatchConflicts(state).cycles.length, 0, "stale occupations do not prove a live deadlock");
state.signals[0].status.occupations[0].timeVerified = 100;
state.trains[0].currentStComboInfo.timeAtStop = 90;
assert.equal(mod.snapshotDispatchConflicts(state).cycles.length, 0, "normal station dwell is not a signal wait");
console.log(JSON.stringify({ success: true, tests: "signal coverage, physical intervals, alternate paths, occupied-resource preservation, idempotence, mutual waits, stale records, normal dwell" }));
