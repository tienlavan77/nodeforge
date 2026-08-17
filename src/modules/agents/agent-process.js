import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError, LifecycleError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const commandSchema = require("../../../schemas/core/command.schema.json");
const eventSchema = require("../../../schemas/core/event.schema.json");
const envelopeSchema = require("../../../schemas/core/envelope.schema.json");

export function createEnvelopeValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(commandSchema).addSchema(eventSchema).addSchema(envelopeSchema);
  const validate = ajv.getSchema(envelopeSchema.$id);

  return (envelope) => {
    if (!validate(envelope)) {
      throw new ConfigurationError(`Invalid agent envelope: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createCoreEventValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(eventSchema);
  const validate = ajv.getSchema(eventSchema.$id);

  return (event) => {
    if (!validate(event)) {
      throw new ConfigurationError(`Invalid agent lifecycle event: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createAgentProcess({ command, args = [], projectId, agentId, timeoutMs, terminateGraceMs = 1000, spawnProcess = spawn, validateEnvelope = createEnvelopeValidator(), validateEvent = createCoreEventValidator(), createEventId = () => `EVT-${randomUUID()}`, clock = () => new Date(), spawnOptions = {} } = {}) {
  if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) {
    throw new ConfigurationError("An agent command and argument array are required.");
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || typeof projectId !== "string" || projectId.length === 0)) {
    throw new ConfigurationError("A positive timeoutMs and project_id are required for agent timeout handling.");
  }
  if (!Number.isInteger(terminateGraceMs) || terminateGraceMs <= 0) {
    throw new ConfigurationError("terminateGraceMs must be a positive integer.");
  }

  const child = spawnProcess(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new LifecycleError("Agent process must expose stdin, stdout, and stderr streams.");
  }

  const events = new EventEmitter();
  let stdoutBuffer = "";
  let timedOut = false;
  let timeoutTimer;
  let forceKillTimer;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => processStdout(chunk));
  child.stderr.on("data", (chunk) => events.emit("stderr", chunk));
  child.on("error", (error) => events.emit("process_error", error));
  child.on("exit", (code, signal) => {
    clearTimeouts();
    if (timedOut) emitLifecycleEvent("agents.stopped", { reason: "timeout", exit_code: code, signal });
    events.emit("exit", { code, signal });
  });
  if (timeoutMs !== undefined) timeoutTimer = setTimeout(handleTimeout, timeoutMs);

  function handleTimeout() {
    timedOut = true;
    emitLifecycleEvent("agents.error", { reason: "timeout" });
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, terminateGraceMs);
  }

  function emitLifecycleEvent(type, payload) {
    const event = { event_id: createEventId(), type, project_id: projectId, timestamp: clock().toISOString(), payload };
    if (agentId !== undefined) event.agent_id = agentId;
    validateEvent(event);
    events.emit("event", Object.freeze(event));
  }

  function clearTimeouts() {
    clearTimeout(timeoutTimer);
    clearTimeout(forceKillTimer);
    timeoutTimer = undefined;
    forceKillTimer = undefined;
  }

  function processStdout(chunk) {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;

      try {
        const envelope = JSON.parse(line);
        validateEnvelope(envelope);
        events.emit("message", envelope);
      } catch (error) {
        events.emit("protocol_error", error);
      }
    }
  }

  return Object.freeze({
    child,
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    removeListener(event, listener) {
      events.removeListener(event, listener);
      return this;
    },
    async send(envelope) {
      validateEnvelope(envelope);
      if (!isCommand(envelope.message)) {
        throw new ConfigurationError("Node-to-Agent messages must contain a Command.");
      }
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw new LifecycleError("Agent stdin is not writable.");
      }
      await writeLine(child.stdin, `${JSON.stringify(envelope)}\n`);
    },
    close() {
      clearTimeouts();
      child.stdin.end();
    }
  });
}

function isCommand(message) {
  return typeof message?.request_id === "string" && !("event_id" in message);
}

function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    stream.write(line, (error) => error ? reject(error) : resolve());
  });
}
