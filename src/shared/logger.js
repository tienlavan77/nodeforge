import { createRequire } from "node:module";

import { ConfigurationError } from "./errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../schemas/core/common.schema.json");

export const SEVERITIES = Object.freeze([...commonSchema.$defs.severity.enum]);

export function assertSeverity(severity) {
  if (!SEVERITIES.includes(severity)) {
    throw new ConfigurationError(`Unsupported log severity: ${severity}.`);
  }
  return severity;
}

export function createLogger({ sink = console, clock = () => new Date() } = {}) {
  function log(severity, message, fields = {}) {
    assertSeverity(severity);
    sink.log({ timestamp: clock().toISOString(), severity, message, ...fields });
  }

  return Object.freeze({
    log,
    info: (message, fields) => log("info", message, fields),
    warning: (message, fields) => log("warning", message, fields),
    error: (message, fields) => log("error", message, fields),
    critical: (message, fields) => log("critical", message, fields)
  });
}
