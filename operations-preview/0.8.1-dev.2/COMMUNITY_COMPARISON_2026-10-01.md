# Shanghai PVG + Shanghai Operations — concrete differences for review

Review date: 2026-10-01. Map release: **v2.1.0**. Operations source preview: **0.8.1-dev.2**. These are two separate artifacts and version streams. No new map release or approved Railyard listing is implied by this preview.

## What the earlier rejection actually said

[Registry PR #9355](https://github.com/Subway-Builder-Modded/registry/pull/9355) was closed without merge. The [maintainer's comment](https://github.com/Subway-Builder-Modded/registry/pull/9355#issuecomment-5628919738) says: “declined - map has no quality improvements on existing shanghai map”.

That is a **map-data-quality** decision. Train speeds, station templates and operating tools are **gameplay** differences; they do not automatically improve census grain or create measured commute flows. This document separates those questions for review. Differences below are not a claim of superiority in every dimension or an assurance of acceptance.

## 1. Map-data differences from the existing Shanghai listing

Baseline: Registry [`maps/shanghai/manifest.json`](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/maps/shanghai/manifest.json) and [`data-quality.json`](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/maps/shanghai/data-quality.json). Our comparison evidence is the already published [PVG v2.1.0 methodology](https://github.com/LeoVan1412/shanghai-pvg/blob/81b4ab2c457871d6bac2709d24b6df3e35bb4a52/DATA_QUALITY_SUBMISSION.md). These PVG data-method differences were already present in v2.1.0; they are **not newly acquired data in 0.8.1-dev.2**.

| Dimension | Existing Shanghai record | PVG v2.1.0 evidence / limitation |
|---|---|---|
| Resident origin anchor | `total_population`; street/town grain; hybrid footprints | Employed-resident origin estimates use 2020 census district employment rates × 2024 residents, with independent street/town allocation. Huangpu, Changning and Fengxian have finer employment shares. **Not directly measured 2024 employed residents in every street/town.** |
| Workplace placement | Physical-count economic census, `ml_hybrid_footprints`, `binary_split` | Same broad economic-census source family, but ten workplace-sector intensity classes locally calibrated, then spatial controls reconciled. Open footprints are not an official cadastre; legal-entity/head-office limitations remain. |
| Resident placement | Hybrid footprints, `binary_split` | Eight local building/land-use features fitted against 225 controls, with documented cross-validation. Finer model placement is not finer official measurement. |
| Commute constraints | Manifest describes gravity O/D; quality record classifies `od_metric: none` | Doubly constrained synthetic O/D with employed-resident and workplace margins, IPF and integer closure. **Synthetic cells, not observed flows**; a mean-distance fit does not validate individual O/D pairs. |
| Special demand | Listing highlights airports and universities | PVG additionally documents schools, healthcare, retail/dining, hotels, conventions, leisure, industrial shifts, agriculture and secondary trip-chain legs. **Optional special demand does not raise the commute-quality tier by itself.** |
| Underground building geometry | Listing describes a flat −10 m foundation | PVG documents calculated 10–80 m depths and registration in intersected collision cells. A geometry difference, not an improvement to census provenance. |
| Geometry exclusion | No equivalent all-layer audit is stated in the reviewed listing | PVG documents complete exclusion outlines, filtering of facilities, reallocation of district controls and routing on a redacted road graph. No assertion that the other map contains restricted facilities. |

Both projects cover Shanghai's 16 districts and use economic-census/open-geography data. Those shared features are not differentiation. More modeled passengers, larger ZIPs or more features do not by themselves mean better data. The baseline description and machine-derived counts can differ; this comparison deliberately does not cherry-pick their totals.

The last self-reported [PVG questionnaire result](https://github.com/Subway-Builder-Modded/registry/issues/9356#issuecomment-5504812115) was **Medium, pending confirmation**. The existing map's record is **Low with backfill provenance**. These are not equivalent validation states, and this preview does not claim a reviewed High/Very High tier. Classification of PVG's hybrid resident grain and fine-type calibration remains the maintainer's decision.

## 2. Gameplay differences: a separate operations mod

The source preview adds an operations layer, rather than another geographic repaint. Its implemented default workflow is **choose an existing route → inspect stops/map/fleet → apply a separate service → undo that owned service**.

| Player task | Shanghai Operations approach | What is actually available / bounded |
|---|---|---|
| Keep construction choices small | Exactly five PVG track/vehicle classes: 80 / 120 / 160 / 200 / 300 km/h | PVG selectors hide other rolling-stock catalogs temporarily; other maps restore them. This is a deliberate simplified game balance, not an authentic-model collection. |
| Combine stopping and routing policies | Local / fast / express selection is separate from through-operation | Compatible services with a unique connected endpoint can combine policies; nearby stations alone do not prove connected tracks. |
| Plan station roles from a route | Ordinary, passing, transfer and integrated-hub roles inferred from actual station groups/corridors | Existing track conditions constrain application. Missing infrastructure is marked for upgrading, not claimed as already constructed. |
| Build larger station layouts | 2-track single-island, 4-track double-island, 6-track triple-island, 8-track four-island and passing templates | Multiple native platform components model a physical station. Template/developer interfaces are not a replacement for a fully tested public native builder. |
| Decide fleet size before paying | Native round-trip time, shortest platform, inventory and other-route allocation inform formations and fleet estimates | Planned fleet is shown separately from actual native deployment. Purchase requires an explicit priced action. This is not demand-optimal automatic scheduling. |
| Apply a plan without replacing the old line | Native routing creates a separate owned service and departure plan | Original route/trains retained; feasible capacity and native signals still govern departures. Zero-fleet services may retry a free connected endpoint; no forced spawning. |
| Roll back | Persisted ownership receipts; undo only the new service/managed construction | Later manual edits stop unsafe undo; purchased cars remain in stock, without invented refunds. |
| Keep planning responsive | Infrastructure-based indexes, actual-track map preview, expandable detail | Does not constantly rebuild planning indexes for every moving train; no blanket FPS guarantee. |
| Repair passing/egress behavior | Bounded wait, native reservations/body protection, verified forward exit and exact tail-clear proof | **Development interfaces only**, not enabled automatically in the public workflow; targeted native test passed, broader acceptance pending. |

### Distinction from related community mods

These are comparisons to published descriptions, **not exhaustive source-code audits**. We do not claim that similar functionality is impossible in other mods or unique worldwide.

- [Chinese Trains](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/chinese-trains/manifest.json) emphasizes many named real rolling-stock types. Our emphasis is a small five-tier PVG catalog integrated with service/station/fleet planning, not more authentic train models.
- [Intercity, HSR & Express Metro Trains](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/intercity-hsr-trains/manifest.json) adds three dedicated train/track classes. Our additional scope is stop-policy + through-service composition, station-role planning, native service application and ownership-aware undo. Higher speeds alone are not our novelty.
- [Mode Manager](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/mode-manager/manifest.json) already provides per-save mode curation and custom modes. We acknowledge that overlap. Our focus is the combined **route/service** workflow and its native operational checks, not inventing mode selection.
- [Citymapper](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/citymapper/manifest.json) describes importing OSM track construction for realism. Our workflow designs services on existing playable track geometry; demand-oriented design is not presented as an official 2030 network.
- [Train Anarchy](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/train-anarchy/manifest.json) relaxes rolling-stock limits; [Track Anarchy](https://github.com/Subway-Builder-Modded/registry/blob/b8c366ae96cb350bcc933eb5dc955856d4738770/mods/track-anarchy/manifest.json) relaxes construction limits. Our candidate retains actual native reservations, physical train bodies and bounded exit safety. It does not disable collision/claim protection to produce passing.

## 3. What changed specifically since local v0.8.0

1. **Actual passing gate:** approach is measured to the real independent bypass **entry**, rather than the far downstream merge. Distance + native dwell forecasts reject waits exceeding the unchanged budget; forecasts never release a held train.
2. **Forward exit safety:** when one leg cannot provide train length + 25 m, exactly one verified forward native leg can supply the remainder. Exact directed path continuity, native arrival and real nonempty body windows are required; merely reaching the next station does not clear the tail.
3. **Native clone-batch compatibility:** hold dwell identification survives normal/fast/ultrafast native batches. Temporary descriptors restore even on errors; no extra physics ticks are executed.
4. **T1 platform-egress deadlock:** optional scoped handling permits a real platform-resident train to leave while an incoming train holds the platform reservation. Incoming full-platform protection, body occupancy and junction resources remain intact; no native claim is cleared and no existing train is teleported/deleted.
5. **Reload and mutation safety:** dispatch memory resets for elapsed-time reversal or a new topology at the same time; ownership reads honor even old/orphan native reservations.
6. **Owned native construction/service undo:** targeted loaded-game add-only bypass construction, native routing/fleet deployment, separate-service undo and construction undo were exercised. This is not full automatic 4/6/8-track station rebuilding in the player UI.

## 4. Evidence and honest acceptance boundary

The [public sanitized QA summary](review-evidence/r16-summary.json) identifies the exact tested runtime source:

`bba8166cc1af74238d27e5e8a510c9249b578752bd9fa762a73fe78fbef510b3`

Subway Builder **1.7.2**, loaded Shanghai save, 43 original routes / 228 original trains; **7,368 simulated seconds**, 921 dispatch frames, 8 native new trains, 384 native arrivals, 24 native completed-journey records. There were 5 holds and **3 independently verified tail-clear-then-same-slow-departure events**; the other 2 lack sufficient continuous proof and are not counted as successes. Both previously failing T1 trains survived with 33/44 actual post-start arrivals. Zero original-train timeout removals/missing trains and zero body overlaps in finite observations.

Undo preserved original track geometry, track groups, route structure and inventory. After normal exit/cold reload, all nine complete persisted layers matched the original progress, and the original installed v0.8.0 was restored. Decision time was last 8.3 ms / observed peak 17.6 ms; **not a rendered FPS measurement**. Prior r13–r15 failures remain failures, not overwritten successes.

This was a **targeted two-hour game-time acceptance**, not an all-day/full-passenger-cycle test, independent live control, stress guarantee at arbitrarily large scale, or comprehensive station/throat/interlocking certification. `publishReady=false` remains explicit.

Raw native code, private saves, raw logs, personal paths and facility metadata are excluded from this public preview. The runtime carries only anonymous exclusion geometries needed for construction checks. The preview does not ship or advertise the latest prebuilt network save.

## Requested review decision

Please assess the combined route/station/fleet workflow as a **separate gameplay-mod review track**, and state the acceptance evidence required before a public Railyard mod submission. Separately, if PVG map-data reconsideration is possible, please specify which source grain/intensity/O/D dimension must improve beyond the already-declined v2.1.0 evidence. We are not requesting that gameplay changes bypass map-data requirements or reopen/merge the rejected PR automatically.

## 中文摘要

最重要的差异是“从地图数据包扩展为可撤销的线路运营工作流”，而不是换个名字、增加乘客数量或把速度调高。线路停站与直通可以组合，规划可实际建立独立原生服务，配车建议区分计划与实际出库，撤销只处理本方案。五档目录与 2/4/6/8 股道模板降低操作复杂度。

最新动态越行、站台离站保护和自动接轨仍是开发能力：两小时专项中确认 3 次真实越行、原 T1 零超时，但未完成长周期和所有站型验收，也未自动启用于普通游戏。既有 v2.1.0 的就业居民、细类型标定和双约束 O/D 可作为地图方法差异提出，但不是本次刚获得的新数据，不能宣称最高评级或保证复审通过。提交目的为源码与差异预审，不替换正式版本。
