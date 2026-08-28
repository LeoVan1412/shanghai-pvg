# Data sources / 数据来源

This document is generated conceptually from `data/source_registry.json`; the
JSON registry is authoritative for build-time input approval.

## Open geographic data

- OpenStreetMap Shanghai, Jiangsu and Zhejiang extracts dated 2026-08-20,
  downloaded from Geofabrik and licensed under ODbL 1.0.
- Overture Maps buildings theme release 2026-08-19.0, licensed under ODbL 1.0.
  Upstream contributors represented in the selected release include
  OpenStreetMap contributors, Esri Community Maps contributors, Microsoft
  Global ML Building Footprints, Google Open Buildings, and Qian Shi et al.
  East Asian Buildings (CC BY 4.0).
- GEBCO Compilation Group (2024), GEBCO 2024 Grid,
  doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f. The Grid is placed in the
  public domain under the [GEBCO Terms of Use](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use);
  source acknowledgement is required. The build uses only a Shanghai-area crop
  for ocean-depth shading; OSM remains authoritative for the coastline and water
  extent.
- Only local raw inputs whose byte sizes and SHA-256 hashes appear in the source
  registry are accepted by the build.

## Official statistics

- Shanghai municipal and all 16 district Fifth National Economic Census
  communiques for employment totals and district/subdistrict allocation.
- Shanghai official population, transport, education, health, tourism,
  industrial-park and agricultural-service publications for independent model
  calibration.

Every statistical record used by the released build is marked `allowed`. It
became a build input only after the original page or document was archived, its
reuse basis was recorded, the relevant table was independently transcribed, and
a second-pass validation reconciled the extracted totals.

## Modeling status

No old Shanghai gameplay total is accepted as an official observation. The
daily-equivalent demand targets are calculated from documented observations and
explicit rates stored in `data/demand_model.json` and `data/model_spec.json`.

The release ZIP includes this document plus `SOURCE-REGISTRY.json` and
`OFFICIAL-POPULATION-SOURCES.json`, so its source and licence records remain
available without access to the source repository.
