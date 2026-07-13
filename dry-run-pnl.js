// Pure dry-run PnL/fee simulation. No I/O, no clock, no SDK imports.
// Model: a single-sided position deploys quote/SOL across bins [L, U] (all <= D).
// As the live active bin A falls below a bin b, that bin's SOL converts to base
// token at p(b); the token is marked to the current price p(A). PnL is measured
// in SOL. Fees accrue from the real pool 24h fee/TVL while in range.

/**
 * Per-bin liquidity weight.
 * @param {number} b binId
 * @param {number} D deploy active bin
 * @param {number} L range min bin
 * @param {number} U range max bin
 * @param {'bid_ask'|'spot'|'curve'} strategy
 * @returns {number} weight (>= 1)
 */
export function binWeight(b, D, L, U, strategy) {
  const dist = Math.abs(b - D);
  if (strategy === 'spot') return 1;
  if (strategy === 'curve') {
    const maxDist = Math.max(Math.abs(L - D), Math.abs(U - D));
    return Math.max(1, (maxDist - dist) + 1); // peak at active, tapering to edges
  }
  // bid_ask (default): linear ramp, heaviest at the far edge.
  // Any unrecognised strategy also falls through to this branch.
  return dist + 1;
}

/**
 * Simulate dry-run position PnL and fees.
 * @param {object} p
 * @param {number} p.amountSol         capital deployed (SOL)
 * @param {{min:number,max:number}} p.binRange
 * @param {number} p.activeBinAtDeploy D
 * @param {number|null} p.currentActiveBin A (null → unchanged)
 * @param {number} p.binStep           bps
 * @param {'bid_ask'|'spot'|'curve'} [p.strategy]
 * @param {number|null} [p.feePerTvl24h] pool 24h fee/TVL as a PERCENT (7 = 7%),
 *                                       same units as the LOW_YIELD rule. null → 0 fees.
 * @param {number} [p.minutesInRange]
 * @param {number} [p.solPrice]         USD per SOL (0 → USD fields 0)
 * @param {number|null} [p.originalAmountSol] Original capital at first entry, for
 *                                             cumulative PnL across rebalances.
 *                                             null/omitted → falls back to amountSol
 *                                             (identical to pre-rebalance-support behavior).
 * @param {number} [p.harvestedSol]     Cumulative SOL ever withdrawn via partial harvests.
 *                                       This is a PROPORTIONAL slice of principal + profit
 *                                       combined (matches Meteora's on-chain rebalance
 *                                       semantics), not profit-isolated — see pnlSol below
 *                                       for how that's reconciled. Default 0.
 * @returns {{pnl_pct:number, pnl_usd:number, fees_earned_usd:number,
 *            position_value_sol:number, price_pnl_sol:number, fees_sol:number}}
 */
export function simulateDryRunPnl({
  amountSol,
  binRange,
  activeBinAtDeploy,
  currentActiveBin,
  binStep,
  strategy = 'bid_ask',
  feePerTvl24h = null,
  minutesInRange = 0,
  solPrice = 0,
  originalAmountSol = null,
  harvestedSol = 0,
}) {
  const L = binRange?.min;
  const U = binRange?.max;
  const D = activeBinAtDeploy;
  const A = currentActiveBin == null ? D : currentActiveBin; // null → unchanged
  const s = (binStep ?? 0) / 1e4;

  const amount = Number.isFinite(amountSol) && amountSol > 0 ? amountSol : 0;

  const valid =
    amount > 0 &&
    Number.isFinite(L) && Number.isFinite(U) && U >= L &&
    Number.isFinite(D) && Number.isFinite(A) && s > 0;

  let positionValueSol = amount;
  let pricePnlSol = 0;

  if (valid) {
    let totalW = 0;
    for (let b = L; b <= U; b++) totalW += binWeight(b, D, L, U, strategy);

    let V = 0;
    for (let b = L; b <= U; b++) {
      const solDeployB = amount * (binWeight(b, D, L, U, strategy) / totalW);
      if (A >= b) {
        V += solDeployB;                                // unconverted — still SOL
      } else {
        V += solDeployB * Math.pow(1 + s, A - b);       // converted to base, marked to p(A)
      }
    }
    positionValueSol = V;
    pricePnlSol = V - amount;
  }

  // Fee accrual — only while in range, from real pool 24h fee/TVL (percent units).
  const feePct = Number.isFinite(feePerTvl24h) ? feePerTvl24h : 0;
  const inRangeMin = Math.max(0, Number.isFinite(minutesInRange) ? minutesInRange : 0);
  const feesSol = amount * (feePct / 100) * (inRangeMin / 1440);

  const harvested = Number.isFinite(harvestedSol) ? harvestedSol : 0;
  const denom = (Number.isFinite(originalAmountSol) && originalAmountSol > 0)
    ? originalAmountSol
    : (amount > 0 ? amount : 1);
  // Cumulative PnL = (current leg's total value + everything ever withdrawn) - original capital,
  // all divided by original capital. `amount + pricePnlSol + feesSol` is the current leg's
  // mark-to-market value (leg start + price move + fees); `harvested` is the FULL amount ever
  // withdrawn via partial harvests (principal + profit combined, not profit-isolated — matches
  // how rebalancePosition/recordRebalance actually compute and store it). Subtracting the
  // original capital baseline at the end (not folding it into `denom` alone) is what makes this
  // correct across multiple rebalances: `amount` drifts upward with every compound and downward
  // with every harvest, and this formula reconciles that drift instead of assuming `amount` stays
  // pinned at `originalAmountSol` forever (which is what the pre-fix formula implicitly assumed,
  // and why it broke after any rebalance).
  const pnlSol = (amount + pricePnlSol + feesSol + harvested) - denom;
  const px = Number.isFinite(solPrice) ? solPrice : 0;

  return {
    pnl_pct: (pnlSol / denom) * 100,
    pnl_usd: px > 0 ? pnlSol * px : 0,
    fees_earned_usd: px > 0 ? feesSol * px : 0,
    position_value_sol: positionValueSol,
    price_pnl_sol: pricePnlSol,
    fees_sol: feesSol,
  };
}
