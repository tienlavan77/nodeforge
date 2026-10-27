// Keeps queue dispatch responsive while independent ticket agents run, and retains observable errors for detached result collection.
import { blockerRecoveryError } from "./blocker-recovery-errors.js";

// Observes every dispatched completion so persistence failures remain visible without making the queue wait for an SDK result.
export function observeBlockerRecoveryWork(completion, logger, job) {
  void completion.catch((error) => {
    logger.error?.(`Blocker recovery completion failed: ${error.message}`, blockerRecoveryError(error, job));
  });
}

// Serializes short reservation scans while provider invocations finish independently under their durable ticket reservations.
export function createBlockerRecoveryPoller({ tick, logger }) {
  let active = false;
  let timer;
  let scanning = false;
  return Object.freeze({ start, stop });

  // Starts dispatch without waiting for a previously launched agent to return its report.
  async function start() { if (active) return; active = true; void poll(); }

  // Stops new scans while existing result collectors retain responsibility for their already dispatched work.
  function stop() { active = false; clearTimeout(timer); }

  // Contains scan failures and prevents overlapping scans during slow storage access or a local stop/start cycle.
  async function poll() {
    if (!active || scanning) return;
    scanning = true;
    try { await tick(); }
    catch (error) { logger.error?.(`Blocker recovery poll failed: ${error.message}`, blockerRecoveryError(error)); }
    finally {
      scanning = false;
      if (active) { timer = setTimeout(poll, 1000); timer.unref?.(); }
    }
  }
}
