// Retains execution-local discovery metadata so source reads must select a symbol
// from a previously delivered file map and scoped graph rather than arbitrary lines.
const receipts = new WeakMap();

// Records only metadata delivered by read_file; callers cannot supply their own receipt.
export function recordSourceMetadata(context, metadata) {
  let files = receipts.get(context.agent_identity ?? context);
  if (!files) { files = new Map(); receipts.set(context.agent_identity ?? context, files); }
  files.set(`${context.execution_id ?? context.task_id ?? ""}:${metadata.path}`, { sha256: metadata.sha256, symbols: metadata.symbol_map });
}

// Requires discovery in this execution and rejects stale or invented symbol selections.
export function sourceMetadataSymbol(context, path, name, sha256) {
  const receipt = receipts.get(context.agent_identity ?? context)?.get(`${context.execution_id ?? context.task_id ?? ""}:${path}`);
  if (!receipt || receipt.sha256 !== sha256) return null;
  return receipt.symbols?.find((symbol) => symbol.name === name) ?? null;
}
