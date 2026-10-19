// Coordinates exactly-once resource disposal across project removal and legacy Control API shutdown.
const resources = new WeakMap();

// Gives each acquired application resource a shared cleanup operation without changing its normal methods.
export function createApplicationDisposal() {
  const entries = new Map();
  let closing;
  return Object.freeze({ own, close });

  // Registers a resource immediately and preserves its receiver for cleanup and ordinary operations.
  function own(resource, method, order) {
    if (!resource || typeof resource[method] !== "function") return resource;
    if (closing) throw new Error("Cannot acquire resources after application disposal starts.");
    let methods = resources.get(resource);
    if (!methods) { methods = new Map(); resources.set(resource, methods); }
    let entry = methods.get(method);
    if (!entry) {
      let result;
      // Memoizes before invoking cleanup, including synchronous failures and concurrent callers.
      const dispose = () => { result ??= Promise.resolve().then(() => resource[method].call(resource)); return result; };
      const handle = Object.fromEntries(Object.entries(resource).map(([key, value]) => [key, typeof value === "function" ? value.bind(resource) : value]));
      handle[method] = dispose;
      entry = { dispose, handle };
      methods.set(method, entry);
      resources.set(handle, methods);
    }
    entries.set(entry, order);
    return entry.handle;
  }

  // Drains resources in dependency order and preserves every failure without repeating underlying cleanup.
  function close() {
    closing ??= Promise.resolve().then(async () => {
      const errors = [];
      for (const [entry] of [...entries].sort((left, right) => left[1] - right[1])) {
        try { await entry.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Project application disposal failed.");
    });
    return closing;
  }
}
