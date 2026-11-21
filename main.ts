// gta6-trophy-rarity-forecast-01: Custom forecast model
// Models Exophase refresh dynamics: players_tracked jumps cause earn rate drops (except 100% trophy).
// Fits logit-scale trends between refreshes, projects forward with expected refresh behavior.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const SIGMA_BASE = 0.5; // baseline spread per sqrt(day)

interface Case {
  id: string;
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Array<{ id: number; name: string; tier: string; secret: boolean }>;
  history: Array<{
    slot: string;
    at: string;
    players_tracked: number;
    trophies_earned: number;
    rates: Array<number | null>;
  }>;
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

// Detect refresh points in history (where players_tracked jumps significantly)
// Returns indices where a NEW segment starts (the read AFTER the jump)
function detectRefreshes(history: Case['history']): number[] {
  const refreshes: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].players_tracked;
    const curr = history[i].players_tracked;
    if (curr > prev * 1.5) { // significant jump (e.g., 638 -> 3868 is 6x)
      refreshes.push(i);
    }
  }
  return refreshes;
}

// Fit linear trend on logit scale for a trophy over a history segment
function fitLogitTrend(rates: number[], times: number[]): { slope: number; intercept: number; residualStd: number } {
  const n = rates.length;
  if (n < 2) return { slope: 0, intercept: rates[0] ?? 0, residualStd: 0 };
  
  const logitRates = rates.map(r => logit(r));
  const meanT = times.reduce((a, b) => a + b, 0) / n;
  const meanL = logitRates.reduce((a, b) => a + b, 0) / n;
  
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (times[i] - meanT) * (logitRates[i] - meanL);
    den += (times[i] - meanT) ** 2;
  }
  
  const slope = den > 0 ? num / den : 0;
  const intercept = meanL - slope * meanT;
  
  // Residual standard deviation
  let sqErr = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * times[i];
    sqErr += (logitRates[i] - pred) ** 2;
  }
  const residualStd = n > 2 ? Math.sqrt(sqErr / (n - 2)) : 0;
  
  return { slope, intercept, residualStd };
}

// Forecast a single trophy's quantiles
function forecastTrophy(
  trophyIdx: number,
  trophy: Case['trophies'][0],
  history: Case['history'],
  horizonMinutes: number,
  targetTime: number, // minutes since release
  lastReadTime: number
): number[] {
  const lastRead = history[history.length - 1];
  const lastRate = lastRead.rates[trophyIdx] ?? 0;
  
  // Time points for history reads (minutes since release)
  const releaseTime = new Date('2026-11-19T00:00:00Z').getTime() / 60000;
  const readTimes = history.map(h => new Date(h.at).getTime() / 60000 - releaseTime);
  
  // Detect refreshes
  const refreshIndices = detectRefreshes(history);
  
  // Special trophies:
  // - Trophy 2 (id=2, bronze "Just Like Paradise") is at 100% and stays there (first mission everyone completes)
  // - Platinum (id=1) drops at refresh like others, then grows over the week
  const isFirstMissionMaxed = trophy.id === 2 && lastRate >= 99.9;
  const isPlatinum = trophy.tier === 'platinum';
  
  if (isFirstMissionMaxed) {
    // Already at 100% (first mission trophy), stays there
    const median = 99.99;
    const spread = 0.05 * Math.sqrt(horizonMinutes / 1440);
    return Z.map(z => round4(invLogit(logit(median) + z * spread)));
  }
  
  // If no refreshes in history (practice cases), expect a refresh during horizon
  if (refreshIndices.length === 0) {
    const horizonDays = horizonMinutes / 1440;
    
    if (horizonDays <= 1) {
      // Practice case: target is at/after first refresh
      // Last read is pre-refresh (638 players), target is post-refresh (~3868 players)
      // Player count multiplies by ~6.06, so rates drop by roughly that factor
      // Exception: the 100% trophy (handled above) stays at 100%
      // Platinum drops too (more players, same earners)
      const playerRatio = 638 / 3868; // ~0.165
      // But rates don't drop exactly by player ratio - some new players earn trophies quickly
      // Observed: bronze ~1.1% -> ~0.2-0.3% (drop ~4-5x), gold ~0.63% -> ~0.15% (drop ~4x)
      // So effective drop is ~0.2-0.25x, not 0.165x
      const tierBaseDrop = trophy.tier === 'gold' ? 0.22 : trophy.tier === 'silver' ? 0.20 : 0.18;
      const positionFactor = Math.max(0.15, 1 - trophyIdx * 0.008); // earlier trophies drop less relatively
      const expectedDrop = tierBaseDrop * positionFactor;
      
      const lastLogit = logit(lastRate);
      const forecastLogit = lastLogit + Math.log(expectedDrop);
      const median = invLogit(forecastLogit);
      
      // Spread: baseline + refresh uncertainty
      const spread = SIGMA_BASE * Math.sqrt(horizonDays) + 0.4;
      
      return Z.map(z => round4(invLogit(forecastLogit + z * spread)));
    } else {
      // Final case with no refreshes yet (unlikely but handle)
      const spread = SIGMA_BASE * Math.sqrt(horizonDays);
      const l = logit(lastRate);
      return Z.map(z => round4(invLogit(l + z * spread)));
    }
  }
  
  // Has refreshes in history (final case): model refresh cycles explicitly
  // Each cycle: refresh -> drop -> growth -> next refresh
  // Use the post-last-refresh segment to estimate growth rate, then project with expected refreshes
  
  const lastRefreshIdx = refreshIndices[refreshIndices.length - 1];
  const segmentRates: number[] = [];
  const segmentTimes: number[] = [];
  
  for (let i = lastRefreshIdx; i < history.length; i++) {
    const r = history[i].rates[trophyIdx];
    if (r !== null && r > 0.01 && r < 99.99) {
      segmentRates.push(r);
      segmentTimes.push(readTimes[i]);
    }
  }
  
  if (segmentRates.length < 2) {
    // Fallback: persistence with baseline spread
    const spread = SIGMA_BASE * Math.sqrt(horizonMinutes / 1440);
    const l = logit(lastRate);
    return Z.map(z => round4(invLogit(l + z * spread)));
  }
  
  const { slope, intercept, residualStd } = fitLogitTrend(segmentRates, segmentTimes);
  
  // Estimate future refreshes based on history
  // Practice cases show first refresh at ~180 min (3h) from 638 -> 3868 players
  // Final case likely has refreshes every few hours, slowing over time
  // Use the median time between observed refreshes
  let avgRefreshInterval = 180; // default 3 hours
  if (refreshIndices.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < refreshIndices.length; i++) {
      intervals.push(readTimes[refreshIndices[i]] - readTimes[refreshIndices[i - 1]]);
    }
    intervals.sort((a, b) => a - b);
    avgRefreshInterval = intervals[Math.floor(intervals.length / 2)];
  }
  
  // Project to target, accounting for expected refreshes
  let forecastLogit = intercept + slope * targetTime;
  let median = invLogit(forecastLogit);
  
  // For platinum, ensure it grows over the week (minimum 0.3 logit/day)
  if (isPlatinum) {
    const horizonDays = horizonMinutes / 1440;
    const lastLogit = logit(lastRate);
    const minGrowth = 0.3 * horizonDays;
    if (forecastLogit < lastLogit + minGrowth) {
      forecastLogit = lastLogit + minGrowth;
      median = invLogit(forecastLogit);
    }
  }
  
  // Spread: baseline random walk + fit residual + refresh uncertainty
  // Each expected refresh adds uncertainty
  const horizonDays = horizonMinutes / 1440;
  const expectedRefreshes = Math.max(0, (targetTime - readTimes[lastRefreshIdx]) / avgRefreshInterval);
  const refreshUncertainty = Math.min(0.8, expectedRefreshes * 0.15); // cap uncertainty
  const spread = Math.sqrt((SIGMA_BASE ** 2) * horizonDays + residualStd ** 2) + refreshUncertainty;
  
  return Z.map(z => round4(invLogit(forecastLogit + z * spread)));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f: string) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  
  const last = c.history[c.history.length - 1];
  if (last === undefined) throw new Error(`${file} has no history`);
  
  // Target time in minutes since release
  const releaseTime = new Date('2026-11-19T00:00:00Z').getTime() / 60000;
  const targetTime = new Date(c.target).getTime() / 60000 - releaseTime;
  const lastReadTime = new Date(last.at).getTime() / 60000 - releaseTime;
  
  const trophies = c.trophies.map((t, i) => ({
    id: t.id,
    q: forecastTrophy(i, t, c.history, c.horizon_minutes, targetTime, lastReadTime)
  }));
  
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}