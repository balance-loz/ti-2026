# DatDota integration contract

DatDota is an independent provider view, not automatically an independent sample. Its tier-1/2 tables substantially overlap the professional maps already ingested through OpenDota/Valve. Aggregate pick counts and win counts must never be added to the existing totals: that would count many maps twice and produce falsely narrow uncertainty.

## Useful data

1. Raw maps absent from the local corpus, provided they have a stable `match_id`, timestamp, teams, patch, result and draft. Merge by `match_id`; quarantine provider disagreements.
2. Hero-position distributions. Use as a prior only where the parsed replay does not identify a role. Never overwrite observed positions.
3. Pick/ban order, flex/position entropy, phase availability and provider disagreement. Treat these as challenger features, not production constants.
4. Descriptive tables may cross-check current-patch coverage, but are not historical training labels.

## Temporal and correlation gate

Every export stores the query, retrieval timestamp, declared `asOf`, SHA-256 checksum and transport. A current full-patch aggregate cannot be attached to earlier games from that patch: doing so leaks future drafts and results. Historical training therefore requires dated snapshots or raw map rows.

For each candidate feature the arena records correlation with the existing hero, role, synergy, counter and pool features. Correlation alone does not decide inclusion. The feature is residualized/regularized inside the challenger, then must improve both log loss and Brier on chronological OOF predictions. The upper 95% `series_id` cluster-bootstrap bound for the log-loss delta must be below zero. Coverage must be at least 80%, maps must be deduplicated, and the source must be temporally safe. Otherwise its status stays `shadow`.

The order remains:

`team prior → side → hero → residual synergy → residual counter → team pool → player pool → observed roles → gated external residuals`

DatDota may improve both pre-draft and post-draft prediction only when evaluated against the corresponding target. Post-result statistics are prohibited in the pre-draft target.

## Collection

The documented public pattern inserts `/api` before the normal route. Run `npm.cmd run datdota:sync`. If Cloudflare refuses the server IP, do not bypass it. Save an authorized JSON API export and run:

```powershell
$env:DATDOTA_POSITIONS_FILE='C:\path\positions.json'
$env:DATDOTA_AS_OF='2026-08-12T00:00:00Z'
npm.cmd run datdota:sync
```

Artifacts stay under ignored `work/datdota-cache/`. Importing never activates a production coefficient; a later arena run must produce the gate evidence.
