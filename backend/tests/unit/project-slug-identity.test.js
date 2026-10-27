// Unit tests for URL-safe project slug identity generation, catalog deduplication, and reserved system route protection.
// Business purpose: verifies that human-readable project names (including Vietnamese diacritics) produce deterministic
// URL-safe slugs, avoid collisions in the project catalog, and either safely suffix or reject reserved system routes.
// Technical description: exercises generateProjectSlug, createProjectId, normalizeNameToSlug, and isReservedProjectRoute
// across diacritic inputs, duplicate catalog entries, and all 10 reserved route identifiers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_SLUG_PATTERN,
  RESERVED_SYSTEM_ROUTES,
  generateProjectSlug,
  normalizeNameToSlug,
  isReservedProjectRoute,
  createProjectId
} from "../../src/modules/projects/project-registry.js";

test("generates URL-safe slug project_id from Vietnamese and complex names", () => {
  const slug = generateProjectSlug("Dự Án Bán Hàng");
  assert.equal(slug, "du-an-ban-hang");
  assert.match(slug, PROJECT_SLUG_PATTERN);

  const complex = createProjectId("  Hệ Thống Quản Lý   Đơn Hàng #2026! ");
  assert.equal(complex, "he-thong-quan-ly-don-hang-2026");
  assert.match(complex, PROJECT_SLUG_PATTERN);
});

test("deduplicates slug against existing catalog entries automatically", () => {
  const catalogEntries = [
    { root: "/workspace/one", projectId: "du-an-ban-hang" },
    { root: "/workspace/two", projectId: "du-an-ban-hang-2" }
  ];
  const mockCatalog = { list: () => catalogEntries };

  const nextSlug = generateProjectSlug("Dự Án Bán Hàng", { catalog: mockCatalog });
  assert.equal(nextSlug, "du-an-ban-hang-3");
  assert.match(nextSlug, PROJECT_SLUG_PATTERN);

  const fromSet = generateProjectSlug("Dự Án Bán Hàng", {
    existingIds: new Set(["du-an-ban-hang"])
  });
  assert.equal(fromSet, "du-an-ban-hang-2");
});

test("handles reserved system routes by adding a safe suffix or rejecting when requested", () => {
  const expectedRoutes = [
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
  ];
  assert.deepEqual([...RESERVED_SYSTEM_ROUTES], expectedRoutes);

  for (const route of expectedRoutes) {
    assert.equal(isReservedProjectRoute(route), true, `Expected ${route} to be recognized as reserved`);

    const suffixed = generateProjectSlug(route);
    assert.notEqual(suffixed, route);
    assert.notEqual(suffixed, normalizeNameToSlug(route));
    assert.match(suffixed, PROJECT_SLUG_PATTERN);
    assert.equal(suffixed.endsWith("-project"), true);

    assert.throws(
      () => generateProjectSlug(route, { onReserved: "reject" }),
      /reserved system route/i
    );
  }
});

test("deduplicates suffixed reserved route when -project already exists in catalog", () => {
  const slug = generateProjectSlug("system", {
    existingIds: ["system-project"]
  });
  assert.equal(slug, "system-project-2");
  assert.match(slug, PROJECT_SLUG_PATTERN);
});
