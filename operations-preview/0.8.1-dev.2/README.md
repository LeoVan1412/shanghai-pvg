# Shanghai Operations 0.8.1-dev.2 — source review preview

Development-only snapshot. **Not a Railyard release or approved listing. `publishReady=false`.**

- [Concrete comparison with existing Shanghai and related mods](COMMUNITY_COMPARISON_2026-10-01.md)
- [Scoped test evidence, sanitized](review-evidence/r16-summary.json)
- [Current candidate capabilities and limitations](leovan-shanghai-operations/README.md)
- [Community pre-review request](COMMUNITY_REVIEW_REQUEST_2026-10-01.md)

`leovan-shanghai-operations/index.js` is the exact clean r16-tested bundled runtime. `source/` contains own-code components and synthetic offline regressions for review. No test driver, native game source, private save, raw log or latest prebuilt network save is included. Advanced construction/passing/egress interfaces are not enabled automatically.

Offline review tests require Node.js with structuredClone support (Node 18+):

```sh
node source/scripts/test_operations_mod.js
node source/scripts/test_service_planner.js
node source/scripts/test_dispatch_core.js
node source/scripts/test_dispatch_index.js
node source/scripts/test_expansion_core.js
node source/scripts/test_expansion_transaction.js
node source/scripts/test_dispatch_safety.js
```

地图 v2.1.0 和运营模组 0.8.1-dev.2 分别版本化。此源码预览不替换正式地图、安装或玩家进度，也不表示社区审核通过。
