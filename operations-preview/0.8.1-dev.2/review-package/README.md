# Registry review package · 2026-10-03

This is **Shanghai Operations 0.8.1-dev.2**, a PVG-only development candidate. **publishReady=false**. The map remains a separate **v2.1.0** artifact; no new map-data release is claimed.

## Uploaded mod package

- [Shanghai-Operations-0.8.1-dev.2-review.zip](Shanghai-Operations-0.8.1-dev.2-review.zip)
- [Package checksum](SHA256SUMS-review.txt)
- ZIP SHA-256: `74c5c11d77412d798c9408c9a2e08b5ab967f21978fef0d8a7c5b749217a5852`
- Exact bundled runtime SHA-256: `bba8166cc1af74238d27e5e8a510c9249b578752bd9fa762a73fe78fbef510b3`
- ZIP root contains only `manifest.json`, `index.js`, `README.md`, `LICENSE`. Version and extracted runtime hash checked before upload.
- No test driver, private save, raw log, personal path, native game source or facility metadata is included.
- Advanced construction, passing and optional egress interfaces remain development-only and are not enabled automatically. Test using an independent backup.

## Inspectable evidence

- [Runtime source](../leovan-shanghai-operations/index.js)
- [Candidate capabilities and limitations](../leovan-shanghai-operations/README.md)
- [Existing native r16 test](../review-evidence/r16-summary.json): 7,368 simulated seconds; 3 verified overtakes out of 5 holds; 2 unverified holds not counted.
- [October 3 acceptance status](../review-evidence/ACCEPTANCE_STATUS_2026-10-03.md)
- [October 3 offline rerun](../review-evidence/offline-reverification-2026-10-03.json): 7 suites pass; 20 original snapshot checksums match. No new loaded-game/full-passenger-cycle test.
- [Concrete map and related-mod comparison](../COMMUNITY_COMPARISON_2026-10-01.md)

## Map artifact and scoring

The existing downloadable map is [Shanghai PVG v2.1.0](https://github.com/LeoVan1412/shanghai-pvg/releases/tag/v2.1.0). The operations ZIP above is a different package.

The last Registry result is [Medium / weighted composite 0.58, self-reported pending confirmation](https://github.com/Subway-Builder-Modded/registry/issues/9356#issuecomment-5504812115). The [map methodology submission](../../../DATA_QUALITY_SUBMISSION.md) includes historical provisional calculations, not a confirmed Registry rating. Local fine-type calibration, hybrid resident grain and synthetic O/D remain subject to maintainer classification. These methods already existed in v2.1.0 and are not newly observed data.

## Requested review

We request maintainer review through [Registry PR #9355](https://github.com/Subway-Builder-Modded/registry/pull/9355), linked to submission #9353 and quality questionnaire #9356:

1. Assess the uploaded operations candidate separately as a gameplay mod, and specify remaining native acceptance evidence and whether PVG-only support is acceptable or existing SHA support is required.
2. Reconsider the documented map-data classification where appropriate, especially hybrid open-footprint resolution versus locally calibrated intensity and mixed resident grain. Please state which evidence or genuinely new measured data is required for reconsideration beyond v2.1.0.
3. If reconsideration is accepted, indicate whether the existing map submission/quality questionnaire should be reopened or a fresh form is required, and confirm the resulting rating through the Registry's normal maintainer workflow.

This package is submitted for development review. It is not a stable release, approval, confirmed map rating or completed long-duration certification.
