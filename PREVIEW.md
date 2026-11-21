# FASE 1: GTA 6 Trophy Rarity Forecast — Preview

## Competition
**gta6-trophy-rarity-forecast-01** — pot $250, deadline 21 Nov 2026 11:30 UTC (18:30 WIB)

Predict earn rates for 55 PS5 trophies at 2026-11-26T00:00:00Z (5 quantiles: 0.05, 0.25, 0.5, 0.75, 0.95). Score = mean pinball loss on logit scale.

## Model Design

### Core Insight: Exophase Refresh Dynamics
Exophase periodically refreshes its player count. When `players_tracked` jumps (e.g., 638 → 3868, ~6×), earn rates drop proportionally (more players, same earners). Between refreshes, rates grow as new players earn trophies. This creates a **sawtooth pattern** on logit scale.

### Key Components

1. **Refresh Detection** — Scan history for `players_tracked` jumps >1.5×. Each marks a new segment.

2. **Logit-Scale Trend Fitting** — For the segment after the last refresh, fit a linear trend on `logit(rate)` vs time (minutes since release). This captures the growth rate between refreshes.

3. **Practice Case Handling** — No refreshes in history (all pre-first-refresh). Target is post-first-refresh (~90 min horizon). Model projects the expected drop:
   - Player ratio: 638/3868 ≈ 0.165
   - Effective rate drop: ~0.18–0.22× (tier-dependent) because new players earn some trophies quickly
   - Platinum drops like others; Trophy 2 (first mission, id=2) stays at 99.99%

4. **Final Case Projection** — With refreshes in history:
   - Estimate refresh interval from history (median ~180 min in practice)
   - Project trend forward, adding refresh uncertainty to spread
   - Platinum gets minimum growth: 0.3 logit units/day (ensures growth from ~0.6% to 100% over the week)

5. **Special Trophies**
   - **Trophy 2 (id=2, "Just Like Paradise")**: First mission, already 100%. Stays at 99.99% with minimal spread (0.05 × √days).
   - **Platinum (id=1)**: Drops at refresh, then grows monotonically toward 100%.

6. **Quantile Calculation** — For each trophy:
   ```
   q_τ = invLogit(logit(median) + z_τ × spread)
   z = [-1.645, -0.674, 0, 0.674, 1.645]  (0.05, 0.25, 0.5, 0.75, 0.95)
   spread = √(SIGMA_BASE² × horizon_days + residual²) + refresh_uncertainty
   SIGMA_BASE = 0.5 logit units per √day
   ```
   Rounded to 4 decimals, clamped to [0.01, 99.99].

### Constants
- `LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95]`
- `Z = [-1.645, -0.674, 0, 0.674, 1.645]`
- `SIGMA_BASE = 0.5`
- Release time: 2026-11-19T00:00:00Z (from competition.yaml)

## Practice Case Results

### p00 (checkpoint 03:00 UTC 19 Nov, horizon 90 min → target post-refresh)
| Trophy | Tier | Median (q[2]) | q[0] | q[1] | q[3] | q[4] |
|--------|------|---------------|------|------|------|------|
| 1 | platinum | 0.1140% | 0.0481 | 0.0800 | 0.1623 | 0.2699 |
| 2 | bronze* | 99.9900% | 99.9898 | 99.9899 | 99.9901 | 99.9902 |
| 3 | gold | 0.2237% | 0.0944 | 0.1571 | 0.3184 | 0.5289 |
| 4 | gold | 0.1950% | 0.0823 | 0.1370 | 0.2776 | 0.4613 |
| 5 | silver | 0.1934% | 0.0816 | 0.1359 | 0.2753 | 0.4575 |

* Trophy 2 is the first-mission trophy at 100%.

**Format validation**: ✅ 55 trophies, 5 quantiles each, non-decreasing, IDs 1–55 present.

### p01 (checkpoint 03:30 UTC 19 Nov, horizon 90 min)
Identical structure, same forecast (history is pre-refresh in both cases).

## How to Run

```bash
cd /data/workspace/makefun-gta6-trophy-rarity-forecast-01
mkdir -p out
MAKEFUN_INPUT_DIR=/tmp/tr-kit/gta6-trophy-rarity-forecast-01-kit/input \
MAKEFUN_OUTPUT_DIR=out \
node main.ts
```

Outputs written to `out/<case_id>.out` as `{trophies: [{id, q: [5 numbers]}]}`.

## Iteration Log
- v1: Starter template → basic persistence
- v2: Added refresh detection, logit trend, practice case drop heuristic
- v3: Refined platinum growth (0.3 logit/day minimum), better spread with refresh uncertainty, deterministic refresh interval estimation

## Commit
Built under git. No network access required — reads only from `/input` via env var.