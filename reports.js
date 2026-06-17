// Pure string builders for daemon output. Replace LLM-generated prose so the
// automatic loops make zero LLM calls.

function fmt(n, d = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(d) : '?';
}

/**
 * Build the deploy report (replaces the screener's 🚀 DEPLOYED prose).
 * @param {{ candidate?: object, audit?: object, deployResult?: object, deployAmount?: number, strategy?: string }} args
 * @returns {string}
 */
export function buildDeployReport({ candidate = {}, audit = {}, deployResult = {}, deployAmount, strategy } = {}) {
  const rc = deployResult.range_coverage || {};
  const activeBin = deployResult.active_bin ?? candidate.active_bin ?? '?';
  return [
    '🚀 DEPLOYED',
    '',
    `${candidate.name ?? '?'}`,
    `${candidate.pool ?? '?'}`,
    '',
    `◎ ${deployAmount ?? '?'} SOL | ${strategy ?? '?'} | bin ${activeBin}`,
    `Range: ${deployResult.min_price ?? '?'} → ${deployResult.max_price ?? '?'}`,
    `Range cover: ${fmt(rc.downside_pct)}% downside | ${fmt(rc.upside_pct)}% upside | ${fmt(rc.width_pct)}% total`,
    '',
    'MARKET',
    `Fee/TVL: ${candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? '?'}`,
    `Volume: $${candidate.volume_window ?? '?'}`,
    `TVL: $${candidate.tvl ?? candidate.active_tvl ?? '?'}`,
    `Volatility: ${candidate.volatility ?? '?'}`,
    `Organic: ${candidate.organic_score ?? '?'}`,
    `Mcap: $${candidate.mcap ?? '?'}`,
    '',
    'AUDIT',
    `Top10: ${audit.top10Pct ?? '?'}%`,
    `Bots: ${audit.botPct ?? '?'}%`,
    `Fees paid: ${audit.feesSol ?? '?'} SOL`,
    `Smart wallets: ${audit.smartWallets ?? 'none'}`,
  ].join('\n');
}

/**
 * Build the hourly health summary (replaces the LLM health-check narration).
 * @param {{ positions?: object[], totals?: object, performance?: object }} args
 * @returns {string}
 */
export function buildHealthSummary({ positions = [], totals = {}, performance = {} } = {}) {
  const lines = ['🩺 HEALTH CHECK', ''];
  lines.push(`Open positions: ${positions.length}`);
  lines.push(`Portfolio value: $${fmt(totals.value_usd)}`);
  lines.push(`Unclaimed fees: $${fmt(totals.unclaimed_usd)}`);
  if (performance && performance.closed_count != null) {
    lines.push(`Closed (all-time): ${performance.closed_count} | win rate ${fmt(performance.win_rate, 0)}% | avg PnL ${fmt(performance.avg_pnl_pct)}%`);
  }
  lines.push('');
  for (const p of positions) {
    const inRange = p.in_range ? '🟢 IN' : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
    lines.push(`${p.pair ?? p.pool_name ?? '?'} | PnL ${fmt(p.pnl_pct)}% | yield ${p.fee_per_tvl_24h ?? '?'}% | ${inRange}`);
  }
  return lines.join('\n');
}
