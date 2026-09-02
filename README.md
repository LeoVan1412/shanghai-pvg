# 上海 (Shànghǎi) — PVG

![Shanghai PVG cover](assets/cover-v2.1.0-selected.png)

A high-detail bilingual Shanghai map for **Subway Builder** and **Railyard**, authored by **LeoVan**.

由 **LeoVan** 制作的上海高精度双语地图，适用于 **Subway Builder** 与 **Railyard**。

## Download / 下载

- [Shanghai-PVG-v2.1.0.zip](https://github.com/LeoVan1412/shanghai-pvg/releases/latest/download/Shanghai-PVG-v2.1.0.zip)
- [manifest.json](https://github.com/LeoVan1412/shanghai-pvg/releases/latest/download/manifest.json)
- [Latest release notes / 最新发布说明](https://github.com/LeoVan1412/shanghai-pvg/releases/latest)

Map ZIP SHA-256: `3bb2dbec2b650a92eed5814197757f3930062215c63cc843cb620946884345b4`

## Highlights / 主要特性

- Complete coverage of all 16 Shanghai districts, with geographic-only context in surrounding Jiangsu and Zhejiang.
- Real roads, water, land use, administrative boundaries, place labels, buildings, foundations, and collision data.
- 13,001,675 official-census-derived employed residents, closed exactly across all 16 districts and 225 street/town areas.
- 15,243,400 modeled people across 15,050 non-phantom demand points and 76,217 fixed 200-person groups.
- 100% precomputed coverage for all 73,904 unique origin/destination pairs.
- Doubly constrained workplace O/D with zero origin/destination margin error; mean routed commute 10.3965 km against the official 10.2 km.
- Complete 220-component sensitive-area redaction across map geometry, facilities, demand, paths, and collision data, with automatic zero-overlap tests.
- A separately packaged 2030 stress builder covers 36 services, detailed operating alignments, the shared Line 3/4 corridor, regional rail, and a non-linear Maglev route.
- Hybrid building allocation with locally calibrated residential and workplace fine types; checked Registry score 0.6475875, provisionally **High**.
- People-only demand: freight tonnage, container throughput, and agricultural output are never converted into passengers.
- Source and license records are included in the map package; visible attribution is preserved below.

- 覆盖上海全部 16 个区，江苏、浙江周边区域仅作为地理背景，不生成客流。
- 包含真实道路、水体、土地利用、行政边界、地名、建筑、地基与碰撞数据。
- 新增从官方人口普查推导的 13,001,675 名就业居民，并在 16 区、225 个街镇空间单元精确闭合。
- 模拟 15,243,400 人、15,050 个非空需求点及 76,217 个固定 200 人出行组。
- 全部 73,904 个唯一 O/D 组合均已预计算道路路径。
- 就业通勤采用双约束 O/D，起终点边际误差均为 0；道路平均距离 10.3965 公里，对应官方 10.2 公里。
- 对 220 个完整敏感区域组件执行地图几何、设施、需求、路径及碰撞数据的全层面脱敏，并加入零重叠自动测试。
- 2030 线网压力测试构建器独立打包，覆盖 36 条服务、现状线路详细走向、3/4 号线共线、市域线路及非直线磁浮走向。
- 混合来源建筑落点与本地标定的居民/岗位细分类型；Registry 检查计算为 0.6475875，预期 **High**。
- 只模拟人员出行；货运吨位、集装箱吞吐量及农业产量不会直接转换为乘客。

See [DESCRIPTION.md](DESCRIPTION.md) for the full bilingual description,
[DATA_SOURCES.md](DATA_SOURCES.md) for source details, and
[DATA_QUALITY_SUBMISSION.md](DATA_QUALITY_SUBMISSION.md) for the transparent
Registry scoring evidence and limitations.

## Launch requirement / 启动要求

Launch Subway Builder with Railyard's **Launch** button. PVG uses the local tile service started by Railyard. Launching the game directly from Steam can leave only cached roads visible while land, parks, and water appear white.

请始终通过 Railyard 的 **Launch** 按钮启动 Subway Builder。PVG 依赖 Railyard 同步启动的本地瓦片服务；直接从 Steam 启动可能只显示缓存道路，而陆地、绿化和水域变成白底。

## Gallery / 图库

### Yangtze estuary and islands / 长江口与岛屿

![Yangtze estuary and islands](assets/gallery/04-shanghai-estuary-islands-2d-final.jpeg)

### Central Shanghai 2D / 上海中心城区 2D

![Central Shanghai 2D](assets/gallery/05-shanghai-central-2d-final.png)

### Central Shanghai 3D / 上海中心城区 3D

![Central Shanghai 3D](assets/gallery/06-shanghai-central-3d-final.png)

### Lujiazui landmark plan view / 陆家嘴地标平面图

![Lujiazui 2D landmarks](assets/gallery/07-shanghai-lujiazui-2d-landmarks-final.png)

### Lujiazui landmark detail / 陆家嘴地标细节

![Lujiazui 3D landmarks](assets/gallery/08-shanghai-lujiazui-3d-landmarks-detail.png)

## Attribution and licenses / 署名与许可

Map data © OpenStreetMap contributors — ODbL 1.0. Building footprints © Overture Maps Foundation and upstream contributors — ODbL 1.0. Ocean-depth shading: GEBCO Compilation Group (2024), GEBCO 2024 Grid, doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f.

See [ATTRIBUTION.md](ATTRIBUTION.md), [CREDITS.md](CREDITS.md), [LICENSE](LICENSE), and [LICENSE-DATA.md](LICENSE-DATA.md).
