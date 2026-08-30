# Shanghai PVG v2.1.0 / 上海 PVG v2.1.0

This release upgrades the map's population, workplace and commute evidence so
the Registry data-quality submission can be reviewed as **High** without
claiming precision that the official sources do not provide.

本版本升级了人口、岗位与通勤证据，目标是在不夸大官方来源精度的前提下，让
Registry 数据质量申报可按 **High** 审核。

## What changed / 主要更新

- Added a 13,001,675 employed-resident origin control derived from the official
  2020 Population Census long-form sample and official 2024 resident totals.
- Closed employed residents exactly across all 16 districts and 225 street/town
  areas; Huangpu, Changning and Fengxian use complete official subdistrict
  employment shares.
- Connected resident and workplace allocation to 1,425,460 retained hybrid
  building footprints inside Shanghai.
- Calibrated eight residential building/land-use intensity types against all
  225 official local population controls. Deterministic five-fold CV R² is
  0.5768.
- Calibrated ten workplace sector intensity types to official Shanghai
  employment-by-industry totals with maximum sector error below one person.
- Replaced unconstrained workplace flow estimation with a doubly constrained
  synthetic O/D matrix. All employed-resident origin and district × sector
  workplace destination margins close with zero group error.
- Routed all 50,147 workplace groups on the OSM road network. Mean workplace
  commute is 10.404 km versus the official Shanghai survey benchmark of 10.2 km.
- Rebuilt and validated the complete map: 15,243,400 modeled people, 15,305
  demand points, 76,217 routed groups, 74,124 unique O/D pairs and 2,511,903
  collision-indexed buildings.

- 新增 13,001,675 名就业居民起点控制量，由官方 2020 年人口普查长表抽样和
  2024 年官方常住人口推导。
- 就业居民在 16 区和 225 个街镇空间单元精确闭合；黄浦、长宁、奉贤采用完整
  官方街镇就业份额。
- 居民和岗位落点共同使用上海市内 1,425,460 个保留的混合来源建筑轮廓。
- 8 类住宅建筑/土地利用强度对 225 个官方本地人口控制量进行标定，确定性五折
  交叉验证 R² 为 0.5768。
- 10 类岗位行业强度直接标定到上海官方分行业就业总量，最大行业误差小于 1 人。
- 将无约束通勤估算替换为双约束合成 O/D；就业居民起点和“区 × 行业”岗位终点
  两侧边际误差均为 0。
- 50,147 个就业通勤组全部在 OSM 道路网寻路，平均道路距离 10.404 公里，官方
  上海调查基准为 10.2 公里。
- 全图重新构建并通过验证：15,243,400 名建模人员、15,305 个需求点、76,217 个
  已寻路人口组、74,124 个唯一 O/D 组合和 2,511,903 栋碰撞索引建筑。

## Registry quality expectation / Registry 评级预期

The checked answer set calculates to `0.6475875`, provisionally **High**. A
conservative hybrid-grain interpretation calculates to `0.619675`, also High.
The maintainer determines the final classification. Very High is not claimed:
the public evidence does not contain a genuine observed small-area commute-flow
table.

当前答案组合计算为 `0.6475875`，预期为 **High**；按更保守的混合粒度解释为
`0.619675`，仍为 High。最终档位由维护者决定。本版本不申报 Very High，因为
公开证据中没有真实的小区域通勤流表。

## Compatibility / 兼容性

- Map ID: `leovan-shanghai-pvg`
- City code: `PVG`
- Subway Builder: `>=1.4.0`
- Optional Shanghai Landmarks companion: `v2.1.0` (Subway Builder `>=1.6.0`)
