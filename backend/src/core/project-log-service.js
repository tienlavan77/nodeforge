import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { appendFileSync, createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import process from "node:process";
import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const schema = require("../../../schemas/log/project-log.schema.json");
const validator = createValidator();
const taskSequences = new Map();
let configuredFileService;

export function configureProjectLogFileService(fileService) {
  if (fileService !== undefined && typeof fileService?.appendFileSync !== "function") throw new ConfigurationError("Project log File Service requires appendFileSync.");
  configuredFileService = fileService;
}

export async function readLogEvents({ logPath = defaultLogPath(), project_id, task_id, ticket_id, conversation_id, correlation_id, event_name, from, to, onWarning } = {}) {
  const warnings = [];
  const events = [];
  for (const file of logFiles(logPath)) {
    let stream;
    try { stream = createReadStream(file, { encoding: "utf8" }); } catch (error) { warnings.push({ file, message: error.message }); continue; }
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (matches(event, { project_id, task_id, ticket_id, conversation_id, correlation_id, event_name }) && inTimeRange(event.timestamp, from, to)) events.push({ event, file, line: lineNumber });
        } catch (error) {
          const warning = { file, line: lineNumber, message: `Invalid JSON: ${error.message}` };
          warnings.push(warning); onWarning?.(warning);
        }
      }
    } catch (error) { warnings.push({ file, line: lineNumber, message: error.message }); }
  }
  events.sort((left, right) => (left.event.sequence ?? Number.MAX_SAFE_INTEGER) - (right.event.sequence ?? Number.MAX_SAFE_INTEGER) || left.event.timestamp.localeCompare(right.event.timestamp) || left.file.localeCompare(right.file) || left.line - right.line);
  return { events: events.map(({ event }) => event), warnings };
}

export function logEvent(entry) {
  const normalized = normalize(entry);
  if (!validator(normalized)) {
    throw new ConfigurationError(`Invalid project log event: ${validator.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  }
  appendLog(normalized);
  return Object.freeze(normalized);
}

function defaultLogPath() { return process.env.NODEFORGE_PROJECT_LOG_PATH ?? join(process.cwd(), ".forge", "runtime", "nf", "project.log"); }
function logFiles(basePath) {
  const directory = dirname(basePath); const base = basePath.split("/").pop();
  try { return readdirSync(directory).filter((name) => name === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`).test(name)).map((name) => join(directory, name)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function matches(event, filters) { return Object.entries(filters).every(([key, value]) => value === undefined || event[key] === value); }
function inTimeRange(timestamp, from, to) { const value = Date.parse(timestamp); if (!Number.isFinite(value)) return false; if (from !== undefined && value < parseTime(from, "from")) return false; if (to !== undefined && value > parseTime(to, "to")) return false; return true; }
function parseTime(value, label) { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new ConfigurationError(`Invalid ${label} timestamp.`); return parsed; }

function appendLog(event) {
  const logPath = process.env.NODEFORGE_PROJECT_LOG_PATH ?? join(process.cwd(), ".forge", "runtime", "nf", "project.log");
  const maxBytes = Number(process.env.NODEFORGE_PROJECT_LOG_MAX_BYTES ?? 256 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ConfigurationError("Project log max bytes must be a positive integer.");
  const line = `${JSON.stringify(event)}\n`;
  const target = nextLogPath(logPath, maxBytes, Buffer.byteLength(line));
  if (configuredFileService) {
    const projectRoot = process.cwd();
    const relativePath = target.startsWith(`${projectRoot}/`) ? target.slice(projectRoot.length + 1) : target;
    configuredFileService.appendFileSync({ path: relativePath, content: line });
  } else {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(target, line, { encoding: "utf8", flag: "a" });
  }
}

function nextLogPath(basePath, maxBytes, incomingBytes) {
  let index = 1;
  while (index <= Number.MAX_SAFE_INTEGER) {
    const candidate = index === 1 ? basePath : `${basePath}.${index}`;
    let size = 0;
    try { size = statSync(candidate).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (size + incomingBytes <= maxBytes || size === 0) return candidate;
    index += 1;
  }
}

function normalize(entry) {
  if (!entry || typeof entry !== "object") throw new ConfigurationError("Project log event must be an object.");
  const result = { ...entry };
  if (result.timestamp instanceof Date) result.timestamp = result.timestamp.toISOString();
  if (!result.project_id) result.project_id = process.env.NODE_CONTROL_PROJECT_ID ?? "PROJECT-NODEFORGE";
  if (!result.event_id) result.event_id = `LOG-${randomUUID()}`;
  if (!result.sequence) { const current = taskSequences.get(result.task_id) ?? 0; result.sequence = current + 1; taskSequences.set(result.task_id, result.sequence); }
  if (!result.correlation_id && result.conversation_id) result.correlation_id = result.conversation_id;
  if (!result.payload) result.payload = { message: result.message, ...(result.ticket_id ? { ticket_id: result.ticket_id } : {}), ...(result.conversation_id ? { conversation_id: result.conversation_id } : {}), ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}), ...(result.error_code ? { error_code: result.error_code } : {}) };
  return result;
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
