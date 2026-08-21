import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { ConfigurationError } from "../../shared/errors.js";
import { createFileRepository } from "../index/file-repository.js";
import { createSecretPathMatcher } from "../context/secret-paths.js";

export function createContextReadHandler({ agent, database, projectId, projectRoot, files = createFileRepository(database), createEventId = () => `EVT-${randomUUID()}`, clock = () => new Date(), nodeId = "NODE-001", config = {} } = {}) {
  if (!agent?.on || !agent?.off || typeof agent.sendEvent !== "function" || !database?.all || !files?.findByPath) {
    throw new ConfigurationError("An agent process, SQLite database, and file repository are required for context reads.");
  }
  if (typeof projectId !== "string" || projectId.length === 0 || typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project_id and project root are required for context reads.");
  }

  const onMessage = (envelope) => {
    if (envelope.message?.type !== "context.read_file") return;
    void handle(envelope).catch((error) => events.emit("protocol_error", error));
  };
  const events = new EventEmitter();
  const isSecretPath = createSecretPathMatcher(config.secretsPatterns);
  agent.on("message", onMessage);

  async function handle(envelope) {
    const command = envelope.message;
    if (command.project_id !== projectId) {
      throw new ConfigurationError("context.read_file project_id does not match this Node project.");
    }
    const path = assertIndexedProjectPath(command.payload?.path);
    if (isSecretPath(path)) throw new ConfigurationError("Context reads of secret paths are not permitted.");
    const file = files.findByPath(path);
    if (!file) throw new ConfigurationError(`context.read_file requested an unindexed path: ${path}`);

    // Resolve through the Code Index first; only Node reads the matching project file.
    const content = await readFile(resolve(projectRoot, path), "utf8");
    const symbols = database.all(
      "SELECT symbol_id, name, kind, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line, name",
      [file.file_id]
    );
    const timestamp = clock().toISOString();
    await agent.sendEvent({
      protocol_version: envelope.protocol_version,
      message_id: `MSG-${randomUUID()}`,
      sender: { id: nodeId, type: "system", role: "context-engine" },
      receiver: envelope.sender,
      timestamp,
      message: {
        event_id: createEventId(),
        type: "context.pack_generated",
        project_id: projectId,
        session_id: command.session_id,
        request_id: command.request_id,
        timestamp,
        payload: { path, file, symbols, content }
      }
    });
  }

  function assertIndexedProjectPath(path) {
    if (typeof path !== "string" || path.length === 0) {
      throw new ConfigurationError("context.read_file requires payload.path.");
    }
    const absolutePath = resolve(projectRoot, path);
    const pathWithinProject = relative(projectRoot, absolutePath);
    if (pathWithinProject === "" || pathWithinProject.startsWith("..") || resolve(projectRoot, pathWithinProject) !== absolutePath) {
      throw new ConfigurationError("context.read_file path must stay within the project root.");
    }
    return pathWithinProject;
  }

  return Object.freeze({
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    close() {
      agent.off("message", onMessage);
    }
  });
}
