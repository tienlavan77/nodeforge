// Verifies ticket locks recover after a dead Control API process without stealing live locks.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { acquireTicketFileLock } from "../../src/modules/supervisor/ticket-file-lock.js";

test("ticket lock recovers a dead owner and rejects a live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-lock-"));
  const fileService = createFileService({ projectRoot: root });
  const path = ".forge/runtime/ticket-changes/test.lock";
  try {
    await fileService.atomicWrite({ path, content: "99999999:stale\n", replace: true });
    const lock = await acquireTicketFileLock(fileService, path);
    await assert.rejects(acquireTicketFileLock(fileService, path, { attempts: 2 }), { code: "FILE_CLAIM_BUSY" });
    await lock.release();
    const next = await acquireTicketFileLock(fileService, path);
    await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
