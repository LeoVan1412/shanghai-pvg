# Shanghai PVG / Shanghai Operations — request for differentiated review guidance

Hello maintainers,

I am following up on [map PR #9355](https://github.com/Subway-Builder-Modded/registry/pull/9355), declined because it did not provide a map-quality improvement over the existing Shanghai map. I would like to clarify the scope of subsequent work and ask which review route is appropriate.

The new **Shanghai Operations 0.8.1-dev.2** work is a separate PVG-only gameplay layer: route-first local/fast/express + compatible through-services, infrastructure-aware station-role planning, a five-tier 80/120/160/200/300 km/h catalog, 2/4/6/8-track template interfaces, fleet/inventory guidance, native creation of separate services and ownership-aware undo. It keeps original routes/trains and distinguishes missing infrastructure and planned fleet from actual construction/deployment. These are not merely more train types or higher speeds; the main difference is the integrated, reversible **route → station → fleet → native service** workflow.

The latest development-only passing/egress fixes have a loaded-game test on Subway Builder 1.7.2: 43 original routes / 228 original trains, 7,368 simulated seconds, 8 native new trains, 3 independently verified overtakes with actual slow departure after fast tail clearance, and zero original-train timeout removals. Five holds occurred; two without sufficient continuous proof are not counted. Original tracks/groups/route structure/inventory survived undo, and nine complete data layers matched after cold recovery. Exit protection still requires train length + 25 m, actual path continuity and body evidence. No claims were cleared, trains teleported, or 900-second threshold relaxed.

These advanced interfaces are **not enabled automatically**. Full-cycle/long-duration and larger-network/multiple-layout acceptance is still pending; **publishReady=false**. This is a development source preview and request for pre-review, not a ready-to-publish map/mod intake, not a claim of Railyard approval, and not a request to merge/reopen the rejected PR automatically.

For map data, PVG v2.1.0 documented census-based employed-resident origin estimates, fine calibrated building-type intensities and doubly constrained synthetic commute margins, whereas the existing Shanghai quality record describes total residents, binary placement and no scored O/D. Those differences were already present in v2.1.0, remain subject to grain/provenance limitations, and do not constitute newly observed flow data. I am not asking gameplay features to substitute for data-quality evidence, or claiming a confirmed High/Very High rating.

Could you please advise:

1. Should this integrated operations workflow be submitted separately through **Publish New Mod** after the remaining acceptance work?
2. Because the current implementation is scoped to unlisted PVG, is extending support to the existing SHA map a prerequisite for useful mod intake, or can a separately reviewed PVG companion be considered?
3. If a PVG map reconsideration is possible, which concrete data-quality dimension requires additional evidence or new measured data beyond v2.1.0?

The development PR will link a detailed comparison, clean runtime source and a sanitized QA summary. No private save, native game source, raw log or personal path is included. The current published v2.1.0 release and local stable installation remain unchanged.

Thank you.
