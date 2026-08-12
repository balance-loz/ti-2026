# Adaptive Monte Carlo

Official baseline and its post-result revisions use an adaptive simulation budget. Manual browser runs remain fixed-budget to keep the UI responsive.

## Production policy

- Minimum: 250,000 complete tournaments.
- Checkpoint: every 250,000 tournaments.
- Maximum: 1,000,000 tournaments.
- Stability target: maximum absolute change at most 0.10 percentage points.
- The target is evaluated across qualify, direct, via-play-in, champion, final and top-3 probabilities for all 16 teams.
- Stop only after two consecutive stable checkpoint comparisons. With the default checkpoints, the earliest stable stop is therefore 750,000.

The result stores the actual iteration count, every checkpoint, the latest maximum change, the sampling margin and whether it stopped on convergence or on the maximum budget. The random-number stream is continuous across checkpoints, so no batches are discarded or reweighted.

Adaptive sampling reduces Monte Carlo error only. It must never sharpen a 52/48 model estimate into a confident prediction.

Exact bracket paths are not a convergence target: their state space is too large. Path uniqueness is measured on at most 250,000 paths to cap memory use, and exact scenario cards are labelled as representative observed outcomes. Team marginals are the decision-grade output.

Environment controls:

```env
AUTO_SNAPSHOT_ITERATIONS=250000
AUTO_SNAPSHOT_MAX_ITERATIONS=1000000
AUTO_SNAPSHOT_BATCH_SIZE=250000
AUTO_SNAPSHOT_TOLERANCE_PP=0.10
```
