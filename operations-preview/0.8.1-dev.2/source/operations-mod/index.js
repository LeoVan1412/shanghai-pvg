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
