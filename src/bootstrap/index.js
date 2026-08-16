import { EventEmitter } from "node:events";

import { loadConfig } from "./config.js";
import { ConfigurationError, LifecycleError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { createNodeEventValidator } from "../modules/watcher/debounced-watcher.js";

export function createBootstrap({ configOptions, logger: providedLogger, loggerOptions, watcher, indexer, validateEvent = createNodeEventValidator() } = {}) {
  let config;
  let logger;
  let stopPipeline;
  let state = "created";

  return Object.freeze({
    get config() {
      return config;
    },
    get state() {
      return state;
    },
    async start() {
      if (state === "running") return this;
      if (state !== "created" && state !== "stopped") {
        throw new LifecycleError(`Cannot start bootstrap from ${state}.`);
      }

      config = loadConfig(configOptions);
      logger = providedLogger ?? createLogger(loggerOptions);
      stopPipeline = startIndexPipeline({ watcher, indexer, validateEvent, logger });
      state = "running";
      logger.info("Nodeforge bootstrap started", { data_dir: config.dataDir });
      return this;
    },
    async stop() {
      if (state === "stopped" || state === "created") {
        state = "stopped";
        return;
      }
      if (state !== "running") {
        throw new LifecycleError(`Cannot stop bootstrap from ${state}.`);
      }

      logger.info("Nodeforge bootstrap stopped");
      await stopPipeline?.();
      stopPipeline = undefined;
      state = "stopped";
    }
  });
}

function startIndexPipeline({ watcher, indexer, validateEvent, logger }) {
  if (!watcher && !indexer) return undefined;
  if (!watcher || !indexer) {
    throw new ConfigurationError("The watcher-to-index pipeline requires both a watcher and an indexer.");
  }

  // This bus is process-local plumbing until Sprint 7 introduces the Event Store.
  const internalBus = new EventEmitter();
  const onWatcherEvent = (event) => {
    try {
      validateEvent(event);
      internalBus.emit("event", event);
    } catch (error) {
      logger.error("Rejected invalid watcher event before indexing", { error: error.message });
    }
  };
  const onIndexEvent = (event) => {
    void indexer.handle(event).catch((error) => logger.error("Indexing watcher event failed", { error: error.message, event_type: event.type }));
  };

  watcher.on("event", onWatcherEvent);
  internalBus.on("event", onIndexEvent);
  return async () => {
    watcher.off?.("event", onWatcherEvent);
    internalBus.off("event", onIndexEvent);
    await watcher.close?.();
  };
}
