import { insertScreeningEvent } from './db/screening.js';
import { insertPosition, updatePositionClose, insertSnapshot } from './db/positions.js';

let _recorder = null;

/** Returns the active ExperimentRecorder, or null if not in experiment mode. */
export const getRecorder = () => _recorder;

/** Initialize the singleton recorder. Called once from experiment.js. */
export function initRecorder(db, experimentId) {
  _recorder = new ExperimentRecorder(db, experimentId);
}

/** Reset singleton — used in tests only. */
export function clearRecorder() {
  _recorder = null;
}

class ExperimentRecorder {
  constructor(db, experimentId) {
    this._db = db;
    this._experimentId = experimentId;
  }

  /**
   * Called from decision-log.js appendDecision().
   * Records every screening cycle decision.
   */
  recordScreening(entry) {
    try {
      insertScreeningEvent(this._db, this._experimentId, entry);
    } catch (err) {
      console.error('[recorder] recordScreening error:', err.message);
    }
  }

  /**
   * Called from state.js trackPosition().
   * Records a new dry-run position deploy.
   */
  recordDeploy(positionAddress, data) {
    try {
      insertPosition(this._db, this._experimentId, {
        ...data,
        position: positionAddress,
        deployed_at: Date.now(),
      });
    } catch (err) {
      console.error('[recorder] recordDeploy error:', err.message);
    }
  }

  /**
   * Called from index.js management cycle after recordPositionSnapshot().
   * Records periodic PnL snapshot.
   */
  recordSnapshot(pool, positionData) {
    try {
      if (!positionData?.position) return;
      insertSnapshot(this._db, this._experimentId, positionData.position, {
        pnl_pct:         positionData.pnl_pct ?? null,
        in_range:        !positionData.out_of_range_since,
        fees_earned_usd: positionData.total_fees_claimed_usd ?? 0,
      });
    } catch (err) {
      console.error('[recorder] recordSnapshot error:', err.message);
    }
  }

  /**
   * Called from lessons.js recordPerformance().
   * Fills in close-time metrics on the position row.
   */
  recordClose(positionAddress, perf) {
    try {
      const deployedAt = perf.deployed_at ? new Date(perf.deployed_at).getTime() : null;
      const closedAt   = perf.closed_at   ? new Date(perf.closed_at).getTime()   : Date.now();
      const minutesHeld = deployedAt && !isNaN(deployedAt)
        ? (closedAt - deployedAt) / 60000
        : (perf.minutes_held ?? null);

      updatePositionClose(this._db, positionAddress, {
        closed_at:        closedAt,
        close_reason:     perf.close_reason || null,
        minutes_held:     minutesHeld,
        minutes_in_range: perf.minutes_in_range ?? null,
        range_efficiency: perf.range_efficiency ?? null,
        fees_earned_usd:  perf.fees_earned_usd ?? 0,
        pnl_usd:          perf.pnl_usd ?? null,
        pnl_pct:          perf.pnl_pct ?? null,
      });
    } catch (err) {
      console.error('[recorder] recordClose error:', err.message);
    }
  }
}
