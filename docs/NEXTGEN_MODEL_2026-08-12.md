# Next-generation forecasting pipeline — 12 August 2026

## Decision summary

The new mass team layer is useful; the new draft challengers and BO3/BO5 temperature calibration are not ready for production.

| Layer | Untouched test | Decision |
| --- | --- | --- |
| Validation-selected OOF stack | final LL 0.65808, Brier 0.23330, accuracy 60.15%; neutral LL 0.69315 | `CANDIDATE` |
| Bayesian player/roster diagnostic | final LL 0.65280, but discovered only after opening final test | not selectable retrospectively |
| Post-draft CatBoost | LL 0.62594 vs pre-draft 0.62594; validation chose blend weight 0 | `SHADOW` |
| Post-draft Deep Sets | LL 0.62644 vs pre-draft 0.62594 | `SHADOW` |
| BO3/BO5 temperatures | LL 0.65233 → 0.65247 | `EXPERIMENTAL`, not applied |

Complexity was not promoted merely because it was available. The production forecast remains unchanged until a challenger improves an untouched chronological test with a series-cluster bootstrap interval below zero.

## Population and targets

The pipeline deliberately has two populations:

1. `all-pro`: 55,874 maps grouped into all 29,599 recoverable professional series, 298 leagues, 7,904 team identities and 23,491 player-role states. Provider `series_id` exists for 26,657 series; 2,942 missing series are retained as explicit synthetic single-map clusters. The first 1,000 chronological series are burn-in. The final 5,720 series form the frozen holdout (5,554 non-draw outcomes).
2. `rich draft`: 1,761 parsed maps, 942 series, and 42,255 ordered pick/ban events. This is the complete subset with ten picks, ten players, full draft sequence, checksum, exact subpatch and an OOF pre-draft prior. It is split by series in chronological 65/15/20 blocks: 1,110 train, 277 validation, 374 test maps.

The pre-draft target is series/map strength before heroes are known. The post-draft target is map outcome conditional on the frozen pre-draft probability. Auxiliary targets are Radiant gold advantage at 10/15/20, XP advantage at 10, duration, first blood, first tower and first Roshan.

## Team arena

Every prediction is emitted before the series update. The arena contains Elo, online Bradley–Terry, decayed recency, a temporal Gaussian player-role model, and that player model plus regularized team-tournament and team-exact-patch effects. A non-negative logit stack is fitted on expanding OOF blocks.

The class is selected on a separate middle block of 4,862 series. There the stack narrowly wins: LL 0.66001 versus 0.66042 for the player model. The final 5,148-series block is then opened once. Its 5,009 binary outcomes give:

| Model | Log loss | Brier | Accuracy |
| --- | ---: | ---: | ---: |
| Elo | 0.67552 | 0.24138 | 57.54% |
| Bradley–Terry | 0.67376 | 0.24055 | 57.86% |
| Recency | 0.68868 | 0.24390 | 56.44% |
| Bayesian player/roster | **0.65280** | **0.23080** | 61.11% |
| Player + random effects | 0.65792 | 0.23299 | 60.91% |
| Validation-selected OOF stack | 0.65808 | 0.23330 | 60.15% |
| 50% | 0.69315 | 0.25000 | 50.01% |

The validation-selected stack beats 50% with series-cluster bootstrap log-loss delta CI `[-0.04093, -0.02935]`. The player model is better on the final block, but switching to it now would be post-selection leakage. Therefore the exported research artifact correctly retains `stack`; the result documents temporal selection instability and does not silently replace the site's current production prior. Tournament/patch random effects remain auditable components and do not win selection.

The player state is not full batch MCMC. It is an online approximate Bayesian Gaussian state: mean and variance per player-role, temporal process noise for inactivity, variance-dependent updates, plus a regularized exact-roster effect. It is computationally practical for online inference, but its posterior calibration still needs simulation-based checks.

## Draft propensity and residual effects

For each map, before updating on that map:

- propensity is estimated for every ordered event by exact subpatch, event order, side and pick/ban action with Laplace smoothing;
- hero main effects use `outcome − preDraftProbability`;
- synergy is trained on residuals after the hero/team prior;
- directional counter is trained on the same residual target;
- real player→hero roles from the parsed map are used; no unrestricted player assignment or role heuristic is introduced.

CatBoost receives the pre-draft logit, 24 ordered event tokens, exact subpatch, league, observed hero-role tokens, propensity/surprise and prequential residual effects. Deep Sets uses a shared hero embedding, signed side aggregation, a nonlinear residual head over the fixed pre-draft logit, and masked multi-task heads.

On the 374-map untouched test, neither model improves the prior. CatBoost's validation-optimal residual blend is exactly zero, so its deployed shadow probability equals the pre-draft prior. Deep Sets is slightly worse (delta +0.00050). Both remain `SHADOW`.

Side-flip augmentation is mandatory, and inference explicitly symmetrizes `p(x)` and `1-p(flip(x))`. The measured mean and maximum complement errors are therefore exactly zero for the pre-draft prior, CatBoost and Deep Sets.

## Multi-task diagnostics

Deep Sets currently gives weak auxiliary estimates: gold MAE 2,074 at 10 minutes, 3,607 at 15, and 5,000 at 20; duration MAE is about 647 seconds. First-blood log loss is 0.6934, first-tower 0.6956 and first-Roshan 0.6914 on 355 holdout maps. These heads regularize representations but are not product-quality predictors. The first-Roshan parser now handles OpenDota's `team=2/3` convention and covers 1,535 maps overall.

## BO3/BO5 and Monte Carlo

Calibration runs only after the team and draft arenas. Real `series_type` is persisted as `series_best_of`; it is not guessed from the number of maps played. On the calibration holdout there are 3,379 BO3 and only 67 BO5 series. Train-selected temperatures are BO3 `1.53` and BO5 `1.485`, but they worsen holdout LL from 0.65757 to 0.66199; series-bootstrap delta CI is `[+0.00175, +0.00701]`. They are exported as experimental and are not applied.

The fitted persistent tournament-form SD is 0.323 logit, while independent per-series Gaussian noise remains zero because the Bernoulli series draw already represents aleatoric result uncertainty. Since the series calibration gate failed, these next-generation values do not replace the current Monte Carlo calibration.

## Main weaknesses and next experiment

- Rich parsed drafts cover only 1,761 maps. This is the limiting sample, not the 55,874-map team layer.
- The draft selection policy is only approximated by smoothed historical propensities; it lacks captain, remaining hero pool, tournament stage and exact draft-time context.
- CatBoost requires two inference passes to enforce side symmetry; this doubles challenger inference cost.
- Deep Sets is nearly tied with the prior, suggesting useful draft signal may exist but is below the detectable effect of the current holdout.
- BO5 has only 67 holdout series; a separate free BO5 temperature is high variance.
- The online Bayesian state is approximate and its role-transition/process-noise hyperparameters are not nested-tuned.

The next high-value experiment is not more random noise. It is to collect substantially more parsed full drafts, add the remaining-hero-pool and captain/first-pick context to propensity, explicitly symmetrize challengers, and use a hierarchical shared BO3/BO5 calibrator with strong shrinkage for BO5.

## Reproduction

Run `npm run model:train:nextgen` in an environment with NumPy and CatBoost. Generated reports live in ignored `work/`; compact review artifacts are `public/all-pro-team-model.json`, `public/draft-nextgen-model.json`, and `public/nextgen-series-calibration.json`.
