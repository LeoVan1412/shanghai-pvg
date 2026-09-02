# Registry data-quality submission / 数据质量提交草稿

Prepared for Shanghai PVG `v2.1.0` against the Registry scoring implementation
reviewed on 2026-08-30. The answers below describe the grain and method of the
official controls actually used; the 300 m output grid is not presented as
officially measured data.

本草稿用于上海 PVG `v2.1.0`，按 2026-08-30 检查到的 Registry 评分实现准备。
下列选项按实际使用的官方控制量和方法填写；300 米输出网格不会被描述为官方实测
数据。

## Form answers / 表单选项

- **Map ID:** `leovan-shanghai-pvg`
- **Same methodology as your other maps in this country?**
  `No — new or different methodology`
- **Where do your job numbers come from?**
  `A government census or survey that counts where people actually work`
  (`physical_measured`)
- **What is the smallest area your job numbers are reported for?**
  `Neighborhoods or districts within a city` (`adm4`)
- **When a job number covers an area bigger than one building, how did you place the jobs within it?**
  `Building footprints, split by workplace type using standard assumptions`.
  This is the conservative current form option because the footprints are
  Overture/OSM/open-ML hybrids rather than an official cadastre. The methodology
  documents that the workplace intensities themselves are locally calibrated;
  ask the reviewer to classify the combination as `ml_hybrid_footprints` +
  `fine_types_calibrated`, which the dropdown cannot express directly.
- **What do your population numbers count?**
  `Employed residents` (`employed_residents`)
- **What is the smallest area your population numbers are reported for?**
  `Neighborhoods or districts within a city` (`adm4`; document the hybrid
  district-rate × street/town-distribution method in the text field)
- **When a population number covers an area bigger than one building, how did you place the people within it?**
  `Building footprints, with homes identified and weighted using standard assumptions`.
  This is likewise the conservative current form option for hybrid open
  footprints. The methodology records the local eight-class calibration; ask
  the reviewer to preserve `ml_hybrid_footprints` resolution while applying
  `fine_types_calibrated` intensity.
- **Does the census publish data about where people commute from and to?**
  `No flow data, but measured job and employed-resident totals per area that the estimates are forced to add up to`
  (`synthetic_measured_marginals`).
- **If you have commute-flow data, what is the smallest area it covers?**
  Leave blank / 留空. The O/D cells are synthetic; the measured components are
  margins, not a published flow table.

## Methodology / 方法（粘贴到必填文本框）

Shanghai PVG v2.1.0 uses official Shanghai controls and independently licensed
open geography. Workplace totals are 13,099,632 `persons employed by legal
entities` at 2023-12-31 from the Fifth National Economic Census. The municipal
total, all 16 district releases, and published street/town/development-zone
tables are reconciled exactly. Suppressed values remain at district level. The
economic-census implementation form records a unit's actual location separately
from its registered address, although the public legal-entity tables can still
contain multi-site or head-office limitations.

Resident origins use the 2020 Population Census long-form sample tables. The
official district employed-resident rate is applied to the official 2024
resident total; this estimates 13,001,675 employed residents from 24,802,600
residents. Huangpu, Changning and Fengxian use complete official subdistrict
employment shares. The other 13 districts use their official street/town
resident shares to distribute the measured district employed-resident total.
All 16 district and 225 area controls close exactly. This is a documented hybrid
ADM3 measured rate × ADM4 independent distribution, not a claim that every
2024 employed-resident cell was directly published.

Both resident and workplace controls are assigned through 1,424,830 retained
inside-Shanghai hybrid building footprints from Overture and its OSM, Esri,
Microsoft Global ML Building Footprints, Google Open Buildings and East Asian
Buildings upstream contributors, together with OSM land use and facilities.
Residential intensity uses a non-negative ridge fit of eight local building and
land-use classes against all 225 official street/town population controls
(generic R² 0.5202; fitted R² 0.5809; deterministic five-fold CV R² 0.5453).
Workplace intensity uses ten fine sector types calibrated directly to official
Shanghai employment-by-industry totals; maximum sector calibration error is
below one person, after which every published spatial control is imposed exactly.

Workplace O/D is a doubly constrained synthetic matrix. Its 16 origin margins
are the employed-resident controls and its 160 destination margins are the
officially controlled district × calibrated workplace-sector totals. Iterative
proportional fitting plus exact integer rounding closes both sets of margins
with zero group error. The 50,147 workplace groups are then routed on the
redacted OSM road network. Their mean driving distance is 10.3965 km, 0.1965 km
above the official Shanghai Seventh Comprehensive Transport Survey average of
10.2 km.
The cells themselves remain estimated; this submission therefore selects
`synthetic_measured_marginals`, leaves O/D grain blank, and does not describe
the flow matrix as observed.

上海 PVG v2.1.0 使用上海官方控制量和独立许可的开放地理数据。就业端采用第五次
全国经济普查截至 2023-12-31 的 13,099,632 名法人单位从业人员，将市级、16 区
和公开街镇/开发区表精确闭合；未公开的细分量保留在区级。普查表区分单位实际
所在地和注册地，但公开法人单位表仍可能存在多经营地或总部统计局限。

居住端使用 2020 年人口普查长表抽样中的就业人口。各区官方就业居民率乘以 2024
年官方常住人口后，得到 24,802,600 名居民中的 13,001,675 名就业居民。黄浦、
长宁和奉贤使用完整官方街镇就业份额，其余 13 区使用官方街镇常住人口份额分配
区级就业居民量；16 区和 225 个空间单元全部精确闭合。这是一种“区级实测率 ×
街镇级独立分布”的透明混合方法，并非声称每个 2024 就业居民小区都由官方直接发布。

居民和岗位均通过上海市内保留的 1,424,830 个混合来源建筑轮廓落点，并结合 OSM
土地利用和具名设施。居民强度用 8 类本地建筑/土地利用特征对 225 个官方街镇人口
控制量做非负岭回归（通用基线 R² 0.5202、拟合 R² 0.5809、确定性五折交叉验证
R² 0.5453）。岗位强度按 10 个细分行业直接标定到上海官方分行业就业总量，最大
行业误差小于 1 人，随后再逐公开空间控制量精确闭合。

通勤 O/D 为双约束合成矩阵：16 个起点边际来自就业居民控制量，160 个终点边际来自
“区 × 标定行业”的就业控制量。IPF 与精确整数舍入使两侧边际误差均为 0。50,147
个就业通勤组在脱敏后的 OSM 道路网寻路后的平均距离为 10.3965 公里，仅比上海第七次综合
交通调查官方 10.2 公里均值高 0.1965 公里。流量单元本身仍是估算值，因此选择
`synthetic_measured_marginals`、O/D 粒度留空，绝不将合成流量描述为实测流量。

## Provisional score calculation / 预估评分

Using the Registry weights reviewed on 2026-08-30, the evidence-supported
reviewer classification is:

- workplace pillar: `(0.5 × 1.0 + 0.5 × 0.7 × 0.85) × 0.9 = 0.71775`;
- resident pillar: `(0.5 × 1.0 + 0.5 × 0.7 × 0.85) × 0.9 = 0.71775`;
- O/D pillar: `0.25`;
- composite: `0.50 × 0.71775 + 0.35 × 0.71775 + 0.15 × 0.25 = 0.6475875`;
- expected reviewed tier: **High** (`>= 0.60`).

The current issue form conservatively couples hybrid open footprints to
`standard assumptions`, so its automatic provisional score may initially show
**Medium**. The methodology and QA evidence support separating footprint
resolution (`ml_hybrid_footprints`) from calibrated intensity
(`fine_types_calibrated`) during maintainer review; this is not a claim that the
hybrid footprints are an official cadastre.

If a reviewer treats the hybrid resident grain as the ADM3/ADM4 midpoint, the
calculated score is `0.619675`, still **High**. If it is classified wholly as
ADM3, the score is `0.5917625`, or **Medium**. The maintainer makes the final
classification. **Very High** (`>= 0.75`) is not defensible from the current
public evidence; it would require a genuine observed small-area O/D table and/or
finer directly measured resident/workplace cells or exact dwelling/unit counts.

按 2026-08-30 检查到的权重，证据支持的审核分类计算分为 `0.6475875`，预期为
**High**。当前表单把混合开放建筑轮廓与“标准假设”绑定，自动暂定分可能先显示
**Medium**；维护者需依据方法与检查证据，将建筑轮廓精度和本地标定强度分开评定。
若审核员把居住端混合粒度按 ADM3/ADM4 中点处理，仍为 `0.619675`（**High**）；
若完全按 ADM3 处理，则为 `0.5917625`（**Medium**）。最终分类由维护者决定。
现有公开证据不足以诚实达到 **Very High**；要达到该档，需要真实的小区域通勤流表，
以及/或者更细粒度的直接实测居民、岗位单元或精确住宅/单位计数。

## Data source links / 数据链接（每行一条）

https://tjj.sh.gov.cn/tjnj/rktjnj2020e.htm
https://tjj.sh.gov.cn/tjnj/2020rktjnj/BNJc-1-1.xls
https://tjj.sh.gov.cn/tjnj/2020rktjnj/BNJc-4-1.xls
https://www.shcn.gov.cn/public/2025/pucha/c-4-1.xlsx
https://www.shanghai.gov.cn/nw18454/20260720/dc38ff6bd47c4208b796c4be190e3bda.html?siteId=1
https://tjj.sh.gov.cn/cmsres/ca/ca201ba07a58439e8c414cd6e9468eb2/610fc9c7fad600f8d24c8f2feffc6d52.pdf
https://www.stats.gov.cn/sj/tjbz/gjtjbz/202302/t20230213_1902747.html
https://tjj.sh.gov.cn/cmsres/b3/b36d6d16841e4ac0a64a2e6664c69833/85fdf28606c6847035976a586d8d028d.pdf
https://tjj.sh.gov.cn/tjnj/2025tjnj/C0202.htm
https://www.openstreetmap.org/copyright
https://docs.overturemaps.org/attribution/

The complete source URLs, archived hashes, reuse bases and limitations are in
`SOURCE-REGISTRY.json`, `OFFICIAL-POPULATION-SOURCES.json`, `DATA_SOURCES.md`
and the build QA records. Do not claim the calculated tier as a guaranteed
Registry decision; it remains provisional until maintainer review.
