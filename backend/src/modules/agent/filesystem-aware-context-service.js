import { ConfigurationError } from "../../shared/errors.js";

const SECRET_PATH = /(?:^|[\s"'`(\\/])(?:\.env(?:\.[^/\s)]*)?|[^/\s]+\.(?:key|pem|crt|pfx|keystore))(?:$|[\s"'`)/])/i;

// Enriches the logical Agent context without exposing filesystem access to the Agent.
export function createFilesystemAwareContextService({ baseContextService, contextEngine, budgetManager, maxFacts = Number.MAX_SAFE_INTEGER, debug = () => {} } = {}) {
  if (typeof baseContextService?.buildContext !== "function") throw new ConfigurationError("Filesystem-aware Context requires a base Context Service.");
  if (typeof contextEngine?.build !== "function") throw new ConfigurationError("Filesystem-aware Context requires a Context Engine.");
  if (typeof budgetManager?.selectFacts !== "function") throw new ConfigurationError("Filesystem-aware Context requires a Context Budget Manager.");
  if (!Number.isInteger(maxFacts) || maxFacts < 0) throw new ConfigurationError("Filesystem-aware Context maxFacts must be a non-negative integer.");

  return Object.freeze({ buildContext });

  async function buildContext({ projectId, taskId, query = "", domain } = {}) {
    const logical = await baseContextService.buildContext({ projectId, taskId, query, domain });
    const logicalFacts = filterFacts(logical.projectFacts ?? []);
    if (!query.trim()) return { ...logical, projectFacts: budgetManager.selectFacts({ facts: logicalFacts, maxFacts }), contextPack: null };

    let contextPack = null;
    let indexFacts = [];
    try {
      contextPack = await contextEngine.build({ task_id: taskId, query, domain, symbols: [{ name: query }], include_dependencies: true });
      indexFacts = filterFacts(packFacts(contextPack));
    } catch (error) {
      debug({ message: "ContextEngine lookup failed; using logical facts only.", error: error?.message });
    }
    return { ...logical, projectFacts: budgetManager.selectFacts({ facts: [...logicalFacts, ...indexFacts], maxFacts }), contextPack };
  }
}

function packFacts(pack) {
  if (!pack || typeof pack !== "object") return [];
  const symbols = (pack.symbols ?? []).map((symbol) => `symbol ${symbol.name} in ${symbol.file}${symbol.kind ? ` (${symbol.kind} ${symbol.start_line}-${symbol.end_line})` : ""}`);
  const files = (pack.files ?? []).map((file) => `file ${file.path}`);
  const dependencies = (pack.dependencies ?? []).map((dependency) => `dependency ${dependency.symbol ?? dependency.signature} in ${dependency.file ?? "unknown"}`);
  return [...symbols, ...files, ...dependencies];
}

function filterFacts(facts) {
  return facts.filter((fact) => typeof fact === "string" && !SECRET_PATH.test(fact));
}
