// Generates URL-safe project slug identities and validates backward-compatible project IDs.
// Business purpose: human-readable project names (including accented characters and symbols)
// must resolve to deterministic URL-safe slugs for project routing while avoiding collisions
// with system routes or existing catalog entries and preserving legacy PROJECT-... identities.
// Technical description: normalizes Unicode diacritics, maps special letter variants to ASCII,
// strips non-alphanumeric tokens into hyphenated lowercase slugs, guards against reserved route
// names, and resolves catalog collisions with numeric suffixes.
import { resolve } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LEGACY_PROJECT_ID_PATTERN = /^PROJECT-[A-Za-z0-9_-]+$/;
export const PROJECT_ID_COMPATIBILITY_PATTERN = /^(?:PROJECT-[A-Za-z0-9_-]+|[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const RESERVED_SYSTEM_ROUTES = Object.freeze([
  "system",
  "coding",
  "code",
  "agents",
  "forge",
  "control-api",
  "lifecycle",
  "projects",
  "api",
  "_next"
]);

const RESERVED_ROUTE_SET = new Set(RESERVED_SYSTEM_ROUTES);
const RESERVED_NORMALIZED_SET = new Set(
  RESERVED_SYSTEM_ROUTES.map((route) => normalizeNameToSlug(route)).filter(Boolean)
);

// Checks whether a candidate string is a reserved system route identifier or its normalized slug equivalent.
// Business purpose: prevents user-created projects from shadowing top-level application or API routes.
// Technical description: compares both the trimmed lowercase raw string and its normalized slug against the reserved route set.
export function isReservedProjectRoute(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toLowerCase();
  if (RESERVED_ROUTE_SET.has(trimmed)) return true;
  const slug = normalizeNameToSlug(trimmed);
  return Boolean(slug && (RESERVED_ROUTE_SET.has(slug) || RESERVED_NORMALIZED_SET.has(slug)));
}

// Validates whether a project_id matches either the new URL-safe slug format or the legacy PROJECT-... format.
// Business purpose: ensures existing projects with UUID-based PROJECT-... identities continue working seamlessly alongside slug-based projects.
// Technical description: tests the string against the combined compatibility regular expression while rejecting reserved route names unless legacy-prefixed.
export function isValidProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) return false;
  if (LEGACY_PROJECT_ID_PATTERN.test(projectId)) return true;
  if (!PROJECT_SLUG_PATTERN.test(projectId)) return false;
  return !RESERVED_ROUTE_SET.has(projectId);
}

// Normalizes an arbitrary display name into a clean lowercase URL slug without checking collisions.
// Business purpose: converts localized project titles with diacritics into standard lowercase ASCII URL slugs.
// Technical description: applies NFD decomposition, strips combining marks, maps stroked D characters to ASCII d, and collapses non-alphanumeric runs to single hyphens.
export function normalizeNameToSlug(name) {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const CATALOG_RESERVATION_STATE = new WeakMap();

// Retrieves or initializes the in-memory slug reservation map associated with a catalog or existingIds scope.
// Business purpose: coordinates concurrent project registrations sharing a catalog so two distinct roots with the same name never receive the same slug.
// Technical description: stores a WeakMap-backed Map of reserved slug strings to canonical project roots or anonymous reservation markers on the shared catalog object.
function getReservationState(scope) {
  if (!scope || (typeof scope !== "object" && typeof scope !== "function")) return null;
  let state = CATALOG_RESERVATION_STATE.get(scope);
  if (!state) {
    state = new Map();
    CATALOG_RESERVATION_STATE.set(scope, state);
  }
  return state;
}

// Releases a previously reserved project slug from a shared catalog scope when registration fails or retries.
// Business purpose: prevents failed or retried registration attempts from permanently exhausting candidate slugs in a catalog scope.
// Technical description: deletes the slug key from the WeakMap-backed reservation state if owned by the specified root or unrestricted.
export function releaseProjectSlugReservation(scope, slug, root = null) {
  const state = getReservationState(scope);
  if (!state || typeof slug !== "string") return false;
  if (root !== null && root !== undefined) {
    const canonical = typeof root === "string" && root ? resolve(root) : root;
    const owner = state.get(slug);
    if (owner !== undefined && owner !== canonical) return false;
  }
  return state.delete(slug);
}

// Checks whether a project slug is already claimed by another root in the catalog, existingIds collection, or active reservation table.
// Business purpose: detects mid-flight catalog collisions before a registration persists a duplicate project_id to disk.
// Technical description: inspects both the live catalog entries and the shared reservation map while allowing the same canonical root to retain its own claim.
export function isProjectSlugTaken(slug, { catalog = null, existingIds = [], root = null } = {}) {
  if (typeof slug !== "string" || !slug) return false;
  const canonicalRoot = typeof root === "string" && root ? resolve(root) : null;
  const taken = collectExistingIds(catalog ?? existingIds, canonicalRoot);
  if (taken.has(slug)) return true;
  if (catalog && existingIds && catalog !== existingIds) {
    if (collectExistingIds(existingIds, canonicalRoot).has(slug)) return true;
  }
  return false;
}

// Extracts a Set of existing project IDs from diverse catalog input shapes (Catalog instance, array of entries or strings, or Set).
// Business purpose: allows slug generation callers to pass whichever catalog representation they hold at admission or registration time.
// Technical description: inspects catalog.list() or iterable items and active reservations to collect string IDs from string elements, projectId, or project_id fields.
function collectExistingIds(existingIds = [], requestingRoot = null) {
  const result = new Set();
  if (!existingIds) return result;
  const source = typeof existingIds.list === "function" ? existingIds.list() : existingIds;
  if (source && typeof source[Symbol.iterator] === "function") {
    for (const item of source) {
      if (typeof item === "string" && item) result.add(item);
      else if (item && typeof item === "object") {
        const id = item.projectId ?? item.project_id;
        const itemRoot = typeof item.root === "string" && item.root ? resolve(item.root) : null;
        if (typeof id === "string" && id && (!requestingRoot || !itemRoot || itemRoot !== requestingRoot)) {
          result.add(id);
        }
      }
    }
  }
  const reservations = getReservationState(existingIds);
  if (reservations) {
    for (const [reservedSlug, ownerRoot] of reservations.entries()) {
      if (!requestingRoot || !ownerRoot || ownerRoot !== requestingRoot) {
        result.add(reservedSlug);
      }
    }
  }
  return result;
}

// Generates a unique, URL-safe slug project_id from a project name with reserved-route protection and catalog deduplication.
// Business purpose: provides every newly created project with a readable, collision-free slug identifier that never conflicts with system routes or catalog peers.
// Technical description: normalizes name to a base slug, handles reserved system routes via safe suffixing ("-project") or strict rejection, increments numeric suffixes (-2, -3, ...) when already present in the catalog, and records a reservation when a shared catalog is supplied.
export function generateProjectSlug(input, options = {}) {
  let name = input;
  let opts = options;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    name = input.name ?? input.projectName ?? "";
    opts = input;
  }
  const {
    existingIds = [],
    catalog = null,
    reservedRoutes = null,
    onReserved = "suffix",
    fallback = "project",
    root = null,
    reserve = undefined
  } = opts ?? {};

  const rawTrimmed = typeof name === "string" ? name.trim().toLowerCase() : "";
  let baseSlug = normalizeNameToSlug(typeof name === "string" ? name : "");
  if (!baseSlug) {
    baseSlug = normalizeNameToSlug(fallback) || "project";
  }

  const customReserved = reservedRoutes ? new Set(Array.from(reservedRoutes, (r) => String(r).toLowerCase())) : null;
  const isReserved = (candidate, raw) => {
    if (customReserved) {
      if (customReserved.has(candidate) || (raw && customReserved.has(raw))) return true;
    }
    return RESERVED_ROUTE_SET.has(candidate) || (raw ? RESERVED_ROUTE_SET.has(raw) : false) || RESERVED_NORMALIZED_SET.has(candidate);
  };

  if (isReserved(baseSlug, rawTrimmed)) {
    if (onReserved === "reject" || onReserved === "throw" || opts?.rejectReserved === true) {
      throw new ConfigurationError(`Project slug "${baseSlug}" conflicts with a reserved system route.`);
    }
    baseSlug = `${baseSlug}-project`;
  }

  const canonicalRoot = typeof root === "string" && root ? resolve(root) : null;
  const taken = collectExistingIds(catalog ?? existingIds, canonicalRoot);
  if (catalog && existingIds && catalog !== existingIds) {
    for (const id of collectExistingIds(existingIds, canonicalRoot)) taken.add(id);
  }
  let candidate = baseSlug;
  let counter = 2;
  while (taken.has(candidate) || isReserved(candidate, "")) {
    candidate = `${baseSlug}-${counter}`;
    counter += 1;
  }

  const reservationScope = catalog ?? (reserve === true ? existingIds : null);
  if (reservationScope && reserve !== false) {
    const state = getReservationState(reservationScope);
    if (state) {
      state.set(candidate, canonicalRoot ?? Symbol(candidate));
    }
  }
  return candidate;
}
