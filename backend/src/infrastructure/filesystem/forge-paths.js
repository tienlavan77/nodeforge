// Single source of truth for the runtime-state directory layout under `.forge`.
// Every module that previously hard-coded the literal `.forge/runtime/...` string should derive its
// default root from these helpers so a later structural rename (runtime → state) or scratch split
// touches one place instead of dozens of call sites. Paths are project-relative (slash-separated)
// because FileService resolves them against the project root; they are not absolute filesystem paths.
export const FORGE_DIR = ".forge";
export const FORGE_STATE_DIR = `${FORGE_DIR}/runtime`;
export const FORGE_SCRATCH_DIR = `${FORGE_DIR}/scratch`;

// Joins the runtime-state root with relative segments using forward slashes.
export function statePath(...segments) {
  return [FORGE_STATE_DIR, ...segments.filter(Boolean)].join("/");
}

// Returns the runtime-state root with a trailing slash, used where call sites previously
// hard-coded the literal `.forge/runtime/` for directory-prefix matching (startsWith/slice).
export const STATE_DIR_PREFIX = `${FORGE_STATE_DIR}/`;

// Joins the scratch root with relative segments; scratch holds only disposable data.
export function scratchPath(...segments) {
  return [FORGE_SCRATCH_DIR, ...segments.filter(Boolean)].join("/");
}
