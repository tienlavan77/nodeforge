/** Deterministic ordering for task-scoped unified stream events. */
export function createUnifiedStreamOrderer() {
  const counters = new Map();
  return Object.freeze({ assign, compare });

  function assign(event) {
    const taskId = event?.task_id;
    const sequence = (counters.get(taskId) ?? 0) + 1;
    counters.set(taskId, sequence);
    return Object.freeze({ ...event, timestamp: normalizeTimestamp(event?.timestamp), sequence });
  }

  function compare(left, right) {
    const timestamp = String(left?.timestamp ?? "").localeCompare(String(right?.timestamp ?? ""));
    if (timestamp !== 0) return timestamp;
    return (left?.sequence ?? Number.MAX_SAFE_INTEGER) - (right?.sequence ?? Number.MAX_SAFE_INTEGER);
  }
}

export function normalizeTimestamp(value, clock = () => new Date()) {
  const date = value === undefined ? clock() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Unified stream event timestamp must be a valid date.");
  return date.toISOString();
}

export function sortUnifiedStreamEvents(events) {
  return events.map((event, index) => ({ event, index })).sort((a, b) => {
    const timestamp = String(a.event?.timestamp ?? "").localeCompare(String(b.event?.timestamp ?? ""));
    if (timestamp !== 0) return timestamp;
    const sequence = (a.event?.sequence ?? Number.MAX_SAFE_INTEGER) - (b.event?.sequence ?? Number.MAX_SAFE_INTEGER);
    return sequence !== 0 ? sequence : a.index - b.index;
  }).map(({ event }) => event);
}
