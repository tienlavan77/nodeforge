// Keeps source discovery distinct from successful symbolic reads. Private execution-bound
// receipts are checked against current bytes and freshly extracted symbol bounds at delivery.
const receipts = new WeakMap();

/** Records delivered metadata, copying authority and symbol bounds to prevent later mutation. */
export function recordSourceMetadata(context, metadata, onSymbolRead = null) {
  let files = receipts.get(context.agent_identity ?? context);
  if (!files) { files = new Map(); receipts.set(context.agent_identity ?? context, files); }
  files.set(`${context.execution_id ?? context.task_id ?? ""}:${metadata.path}`, {
    sha256: metadata.sha256, symbols: structuredClone(metadata.symbol_map),
    authority: authority(context), source_revision: metadata.source_revision ?? null, onSymbolRead
  });
}

/** Requires unchanged execution authority and source identity before selecting a bounded symbol. */
export function sourceMetadataSymbol(context, path, name, sha256) {
  const receipt = receipts.get(context.agent_identity ?? context)?.get(`${context.execution_id ?? context.task_id ?? ""}:${path}`);
  if (!receipt || receipt.sha256 !== sha256 || receipt.authority !== authority(context)) return null;
  if (receipt.source_revision && receipt.source_revision !== (context.review_commit_sha ?? context.source_revision)) return null;
  return receipt.symbols?.find((symbol) => symbol.name === name) ?? null;
}

/** Marks read success only after the caller has validated current source and exact symbol bounds. */
export function recordSourceSymbolRead(context, path, name, sha256) {
  if (!sourceMetadataSymbol(context, path, name, sha256)) return false;
  receipts.get(context.agent_identity ?? context)?.get(`${context.execution_id ?? context.task_id ?? ""}:${path}`)?.onSymbolRead?.();
  return true;
}

/** Binds metadata reuse to the execution, conversation, delegation, revision and issued scope. */
function authority(context) {
  return JSON.stringify([context.execution_id ?? context.task_id, context.conversation_id ?? context.task_id,
    context.delegation_id ?? context.execution_id, context.review_commit_sha ?? context.source_revision ?? null,
    context.allowed_file_paths ?? null, context.allowed_prefixes ?? null, context.file_access_policy ?? null]);
}
