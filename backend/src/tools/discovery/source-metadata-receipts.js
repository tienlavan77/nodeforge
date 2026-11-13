// Keeps source discovery distinct from successful symbolic reads. Private execution-bound
// receipts are checked against current bytes and freshly extracted symbol bounds at delivery.
import { executionIdentityKey, normalizeExecutionIdentity } from "./execution-identity.js";

const receipts = new WeakMap();
const OMITTED_SYMBOL = Symbol("omitted-symbol");

/** Records delivered metadata, copying authority and symbol bounds to prevent later mutation. */
export function recordSourceMetadata(context, metadata, onSymbolRead = null) {
  let files = receipts.get(context.agent_identity ?? context);
  if (!files) { files = new Map(); receipts.set(context.agent_identity ?? context, files); }
  files.set(`${executionIdentityKey(context)}:${metadata.path}`, {
    sha256: metadata.sha256, symbols: structuredClone(metadata.symbol_map),
    authority: authority(context), source_revision: metadata.source_revision ?? null, onSymbolRead
  });
}

/**
 * Requires unchanged execution authority, current source identity, and current
 * symbol bounds before selecting a bounded symbol for delivery.
 */
export function sourceMetadataSymbol(context, path, name, sha256, currentSymbol) {
  const symbolToValidate = arguments.length < 5 ? OMITTED_SYMBOL : currentSymbol;
  const receipt = receipts.get(context.agent_identity ?? context)?.get(`${executionIdentityKey(context)}:${path}`);
  if (!receipt || receipt.sha256 !== sha256 || receipt.authority !== authority(context)) return null;
  if (receipt.source_revision && receipt.source_revision !== (context.review_commit_sha ?? context.source_revision)) return null;
  const recorded = receipt.symbols?.find((symbol) => symbol.name === name) ?? null;
  if (!recorded) return null;
  if (symbolToValidate !== OMITTED_SYMBOL) {
    if (symbolToValidate == null) return null;
    if (symbolToValidate.name !== recorded.name || symbolToValidate.start_line !== recorded.start_line
      || symbolToValidate.end_line !== recorded.end_line) return null;
  }
  return recorded;
}

/** Marks read success only after the caller has validated current source and exact symbol bounds. */
export function recordSourceSymbolRead(context, path, name, sha256) {
  if (!sourceMetadataSymbol(context, path, name, sha256)) return false;
  receipts.get(context.agent_identity ?? context)?.get(`${executionIdentityKey(context)}:${path}`)?.onSymbolRead?.();
  return true;
}

/** Binds metadata reuse to the execution, conversation, delegation, revision and issued scope. */
function authority(context) {
  const identity = normalizeExecutionIdentity(context);
  return JSON.stringify([identity.execution_id, identity.conversation_id, identity.delegation_id, context.review_commit_sha ?? context.source_revision ?? context.sourceRevision ?? null,
    context.allowed_file_paths ?? context.allowedFilePaths ?? null, context.allowed_prefixes ?? context.allowedPrefixes ?? null, context.file_access_policy ?? context.fileAccessPolicy ?? null]);
}
