// Business purpose: keep conversation memory rendering safe, scoped, and stable across responsive UI surfaces.

const SCOPE_KEYS = ["workspace_id", "project_id", "agent_id", "conversation_id", "task_id"];

function normalizeScope(scope) {
  // Business purpose: require explicit identifiers before memory is shown for a conversation.
  if (!scope || typeof scope !== "object") {
    return null;
  }

  const normalized = {};
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (typeof value === "string" && value.trim()) {
      normalized[key] = value.trim();
    }
  }

  return normalized.workspace_id && normalized.project_id ? normalized : null;
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources
    .filter((source) => source && typeof source === "object")
    .map((source) => ({
      id: typeof source.id === "string" ? source.id : undefined,
      label: typeof source.label === "string" ? source.label : undefined,
      reference: typeof source.reference === "string" ? source.reference : undefined,
    }))
    .filter((source) => source.id || source.label || source.reference);
}

export function normalizeMemoryProjection(input) {
  // Business purpose: expose only sanitized memory metadata to the UI, never raw transcript or events.
  const source = input && typeof input === "object" ? input : {};
  const scope = normalizeScope(source.scope);
  if (!scope) {
    return null;
  }

  const count = Number.isFinite(source.memory_count) ? Math.max(0, source.memory_count) : 0;
  const revision = typeof source.context_revision === "string"
    ? source.context_revision
    : null;
  const checksums = source.context_checksums && typeof source.context_checksums === "object"
    ? { ...source.context_checksums }
    : {};

  return {
    scope,
    memory_count: count,
    stable_context: typeof source.stable_context === "string" ? source.stable_context : "",
    dynamic_context: typeof source.dynamic_context === "string" ? source.dynamic_context : "",
    context_revision: revision,
    context_checksums: checksums,
    sources: normalizeSources(source.sources),
    stale: source.stale === true,
    last_updated: typeof source.last_updated === "string" ? source.last_updated : null,
    actions: {
      refresh: source.actions?.refresh === true,
      rebuild: source.actions?.rebuild === true,
    },
  };
}
