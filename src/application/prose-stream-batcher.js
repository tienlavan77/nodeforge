'use strict';

/**
 * Coalesces token deltas into readable prose updates while preserving terminal
 * events. The returned object is intentionally transport agnostic so it can be
 * used by the runtime and SSE adapters alike.
 */
class ProseStreamBatcher {
  constructor({ delayMs = 500, onBatch } = {}) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('delayMs must be a non-negative number');
    }
    if (typeof onBatch !== 'function') {
      throw new TypeError('onBatch must be a function');
    }
    this.delayMs = delayMs;
    this.onBatch = onBatch;
    this.pending = '';
    this.timer = null;
    this.seen = new Set();
    this.closed = false;
  }

  push(event) {
    if (this.closed || !event || event.messageId && this.seen.has(event.messageId)) return false;
    if (event.messageId) this.seen.add(event.messageId);

    const type = event.type || event.event;
    const delta = event.delta ?? event.text;
    if ((type === 'agent.delta' || type === 'agent.token' || type === 'delta') && typeof delta === 'string') {
      this.pending += delta;
      this.schedule();
      return true;
    }

    this.flush();
    this.onBatch(event);
    if (type === 'agent.completed' || type === 'agent.failed' || type === 'agent.timeout' || type === 'completed' || type === 'failed') {
      this.close();
    }
    return true;
  }

  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  flush() {
    if (!this.pending) return false;
    const text = this.pending;
    this.pending = '';
    this.onBatch({ type: 'agent.prose', delta: text });
    return true;
  }

  close() {
    if (this.closed) return;
    this.flush();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closed = true;
  }
}

module.exports = { ProseStreamBatcher };
