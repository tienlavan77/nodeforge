import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTicketFileStore } from "../../src/application/ticket-file-store.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

test("stores Vietnamese owner context in SQLite and canonical English ticket in JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-ticket-file-"));
  const database = await openIndexDatabase(root, { runtimeDir: join(".forge", "runtime", "nf") });
  try {
    const files = createFileService({ projectRoot: root });
    const store = createTicketFileStore({ database, fileService: files, clock: () => new Date("2026-09-15T00:00:00.000Z") });
    const context = "Thêm chức năng đăng nhập bằng Google cho người dùng.";
    const ticket = {
      id: "TICKET-P1-1", project_id: "P1", roadmap_id: "ROADMAP-P1", sprint_id: "SPRINT-P1-1",
      title: "Add Google sign-in", objective: "Allow users to authenticate with Google.", acceptance_criteria: ["Users can sign in with Google."],
      provenance: { source: "project_owner", source_id: "TICKET-P1-1", created_at: "2026-09-15T00:00:00.000Z" }
    };
    const metadata = store.create({ ticket, context });
    assert.equal(metadata.context, context);
    assert.equal(metadata.ticket_file, ".forge/runtime/nf/tickets/TICKET-P1-1.jsonl");
    const raw = files.readFileSync({ path: metadata.ticket_file });
    assert.match(raw, /Add Google sign-in/);
    assert.doesNotMatch(raw, /Thêm chức năng/);
    assert.deepEqual(store.readLatest(ticket.id), ticket);

    const updatedTicket = { ...ticket, title: "Support Google sign-in" };
    const updatedContext = "Cho phép người dùng đăng nhập bằng tài khoản Google.";
    store.update({ ticket: updatedTicket, context: updatedContext });
    assert.equal(store.getMetadata(ticket.id).context, updatedContext);
    assert.equal(store.readLatest(ticket.id).title, "Support Google sign-in");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
