/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { getRecorder } from './experiment-recorder.js';

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

// In-range drawdown clock tolerance. A single management tick (~managementIntervalMin
// apart) back above the drawdown floor must NOT reset the sustained-loss clock —
// otherwise a choppy in-range bleed that pokes above the floor between ticks keeps
// restarting the timer, so "N continuous minutes below the floor" never holds (the
// rule fired 0× across two staging runs). Only a recovery sustained for at least this
// long clears the clock. Sized above one management cycle so an isolated bounce tick
// is tolerated but a genuine multi-tick recovery resets.
const IN_RANGE_DRAWDOWN_RECOVERY_GRACE_MIN = 15;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    in_range_drawdown_since: null,
    in_range_drawdown_recovery_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  getRecorder()?.recordDeploy(position, state.positions[position]);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Pure predicate: should a position close for low yield?
 * Requires a real (finite) age past the gate AND a real (non-null) fee/TVL
 * reading below the floor. A null/undefined age or null yield never closes —
 * this prevents closing a brand-new position before it can accrue fees.
 */
export function isLowYieldClose({ feePerTvl24h, minFeePerTvl24h, ageMinutes, minAgeBeforeYieldCheck }) {
  const minAge = minAgeBeforeYieldCheck ?? 60;
  return (
    feePerTvl24h != null &&
    minFeePerTvl24h != null &&
    Number.isFinite(ageMinutes) &&
    ageMinutes >= minAge &&
    feePerTvl24h < minFeePerTvl24h
  );
}

/**
 * Pure predicate: should a position close for a sustained in-range drawdown?
 *
 * Catches the failure mode no other rule reaches — a single-sided position that
 * bleeds while staying *in range* (OOR never fires, the hard stop is deeper).
 * Keys on absolute PnL (not from-peak like trailing TP): the clock must have been
 * running (minutesInDrawdown finite, i.e. PnL has sat at/below the floor) for at
 * least the wait window, and PnL must still be at/below the floor on this tick.
 * Returns false unless explicitly enabled — preserves current behavior by default.
 */
export function isSustainedDrawdownClose({ pnlPct, drawdownExitPct, minutesInDrawdown, drawdownWaitMinutes, enabled }) {
  const wait = drawdownWaitMinutes ?? 60;
  return (
    enabled === true &&
    drawdownExitPct != null &&
    pnlPct != null &&
    pnlPct <= drawdownExitPct &&
    Number.isFinite(minutesInDrawdown) &&
    minutesInDrawdown >= wait
  );
}

/**
 * Pure predicate: is a trailing-TP drop severe enough to skip the 15s whipsaw
 * recheck and confirm the exit immediately?
 *
 * The recheck exists to ignore a marginal drop that bounces straight back. But a
 * drop that has already given back all gains (current PnL <= 0) or run to
 * >= severeMult x the trailing target is an unambiguous reversal, not noise —
 * waiting 15s only lets a fast dump bleed further (cost ~6% on one AIAIAI
 * position in exp-488b8252, which exited at -3.58% off a +4.13% peak). Returns
 * false for a marginal drop so the normal recheck still protects the win cases.
 */
export function isSevereTrailingDrop({ currentPnlPct, dropFromPeak, trailingDropPct, severeMult = 2 }) {
  if (currentPnlPct != null && currentPnlPct <= 0) return true;
  if (
    dropFromPeak != null &&
    trailingDropPct != null &&
    dropFromPeak >= severeMult * trailingDropPct
  ) {
    return true;
  }
  return false;
}

/**
 * Pure transition for the in-range drawdown clock — the timer that feeds
 * isSustainedDrawdownClose. Given this tick and the existing clock fields,
 * returns the next `{ since, recoverySince }` (epoch ms, or null = unset).
 *
 * Tolerates brief recoveries: a single tick above the floor does NOT clear an
 * already-running clock — it opens a recovery grace window instead. Only a
 * recovery sustained for `graceMin` clears the clock. A tick back below the
 * floor cancels any pending grace and keeps the original start time. This is
 * what lets the rule survive a choppy in-range bleed (the old hard reset on any
 * above-floor tick is why it fired 0× across two staging runs).
 *
 * @param {object} p
 * @param {boolean} p.inDrawdown  current tick is in-range AND at/below the floor
 * @param {number|null} p.since   clock start (epoch ms) or null
 * @param {number|null} p.recoverySince  recovery-window start (epoch ms) or null
 * @param {number} p.now          current time (epoch ms)
 * @param {number} p.graceMin     minutes a recovery must persist to clear the clock
 */
export function nextDrawdownClockState({ inDrawdown, since, recoverySince, now, graceMin }) {
  if (inDrawdown) {
    // Below the floor: ensure the clock is running and cancel any pending recovery.
    return { since: since ?? now, recoverySince: null };
  }
  if (since == null) {
    // Above the floor and no clock running — nothing to track.
    return { since: null, recoverySince: null };
  }
  // Above the floor while the clock runs: time the recovery, clear only once sustained.
  if (recoverySince == null) {
    return { since, recoverySince: now };
  }
  const recoveredMin = Math.floor((now - recoverySince) / 60000);
  if (recoveredMin >= graceMin) {
    return { since: null, recoverySince: null };
  }
  return { since, recoverySince };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  // Update in-range drawdown clock (sustained-loss timer).
  // Only runs on trustworthy in-range ticks: a confirmed-OOR break is handled
  // faster by the OOR rule, and a suspicious PnL tick is ignored entirely so a
  // bad reading can neither start nor clear the clock.
  //
  // The clock tolerates brief recoveries: a single tick back above the floor does
  // NOT clear it. Only a recovery sustained for IN_RANGE_DRAWDOWN_RECOVERY_GRACE_MIN
  // resets the timer. Firing still requires the current tick to be at/below the floor
  // (isSustainedDrawdownClose checks pnlPct <= floor), so a genuine bounce never
  // triggers an exit while a stale clock winds down.
  if (mgmtConfig.inRangeDrawdownExitEnabled && mgmtConfig.inRangeDrawdownPct != null && !pnl_pct_suspicious) {
    const inDrawdown =
      currentPnlPct != null && in_range !== false && currentPnlPct <= mgmtConfig.inRangeDrawdownPct;
    const prevSince = pos.in_range_drawdown_since ? new Date(pos.in_range_drawdown_since).getTime() : null;
    const prevRecovery = pos.in_range_drawdown_recovery_since ? new Date(pos.in_range_drawdown_recovery_since).getTime() : null;
    const next = nextDrawdownClockState({
      inDrawdown,
      since: prevSince,
      recoverySince: prevRecovery,
      now: Date.now(),
      graceMin: IN_RANGE_DRAWDOWN_RECOVERY_GRACE_MIN,
    });
    if (next.since !== prevSince || next.recoverySince !== prevRecovery) {
      if (prevSince == null && next.since != null) {
        log("state", `Position ${position_address} entered in-range drawdown (PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.inRangeDrawdownPct}%)`);
      } else if (prevSince != null && next.since == null) {
        log("state", `Position ${position_address} exited in-range drawdown (sustained recovery >= ${IN_RANGE_DRAWDOWN_RECOVERY_GRACE_MIN}m)`);
      }
      pos.in_range_drawdown_since = next.since == null ? null : new Date(next.since).toISOString();
      pos.in_range_drawdown_recovery_since = next.recoverySince == null ? null : new Date(next.recoverySince).toISOString();
      changed = true;
    }
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── In-range sustained drawdown ────────────────────────────────
  // Softer, time-confirmed net below the hard stop: cuts positions that bleed
  // while staying in range (the OOR rule never fires, the hard stop is deeper).
  if (!pnl_pct_suspicious && pos.in_range_drawdown_since) {
    const minutesInDrawdown = Math.floor((Date.now() - new Date(pos.in_range_drawdown_since).getTime()) / 60000);
    if (isSustainedDrawdownClose({
      pnlPct: currentPnlPct,
      drawdownExitPct: mgmtConfig.inRangeDrawdownPct,
      minutesInDrawdown,
      drawdownWaitMinutes: mgmtConfig.inRangeDrawdownWaitMinutes,
      enabled: mgmtConfig.inRangeDrawdownExitEnabled,
    })) {
      return {
        action: "IN_RANGE_DRAWDOWN",
        reason: `In-range drawdown: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.inRangeDrawdownPct}% for ${minutesInDrawdown}m (limit: ${mgmtConfig.inRangeDrawdownWaitMinutes ?? 60}m)`,
      };
    }
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  if (isLowYieldClose({
    feePerTvl24h: fee_per_tvl_24h,
    minFeePerTvl24h: mgmtConfig.minFeePerTvl24h,
    ageMinutes: age_minutes,
    minAgeBeforeYieldCheck: mgmtConfig.minAgeBeforeYieldCheck,
  })) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
