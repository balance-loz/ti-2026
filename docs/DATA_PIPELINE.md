# TI Predictor data pipeline

The product keeps three different claims separate:

1. **Observed** — a value read from a match or parsed replay.
2. **Derived** — an aggregation such as a 90-day win rate or net-worth lead at 10 minutes.
3. **Modelled** — a probability produced by Bradley–Terry, draft adjustment or tournament simulation.

The UI must not present a descriptive style metric as a causal input. Only features actually used by the model may display a probability impact in percentage points.

## Current pipeline

| Layer | Artifact | Purpose |
| --- | --- | --- |
| Match ingestion | `scripts/update-stats.mjs` | OpenDota team history, match details, roster overlap and tournament validation |
| Series model | `public/team-stats.json` | Recency-weighted Bradley–Terry, regularized H2H and uncertainty |
| Draft model | `scripts/update-draft-stats.mjs` / `public/draft-stats.json` | Patch hero rates, synergies, counters, team familiarity and player×hero evidence |
| Temporal draft training | `work/draft-training.sqlite` → `public/draft-temporal-model.json` | Local-only Model Arena and patch walk-forward; production receives only the compact ensemble artifact |
| Intelligence | `scripts/update-intel-stats.mjs` / `public/intel-stats.json` | Context records, replay telemetry, player profiles, storylines and per-team TI outcomes |
| Live truth | `server/api.mjs` | Results, scheduled series, immutable snapshots and pre-match evaluation |

Run the complete refresh with `npm run data:update`. `npm run intel:update` is safe to rerun from the existing OpenDota cache and does not make network requests.

`stats:update` always runs the production-identical team walk-forward afterward. The gate compares production against 50%, Elo and a simple recency model. Team and tournament probabilities remain experimental until production beats the neutral baseline on log loss and Brier with a negative upper 95% series-cluster bootstrap bound.

`drafts:update` rebuilds current-patch statistics from every cached pro map, not only maps involving TI participants, and reruns the active chronological formula. Heavy historical research is kept out of the routine server refresh.

The cross-patch model is intentionally a separate local pipeline: `npm run draft:research:pipeline`, then `npm run draft:research:train`. The collector takes the complete accessible professional census in a fixed two-year interval instead of stopping at a target number of maps. It then downloads Valve's official patch timeline/notes, labels every map with an exact subpatch and audits every version. Its SQLite dataset and full reports stay under ignored `work/`; the server receives only compact artifacts. Details and deployment gates are in [DRAFT_TEMPORAL_MODEL.md](DRAFT_TEMPORAL_MODEL.md).

## Provenance and identity rules

- The canonical key is the TI team ID used by this application.
- OpenDota team IDs, historical organization names and schedule aliases are evidence attached to that key, not separate teams.
- A tournament is accepted only after its sampled lineup overlaps the expected roster by at least 3/5.
- Maps are labelled as current 5/5 or proxy 4/5–3/5 evidence. The UI exposes the exact-roster share and parsed-replay coverage.
- A lineup change creates a new roster era even when the organization name is unchanged.
- Every generated artifact contains `generatedAt`; the model artifact and the intelligence artifact also keep separate source timestamps.
- Each training map stores `series_id`, its provenance (`provider` or an isolated `synthetic_match` cluster when the provider omits it), exact Valve subpatch derived from the official timestamp, the provider patch label, source, parse-quality score and SHA-256 content checksum. The manifest also pins the patch-timeline checksum and reports provenance coverage by source.
- Map, BO3 and BO5 probabilities are separate fields. The simulator converts a BO3 probability back to its implied map probability before computing a BO5 grand final.

## Validation contract

- Active map formula: shared nested-arena `team prior → side/hero → residual synergy → residual counter → team pool → constrained player pool → learned hero×position`; all state is observed only after its OOF prediction. Combiner weights are fitted from OOF outcomes, then the same state/feature contract is exported to Draft Lab.
- `stats:update` also runs the 21-configuration nested team arena and historical tournament calibration. It exports `public/team-model.json` and `public/tournament-calibration.json` before either UI consumes probabilities.
- Browser and API tournament forecasts share `server/forecast-engine.mjs`; there is no second Monte Carlo implementation in the client.
- Temporal Model Arena: nine candidates are compared, but the backtest and export both use the named fixed four-member production stack. The Factorization Machine interaction is a difference of within-side interactions and has a mandatory side-flip invariant test.
- All uncertainty intervals used for deployment gates resample complete `series_id` clusters, not individual maps.

The component-by-component mathematical review, including failed models and disputed assumptions, is recorded in [MODEL_AUDIT_2026-08-12.md](MODEL_AUDIT_2026-08-12.md). `CANDIDATE` means a model passed its declared comparator; it does not mean betting-grade calibration.

## Replay-derived fields now used by `/intel`

- net-worth advantage at 10:00;
- kills by 10:00 and first blood;
- Roshan before 30:00;
- observer and sentry placement by 20:00;
- Smoke of Deceit purchases by 20:00;
- camps stacked, stun duration and building damage;
- player role estimate, KDA, GPM, XPM and hero-pool breadth.

The current replay coverage comes from parsed OpenDota match payloads. Missing replay telemetry reduces the visible quality score instead of being silently imputed.

## Recommended additional sources

### Priority 1 — own replay archive

Store replay URL, match ID, checksum, parser version and parse status. Keep raw `.dem.bz2` files in object storage, normalized match/series identity in the operational database, and wide time-series/event tables in Parquet. This removes dependence on a third party having parsed a specific match and allows metrics to be recomputed after parser changes.

### Priority 2 — Valve WebAPI / Game Coordinator

Use Valve as the primary identity/result layer and for replay coordinates. Keep OpenDota as a parser and reconciliation source. Never place Steam credentials or API keys in client code.

### Priority 3 — licensed tournament metadata

Liquipedia's official API can add transfers, roster dates, tournament structure and schedule reconciliation, but access and attribution must match its current terms. It should be an optional server-side connector, not scraped HTML and not a hard dependency for forecasts.

### Priority 4 — independent cross-check

A second commercial/statistical provider such as STRATZ is valuable for anomaly detection: compare match IDs, rosters, durations and winner fields, then flag disagreements for review. Do not average providers blindly.

## Next metrics unlocked by own `.dem` parsing

- lane matchups and lane net worth by player;
- draft phase, pick order, flex value, role certainty and ban pressure;
- objective setup windows before Roshan/Tormentor/towers;
- map-control and ward survival heatmaps;
- item timing distributions and response timings;
- teamfight initiation, target priority and buyback discipline;
- patch-to-patch style stability and opponent-strength adjusted identity metrics.

These features should enter the prediction model only after walk-forward evaluation improves log loss/Brier score, not merely because they look intuitive.
