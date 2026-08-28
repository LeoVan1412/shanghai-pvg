# 上海 (Shànghǎi)

**PVG · v2.0.0**
**by LeoVan**

上海全域高细节地图，覆盖全部 16 个区，并提供江苏、浙江及长江口方向的长三角地理背景。上海市外区域只作为道路、建筑、水系、土地利用、行政边界和地名背景，不生成本地图的常住人口或就业需求。

A high-detail map of all 16 districts of Shanghai, with geographic context extending into neighboring Jiangsu, Zhejiang, and the Yangtze River estuary. Areas outside Shanghai provide roads, buildings, water, land use, administrative boundaries, and place labels only; they generate no resident or employment demand in this map.

## Coverage / 覆盖范围

- **Shanghai administrative area / 上海行政区域面积:** 6,340.50 km²
- **Demand area / 需求范围:** all 16 Shanghai districts / 上海全部 16 个区
- **Display context / 地图背景:** 119.48°E–122.29°E, 30.63°N–32.09°N
- **Outside-Shanghai demand / 上海市外需求:** none / 无

## Population and Demand / 人口与需求

- **Official resident population (2024) / 2024 年官方常住人口:** 24,802,600
- **Official legal-entity employment control / 法人单位从业人员控制量:** 13,099,632
- **Modeled people on a typical weekday / 典型工作日建模人数:** 15,243,400
- **Demand points / 需求点:** 10,249
- **Population groups / 出行人口组:** 76,217
- **Group size / 每组人数:** 200 (uniform / 固定)
- **Phantom demand points / 空需求点:** 0

The modeled figure is a calibrated daily-equivalent travel population, not a claim that every Shanghai resident or employee travels every day. Workplace attendance, student attendance, visitors, business trips, and local activities are modeled separately to avoid double counting.

建模人数表示经过校准的“典型工作日等效出行人口”，并不表示所有居民和从业人员每天都会出行。通勤到岗、学生到校、访客、商务活动和本地生活出行分别建模，以减少重复计算。

### Modeled Purpose Allocation / 建模出行目的分配

Each person belongs to exactly one routed O/D group in this partition; the rows therefore sum to 15,243,400 without duplicating the same person between categories.

在这一分组中，每名建模人员只属于一个已寻路的 O/D 人口组；下列各项合计恰为 15,243,400，不会在类别之间重复计数。

| Purpose family / 出行目的类别 | Modeled people / 建模人数 |
|---|---:|
| Sector workplace commuting / 分行业常规通勤 | 8,970,000 |
| Industrial and logistics shift commuting / 工业与物流轮班通勤 | 1,059,400 |
| School and university students / 中小学与大学学生 | 2,310,000 |
| Airport, intercity rail, and passenger-port movements / 机场、城际铁路与客运码头到发 | 910,800 |
| Local resident activities / 本地居民生活出行 | 990,000 |
| Explicit business, industrial, and hotel links / 明确建模的商务、工业与酒店联络 | 400,000 |
| Agriculture-related people movements / 农业相关人员出行 | 60,000 |
| Trip-chain secondary legs / 出行链次级出行 | 543,200 |
| **Total / 合计** | **15,243,400** |

Trip chains add the secondary legs that real Shanghai shows between the rush-hour peaks: office lunch dining, after-work retail and leisure, university student dining and leisure, and tourist/convention dining and retail (9 chain purposes). Each chain leg is an independent person-group O/D pair; freight volumes are never used.

出行链补充了上海两个高峰之间真实存在的次级出行：办公楼午餐餐饮、下班后购物与休闲、大学生餐饮与休闲、游客与会展餐饮和购物（共 9 类出行链）。每段出行链都是独立的人员 O/D 人口组，绝不使用货运量数据。

## Map Statistics / 地图统计

- **Buildings indexed / 建筑索引:** 2,517,010
- **Buildings inside Shanghai / 上海市内建筑:** 1,429,620
- **Regional-context buildings / 市外背景建筑:** 1,087,386
- **Named facilities / 具名设施:** 23,296
- **Road features / 道路要素:** 338,721
- **Runway and taxiway features / 跑道与滑行道要素:** 1,675
- **Precomputed O/D routes / 预计算 O/D 道路路径:** 75,156 unique pairs / 个唯一组合
- **Route coverage / 路径覆盖率:** 100%
- **Median routed distance / 道路距离中位数:** 19.67 km
- **Mean routed distance / 道路距离平均值:** 23.99 km
- **Maximum road snap distance / 最大道路吸附距离:** 0.984 km

### Facility Catalogue / 设施目录

| Facility category / 设施类别 | Indexed locations / 已索引地点 |
|---|---:|
| Schools / 学校 | 3,080 |
| Universities / 大学 | 186 |
| University towns / 大学城 | 1 |
| Healthcare / 医疗机构 | 510 |
| Offices / 办公机构 | 1,757 |
| Research centers / 研发中心 | 99 |
| Industrial sites / 工业场所 | 1,542 |
| Logistics sites / 仓储物流场所 | 31 |
| Retail / 零售 | 5,272 |
| Dining / 餐饮 | 5,803 |
| Hotels / 酒店 | 851 |
| Attractions / 景点 | 711 |
| Parks and scenic areas / 公园与风景区 | 721 |
| Entertainment / 娱乐 | 125 |
| Performance venues / 演出场所 | 127 |
| Sports facilities / 运动场馆 | 261 |
| Convention venues / 会展场所 | 30 |
| Farms and agricultural parks / 农场与农业园区 | 68 |
| Agricultural services / 农业服务 | 19 |
| Agricultural markets / 农产品市场 | 12 |
| Food processors / 食品加工场所 | 2 |
| Airport, rail, and passenger-port gateways / 机场、铁路与客运码头枢纽 | 23 |
| Urban transit facilities / 城市公共交通设施 | 764 |
| Public services / 公共服务 | 1,301 |

## Special Demand / 特殊出行需求

### Airports and External Gateways / 机场与对外枢纽

- **Shanghai Pudong International Airport (PVG) / 上海浦东国际机场:** 195,400 modeled landside people per day / 每日建模陆侧人员
- **Shanghai Hongqiao International Airport (SHA) / 上海虹桥国际机场:** 137,400 modeled landside people per day / 每日建模陆侧人员
- **Intercity railway stations / 城际铁路车站:** 566,000 modeled arrivals and departures per day / 每日建模到发人员
- **Passenger ports / 客运码头:** 12,000 modeled arrivals and departures per day / 每日建模到发人员

Trips whose real destination lies outside Shanghai terminate at a real Shanghai airport terminal, intercity railway station, or passenger port. External visitors are distributed from those gateways to hotels, attractions, offices, industrial areas, convention venues, hospitals, universities, and residences.

实际目的地位于上海市外的行程，会在上海境内真实的机场航站楼、城际铁路车站或客运码头结束。外来访客则从这些枢纽前往酒店、景区、办公楼、产业园和工厂、会展中心、医院、大学及居住地。

### Work, Business, and Industry / 通勤、商务与工业

The map includes ordinary workplace commuting and explicit person-trip links for:

本地图除常规通勤外，还明确包含以下人员出行关系：

- office → office; headquarters → branch / 办公楼→办公楼、总部→分支机构
- office → factory; factory → research center; factory → factory / 办公楼→工厂、工厂→研发中心、工厂→工厂
- hotel → office, industrial park, and convention center / 酒店→办公楼、产业园和会展中心
- airport or railway station → industrial park, factory, and convention center / 机场或火车站→产业园、工厂和会展中心
- industrial and logistics shift commuting / 工业园区、仓库和物流园轮班通勤
- workers traveling between factories, warehouses, logistics parks, port areas, airport cargo areas, and railway freight terminals / 工厂、仓库、物流园与港区、机场货运区、铁路货站之间的工作人员出行

Selected explicit O/D allocations are: office → office 80,000; headquarters → branch 40,000; office → factory 60,000; factory → research center 30,000; factory → factory 50,000; logistics sites → port/air/rail cargo workplaces 20,000; hotel → office/industrial park/convention center 60,000 in total; and airport/rail arrival → industrial area 41,400 plus convention center 35,000.

部分明确建模的 O/D 人数为：办公楼→办公楼 80,000；总部→分支机构 40,000；办公楼→工厂 60,000；工厂→研发中心 30,000；工厂→工厂 50,000；物流场所→港区/机场/铁路货运岗位 20,000；酒店→办公楼/产业园/会展中心合计 60,000；机场或铁路到达→产业区 41,400，另有→会展中心 35,000。

### Agriculture / 农业相关人员出行

- rural residents → farms, cooperatives, and agricultural parks / 农村居民→农场、合作社和农业园区
- farm business staff → agricultural wholesale markets and food processors / 农场业务人员→农产品批发市场和食品加工厂
- agricultural research, training, procurement, maintenance, and repair services / 农业科研、培训、采购、维护和维修服务人员

Agriculture-related allocations total 60,000 people: 40,000 rural resident → farm/cooperative/agricultural park; 8,000 farm → agricultural wholesale market; 4,000 farm → food processor; 4,000 research/training; and 4,000 procurement/maintenance/repair.

农业相关分配合计 60,000 人：农村居民→农场/合作社/农业园区 40,000；农场→农产品批发市场 8,000；农场→食品加工厂 4,000；科研/培训 4,000；采购/维护/维修服务 4,000。

### Education, Health, Leisure, and Tourism / 教育、医疗、生活与旅游

Demand includes schools, universities and university towns, hospitals, commercial districts, offices, factories, parks, scenic areas, restaurants, retail, entertainment, performance venues, sports facilities, hotels, and convention centers. It covers local visits to attractions, visitors arriving through external gateways, and hotel-to-attraction travel.

需求覆盖学校、大学与大学城、医院、商圈、办公楼、工厂、公园、景区、餐饮、零售、娱乐、演出场所、运动场馆、酒店和会展中心；同时包括市内居民前往景区、外来游客从交通枢纽前往景区，以及酒店到景区的出行。

## People-Only Rule / 仅模拟人员出行

This map models people, not cargo. Freight tonnage, container counts, warehouse throughput, agricultural output, sales turnover, floor area, and venue capacity never create passengers directly. They may only help place or weight a destination after a separate people total has been defined.

本地图只模拟人员出行，不模拟货运量。货运吨位、集装箱数量、仓库吞吐量、农产品产量、销售额、建筑面积和场馆容量均不会直接换算成地铁乘客；这些指标最多只能在已经独立确定人员总量后，用于选择或分配目的地。

## Geography and 3D / 地理与 3D

- Water is a dedicated OSM-derived layer; park and commercial polygons are subtracted from water before tiling, preventing white land-use overlays on rivers. / 水体采用独立 OSM 图层，公园和商业用地在制瓦片前已从水体中扣除，避免河流被白色用地图层覆盖。
- Buildings whose centroids fall inside mapped water are excluded. / 中心点位于已映射水体内的建筑会被剔除。
- All buildings use the game's common theme color; no small subset receives custom color properties. / 所有建筑使用游戏统一主题色，不会再出现只有少数建筑单独着色。
- The stock game reads building `height` but not an above-ground start height, so the base pack avoids unsupported vertically stacked fragments. Shanghai Tower, Jin Mao Tower, and SWFC each use one fallback footprint. Oriental Pearl uses one mast footprint plus its three real support footprints; all four carry the same landmark tag and are masked together when the companion renderer is enabled. / 游戏原生建筑层只读取高度，不读取离地起始高度，因此基础包不再使用不受支持的上下分段。上海中心、金茂大厦和上海环球金融中心各使用一份后备占地；东方明珠使用一份主桅杆占地和三份真实支撑柱占地，四者使用同一个地标标记，并会在启用配套渲染模组时一并遮罩。
- Landmark locations and total heights are fixed for Oriental Pearl Tower (468 m), Shanghai Tower (632 m), Shanghai World Financial Center (492 m), and Jin Mao Tower (420.5 m). / 东方明珠（468 米）、上海中心（632 米）、上海环球金融中心（492 米）和金茂大厦（420.5 米）均采用真实位置和总高度。
- Building foundations carry calculated depths of 10–80 m and every large footprint is registered in all intersecting collision cells. / 建筑地基深度为 10–80 米，大型建筑会登记到所有相交碰撞格网。

### Optional Landmark Renderer / 可选地标渲染模组

For the most detailed skyline, install the separate **Shanghai Landmarks / 上海地标** companion mod (`leovan-shanghai-landmarks`) together with this map. The map remains fully playable without JavaScript; the companion replaces only the four explicitly tagged fallback footprints with a single clean-room WebGL mesh for each landmark. It runs only in PVG, leaves ordinary building colors under the game's theme control, and does not alter any other city.

When enabled, the companion also applies the map's calibrated Shanghai commute-time profile (morning and evening peaks, midday dining bump, late-night tail; airport and student dampening curves) and gives every new station a smart Chinese name drawn from nearby key buildings (airports, railway stations, ferry terminals, universities, hospitals, convention venues, attractions, parks) and suburban town names, with road-name fallback. Station names are derived from the map's own facility and boundary data — never from the real Shanghai Metro network.

如需最完整的天际线效果，请将独立的 **Shanghai Landmarks / 上海地标** 配套模组（`leovan-shanghai-landmarks`）与本地图一同安装。即使不启用 JavaScript，本地图也可正常游玩；配套模组只会把四个已明确标记的后备占地分别替换为一份从零制作的 WebGL 地标模型。它仅在 PVG 生效，普通建筑仍由游戏主题统一配色，也不会修改其他城市。

启用后，配套模组还会应用本地图校准后的上海出行时间分布（早晚高峰、午间餐饮小高峰、深夜客流尾部；机场与学生出行衰减曲线），并依据附近关键建筑（机场、火车站、码头、大学、医院、会展场所、景点、公园）和郊区镇名，为每个新建车站智能命名，并以道路名称作为兜底。车站名称全部来自本地图自身的设施与行政区划数据，绝不照搬真实上海地铁线网。

- Oriental Pearl Tower / 东方明珠广播电视塔 — 468 m
- Shanghai Tower / 上海中心大厦 — 632 m
- Jin Mao Tower / 金茂大厦 — 420.5 m
- Shanghai World Financial Center / 上海环球金融中心 — 492 m

## Methodology / 方法

1. **Official controls / 官方控制量** — 2024 district resident population, detailed subdistrict population sources, and Fifth National Economic Census employment tables were normalized into exact Shanghai controls. / 使用 2024 年各区常住人口、街镇人口资料和第五次全国经济普查从业人员表，建立精确控制量。
2. **Spatial assignment / 空间分配** — official controls were matched to 225 street, town, township, development-zone, farm, and forestry-area geometries. / 将官方控制量匹配到 225 个街道、镇、乡、开发区、农场和林场空间单元。
3. **300 m grid / 300 米网格** — population and employment were disaggregated using real buildings, land use, facilities, roads, and official spatial weights, then reconciled exactly to every control. / 使用真实建筑、土地利用、设施、道路和官方空间权重，将人口与就业分配到 300 米网格，并逐控制区精确闭合。
4. **Facility catalog / 设施目录** — 23,296 named locations were classified by their person-trip functions. Facilities are destinations, not independent people totals. / 按人员出行功能分类 23,296 个具名地点；设施只作为目的地，不自行创造人数。
5. **Demand synthesis / 需求合成** — a deterministic typical-weekday model generated fixed 200-person groups for commuting, education, business, external gateways, tourism, healthcare, retail, dining, entertainment, sports, hotels, conventions, industry, logistics, and agriculture. / 使用确定性的典型工作日模型，以每组 200 人生成通勤、教育、商务、对外枢纽、旅游、医疗、零售、餐饮、娱乐、体育、酒店、会展、工业、物流和农业需求。
6. **Road routing / 道路寻路** — all 75,156 unique O/D pairs were routed on the extracted regional OSM road graph and stored as simplified driving paths. / 所有 75,156 个唯一 O/D 组合均在区域 OSM 道路图上预计算，并保存为简化后的道路路径。
7. **Basemap and buildings / 底图与建筑** — real OSM water, land use, roads, boundaries, and labels were combined with Overture building footprints. / 将真实 OSM 水体、土地利用、道路、边界和地名与 Overture 建筑轮廓结合。

## Sources / 数据来源

All source data used for this clean-room rebuild is freely available. Exact URLs, permitted uses, hashes, and limitations are recorded in the source registries distributed with the source project.

本次从零重制使用的数据均可公开获取；精确链接、许可用途、文件哈希和限制均记录在源项目的数据来源登记表中。

- [Shanghai Statistical Yearbook 2025 — district area and 2024 population](https://tjj.sh.gov.cn/tjnj/2025tjnj/C0202.htm)
- [Shanghai Fifth National Economic Census — city employment](https://tjj.sh.gov.cn/cmsres/b3/b36d6d16841e4ac0a64a2e6664c69833/85fdf28606c6847035976a586d8d028d.pdf)
- [Shanghai airport 2025 annual report](https://star.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-04-30/600009_20260430_BK10.pdf)
- [Shanghai Statistical Yearbook 2025 — education](https://tjj.sh.gov.cn/tjnj/tjnj2025.htm)
- [OpenStreetMap](https://www.openstreetmap.org/) — ODbL 1.0
- [Overture Maps Foundation](https://overturemaps.org/) — buildings theme, ODbL 1.0
- [GEBCO 2024 Grid](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use) — public domain under the GEBCO Terms of Use; source acknowledgement required
- [Geofabrik China extracts](https://download.geofabrik.de/asia/china.html)
- [OSRM](https://project-osrm.org/) — precomputed road paths
- Building contributors represented through Overture include OpenStreetMap contributors, Esri Community Maps contributors, Microsoft Global ML Building Footprints, Google Open Buildings, and Qian Shi et al. East Asian Buildings (CC BY 4.0).

Map data © OpenStreetMap contributors — ODbL 1.0. Building footprints ©
Overture Maps Foundation and upstream contributors — ODbL 1.0. Ocean-depth
shading: GEBCO Compilation Group (2024), GEBCO 2024 Grid,
doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f.

## Credits / 致谢

Map design, data integration, demand methodology, clean-room implementation, validation, and packaging: **LeoVan**.

地图设计、数据整合、需求方法、从零实现、验证与打包：**LeoVan**。

This project does not copy Google Maps, Apple Maps, or AutoNavi geometry, textures, screenshots, map tiles, interface elements, or proprietary data. Those products were used only as high-level visual references requested by the author.

本项目不复制 Google Maps、苹果地图或高德地图的几何、纹理、截图、地图瓦片、界面元素或专有数据；它们仅作为作者提出的高层视觉参考。
