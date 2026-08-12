# Decision, history and conditional-branch contract

## Probability is not confidence

The model still optimizes proper probabilistic scores. Log loss already rewards a correct confident prediction and heavily penalizes a confident error. An extra reward for extremity is not used because it incentivizes miscalibration. `scripts/run-sharpness-arena.mjs` tests temperature scaling on chronological OOF predictions; a sharper temperature activates only when frozen log loss and Brier do not worsen.

The UI separates four decisions:

- `pick`: the favorite's conservative interval remains above 50% and evidence confidence is sufficient;
- `even`: evidence may be good, but the teams are genuinely close;
- `roulette`: roster/sample/model evidence is weak;
- `pass`: a favorite exists for bracket progression but is not reliable enough for a decision.

Accuracy is reported together with coverage. A selective model is useful only if accuracy rises as it abstains from difficult matches.

## Official baseline

The server-owned default is immutable configuration: `stats`, `0%` personal opinion and `250,000` Monte Carlo iterations. Automatic results never inherit the latest manual profile.

## Snapshot lineage

An `original` snapshot records the information and settings available at creation time. It is never rewritten. After a real result the server creates a `revision` for every unique manual profile, preserving `root_snapshot_id`, `parent_snapshot_id`, profile answers and weight. Selecting `?run=<id>` restores the profile and displays its latest revision while the original remains available for scoring.

Online team/player state may update after each real series. Full CatBoost/Deep Sets/stack retraining remains gated and should run only after sufficient new data or a patch/roster boundary.

## Hypothetical results

Training on invented winners as if they were observations is prohibited: it creates self-confirmation bias, corrupts calibration and understates uncertainty. Conditional branches are allowed. Each branch clones the current state, applies one hypothetical outcome in memory, recomputes downstream pairings and then discards the clone. No hypothetical row reaches SQLite, model artifacts or evaluation history.
