// Debounced filesystem watcher with rename detection and event validation.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { projectIndexPath } from "../../infrastructure/filesystem/project-index-path.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const coreEventSchema = require("../../../../schemas/core/event.schema.json");
const nodeEventSchema = require("../../../../schemas/node/node-event.schema.json");
const RAW_EVENT_TYPES = Object.freeze({ add: "watcher.file_created", change: "watcher.file_modified", unlink: "watcher.file_deleted" });

// Defines createNodeEventValidator function behavior for debounced-watcher.js.
export function createNodeEventValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(coreEventSchema).addSchema(nodeEventSchema);
  const validate = ajv.getSchema(nodeEventSchema.$id);

  return (event) => {
    if (!validate(event)) throw new ConfigurationError(`Invalid watcher event: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

// Defines createDebouncedWatcher function behavior for debounced-watcher.js.
export function createDebouncedWatcher({ rawWatcher, projectId, root, debounceMs = 200, renameWindowMs = 500, createEventId = defaultEventId, clock = () => new Date(), getContentHash = readContentHash, validateEvent = createNodeEventValidator() } = {}) {
  if (!rawWatcher?.on || typeof projectId !== "string" || projectId.length === 0 || typeof root !== "string" || root.length === 0) {
    throw new ConfigurationError("A raw watcher, project ID, and project root are required.");
  }
  if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 300) {
    throw new ConfigurationError("watcher debounceMs must be an integer from 100 to 300.");
  }
  if (!Number.isInteger(renameWindowMs) || renameWindowMs < 100) {
    throw new ConfigurationError("watcher renameWindowMs must be an integer of at least 100.");
  }

  const events = new EventEmitter();
  const tasks = new Set();
  let closed = false;
  let closing;
  const pending = new Map();
  const contentHashes = new Map();
  const rejectedPaths = new Set();
  const pendingDeletes = new Map();
  const pendingAdds = new Map();
  const listeners = Object.keys(RAW_EVENT_TYPES).map((rawType) => [rawType, (path) => schedule(rawType, path)]);
  listeners.push(["error", reportError]);
  for (const [rawType, listener] of listeners) rawWatcher.on(rawType, listener);

  // Defines schedule function behavior for debounced-watcher.js.
  function schedule(rawType, path) {
    const projectPath = relative(resolve(root), resolve(root, path));
    if (projectPath === ".." || projectPath.startsWith(`..${sep}`) || isAbsolute(projectPath)) {
      reportError(new ConfigurationError("Watcher path is outside the selected project root."));
      return;
    }
    path = resolve(root, path);
    const existing = pending.get(path);
    if (existing) clearTimeout(existing.timer);

    const effectiveType = existing?.rawType === "add" && rawType === "change" ? "add" : rawType;
    const timer = setTimeout(() => {
      pending.delete(path);
      const task = handleStableEvent(effectiveType, path).catch(reportError).finally(() => tasks.delete(task));
      tasks.add(task);
    }, debounceMs);
    pending.set(path, { rawType: effectiveType, timer });
  }

  // Defines handleStableEvent function behavior for debounced-watcher.js.
  async function handleStableEvent(rawType, path) {
    if (rawType === "unlink" && rejectedPaths.has(path)) return;
    let indexPath;
    try {
      indexPath = projectIndexPath(root, path, { allowMissing: rawType === "unlink" });
      if (rawType !== "unlink") rejectedPaths.delete(path);
    } catch (error) {
      rejectedPaths.add(path);
      throw error;
    }
    if (rawType === "unlink") {
      const oldHash = contentHashes.get(path);
      const pendingAdd = pendingAdds.get(path);
      if (pendingAdd) {
        clearTimeout(pendingAdd.timer);
        pendingAdds.delete(path);
      }
      const renamedTo = oldHash ? findPendingAdd(oldHash) : null;
      if (renamedTo) {
        const pendingAdd = pendingAdds.get(renamedTo);
        clearTimeout(pendingAdd.timer);
        pendingAdds.delete(renamedTo);
        contentHashes.delete(path);
        emit("watcher.file_renamed", renamedTo, "rename", path);
        return;
      }
      holdDeleteForRename(path, contentHashes.get(path));
      return;
    }

    const hash = await getContentHash(indexPath);
    if (closed) return;
    if (hash) contentHashes.set(path, hash);

    if (rawType === "add") {
      const renamedFrom = hash ? findPendingDelete(hash) : null;
      if (renamedFrom) {
        const pendingDelete = pendingDeletes.get(renamedFrom);
        clearTimeout(pendingDelete.timer);
        pendingDeletes.delete(renamedFrom);
        contentHashes.delete(renamedFrom);
        emit("watcher.file_renamed", path, "rename", renamedFrom);
        return;
      }
      holdAddForRename(path, hash);
      return;
    }

    emit(RAW_EVENT_TYPES[rawType], path, rawType);
  }

  // Defines holdDeleteForRename function behavior for debounced-watcher.js.
  function holdDeleteForRename(path, hash) {
    if (!hash) {
      emit("watcher.file_deleted", path, "unlink");
      return;
    }
    const timer = setTimeout(() => {
      pendingDeletes.delete(path);
      contentHashes.delete(path);
      emit("watcher.file_deleted", path, "unlink");
    }, renameWindowMs);
    pendingDeletes.set(path, { hash, timer });
  }

  // Defines holdAddForRename function behavior for debounced-watcher.js.
  function holdAddForRename(path, hash) {
    if (!hash) {
      emit("watcher.file_created", path, "add");
      return;
    }
    const timer = setTimeout(() => {
      pendingAdds.delete(path);
      emit("watcher.file_created", path, "add");
    }, renameWindowMs);
    pendingAdds.set(path, { hash, timer });
  }

  // Defines findPendingDelete function behavior for debounced-watcher.js.
  function findPendingDelete(hash) {
    for (const [path, pendingDelete] of pendingDeletes) {
      if (pendingDelete.hash === hash) return path;
    }
    return null;
  }

  // Defines findPendingAdd function behavior for debounced-watcher.js.
  function findPendingAdd(hash) {
    for (const [path, pendingAdd] of pendingAdds) {
      if (pendingAdd.hash === hash) return path;
    }
    return null;
  }

  // Defines emit function behavior for debounced-watcher.js.
  function emit(type, path, operation, oldPath) {
    const payload = { path: relativePath(path), operation };
    if (oldPath) payload.old_path = relativePath(oldPath);
    const event = { event_id: createEventId(), type, project_id: projectId, timestamp: clock().toISOString(), payload };
    try { validateEvent(event); events.emit("event", event); }
    catch (error) { reportError(error); return; }
  }

  // Reports a failed filesystem event without terminating indexing for other project files.
  function reportError(error) {
    if (events.listenerCount("watcher.error")) events.emit("watcher.error", error);
    else console.error("Project watcher event failed.", error);
  }

  // Defines relativePath function behavior for debounced-watcher.js.
  function relativePath(path) {
    return relative(root, path).split(sep).join("/");
  }

  return Object.freeze({
    // Defines on method behavior for debounced-watcher.js.
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    // Defines off method behavior for debounced-watcher.js.
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    // Defines close method behavior for debounced-watcher.js.
    close() {
      if (closing) return closing;
      closed = true;
      for (const { timer } of pending.values()) clearTimeout(timer);
      for (const { timer } of pendingDeletes.values()) clearTimeout(timer);
      for (const { timer } of pendingAdds.values()) clearTimeout(timer);
      pending.clear();
      pendingDeletes.clear();
      pendingAdds.clear();
      for (const [rawType, listener] of listeners) rawWatcher.off?.(rawType, listener);
      closing = Promise.resolve().then(() => rawWatcher.close?.()).finally(async () => {
        await Promise.allSettled([...tasks]);
        events.removeAllListeners();
      });
      return closing;
    }
  });
}

// Defines readContentHash function behavior for debounced-watcher.js.
export async function readContentHash(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Defines defaultEventId function behavior for debounced-watcher.js.
function defaultEventId() {
  return `EVT-${randomUUID()}`;
}
