import { EventEmitter } from "node:events";

import { loadConfig } from "./config.js";
import { ConfigurationError, LifecycleError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import { createNodeEventValidator } from "../modules/watcher/debounced-watcher.js";
import { bridgeAgentStream } from "../modules/agents/agent-stream-bridge.js";

export function createBootstrap({ configOptions, logger: providedLogger, loggerOptions, watcher, indexer, agentProcesses = [], internalBus = new EventEmitter(), validateEvent = createNodeEventValidator() } = {}) {
  if (!Array.isArray(agentProcesses) || !internalBus?.on || !internalBus?.emit) {
    throw new ConfigurationError("Agent processes must be an array and internalBus must be an event emitter.");
  }
  let config;
  let logger;
  let stopPipeline;
  let stopAgentStreams;
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
      stopPipeline = startIndexPipeline({ watcher, indexer, internalBus, validateEvent, logger });
      stopAgentStreams = agentProcesses.map((agent) => bridgeAgentStream({ agent, internalBus }));
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
      for (const stopStream of stopAgentStreams ?? []) stopStream();
      stopAgentStreams = undefined;
      await stopPipeline?.();
      stopPipeline = undefined;
      state = "stopped";
    }
  });
}

function startIndexPipeline({ watcher, indexer, internalBus, validateEvent, logger }) {
  if (!watcher && !indexer) return undefined;
  if (!watcher || !indexer) {
    throw new ConfigurationError("The watcher-to-index pipeline requires both a watcher and an indexer.");
  }

  // Each bootstrap owns one bus, so concurrent project pipelines never share events.
  const onWatcherEvent = (event) => {
    try {
      validateEvent(event);
      internalBus.emit("event", event);
    } catch (error) {
      logger.error("Rejected invalid watcher event before indexing", { error: error.message });
    }
  };
  const onIndexEvent = (event) => {
    void indexer.handle(event)
      .then((indexed) => {
        if (indexed) logger.info("Indexed watcher event", { event_type: event.type, path: event.payload.path });
      })
      .catch((error) => logger.error("Indexing watcher event failed", { error: error.message, event_type: event.type }));
  };

  watcher.on("event", onWatcherEvent);
  internalBus.on("event", onIndexEvent);
  return async () => {
    watcher.off?.("event", onWatcherEvent);
    internalBus.off("event", onIndexEvent);
    await watcher.close?.();
  };
}
