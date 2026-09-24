// Validates and normalizes Codex tool arguments against their JSON schemas with defaults.
import Ajv2020 from "ajv/dist/2020.js";
import { ConfigurationError } from "../../shared/errors.js";

const DEFAULTS = Object.freeze({
  select_code_graph_candidates: Object.freeze({ limit: 8 }),
  search_code: Object.freeze({ projection: "minimal" })
});

// Creates an adapter that compiles schemas and normalizes tool inputs with defaults.
export function createCodexToolInputAdapter(definitions = []) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  const validators = new Map();
  for (const definition of definitions) {
    if (!definition?.name || !definition?.inputSchema) continue;
    validators.set(definition.name, ajv.compile(definition.inputSchema));
  }

  return Object.freeze({ normalize });

// Validates tool arguments against the compiled JSON schema and applies per-tool defaults.
  function normalize(name, input) {
    if (!validators.has(name)) throw inputError("TOOL_NOT_ADVERTISED", `Codex tool is not advertised: ${name}.`);
    if (!isPlainObject(input)) throw inputError("TOOL_INPUT_INVALID", "Tool arguments must be a JSON object.", { field: "$" });
    const normalized = { ...(DEFAULTS[name] ?? {}), ...input };
    const validate = validators.get(name);
    if (!validate(normalized)) {
      const details = (validate.errors ?? []).map((item) => ({ instance_path: item.instancePath, keyword: item.keyword, params: item.params, message: item.message }));
      throw inputError("TOOL_INPUT_INVALID", `Invalid arguments for Codex tool ${name}.`, { details });
    }
    return normalized;
  }
}

// Checks whether a value is a plain object suitable for tool arguments.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Creates a coded ConfigurationError for tool input validation failures.
function inputError(code, message, details = {}) {
  const error = new ConfigurationError(message);
  error.code = code;
  error.details = details;
  return error;
}
