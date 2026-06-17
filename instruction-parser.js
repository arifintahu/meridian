// Parses free-text position instructions into deterministic close conditions.
// Conservative: only unambiguous threshold patterns are recognized. Anything
// ambiguous returns null so the caller HOLDs rather than guessing.

/**
 * @param {string} text
 * @returns {{ metric: 'pnl_pct'|'value_usd', op: '>='|'<=', value: number } | null}
 */
export function parseInstruction(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().trim();

  // Metric: dollar/value wording → value_usd; pnl wording or a bare % → pnl_pct.
  let metric = null;
  if (/\bvalue\b|\bworth\b|\busd\b|\$/.test(t)) metric = 'value_usd';
  else if (/\bpnl\b|\bprofit\b|\bp&l\b|\breturn\b/.test(t) || /%/.test(t)) metric = 'pnl_pct';
  if (!metric) return null;

  // Direction: exactly one of up/down must be present.
  const up = /(>=|≥|at least|>|above|over|exceeds?|reaches?|hits?)/.test(t);
  const down = /(<=|≤|at most|<|below|under|drops? below|falls? below|dips? below)/.test(t);
  if (up === down) return null; // neither, or both → ambiguous
  const op = up ? '>=' : '<=';

  // Number: first numeric token, optional leading '-' and '$'.
  const numMatch = t.match(/-?\$?\d+(?:\.\d+)?/);
  if (!numMatch) return null;
  const value = Number(numMatch[0].replace(/\$/g, ''));
  if (!Number.isFinite(value)) return null;

  return { metric, op, value };
}

/**
 * @param {{ metric: string, op: string, value: number } | null} parsed
 * @param {{ pnl_pct?: number, total_value_usd?: number }} position
 * @returns {boolean} whether the close condition is met
 */
export function evaluateInstruction(parsed, position) {
  if (!parsed || !position) return false;
  const field = parsed.metric === 'pnl_pct' ? position.pnl_pct : position.total_value_usd;
  if (field == null || !Number.isFinite(Number(field))) return false;
  const v = Number(field);
  return parsed.op === '>=' ? v >= parsed.value : v <= parsed.value;
}
