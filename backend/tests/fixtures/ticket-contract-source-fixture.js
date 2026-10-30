// Creates persisted contract and source evidence for shared Sprint inheritance tests.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket/ticket-root-git.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketContractSource } from "../../src/modules/supervisor/ticket/ticket-contract-source.js";

// Hashes exact source bytes for approval and ledger comparisons.
const hash = (content) => createHash("sha256").update(content).digest("hex");

// Creates an actual Git baseline and canonical Forge write journal for one resumable ticket.
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-contract-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const git = createTicketRootGit({ projectRoot: root });
  const original = "export const route = 'original';\n";
  const updated = "export const route = 'selected project';\n";
  const path = "backend/handler.js";
  const quote = "Existing API shapes remain compatible while selecting the correct project runtime.";
  await files.atomicWrite({ path, content: original, replace: false });
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["add", "."]);
  await git.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Approved baseline"]);
  const base = (await git.run(["rev-parse", "HEAD"])).trim();
  const ref = { path, sha256: hash(original), authority_quote: quote };
  const ticket = { id: "T", sprint_id: "S", project_id: "P", objective: quote, acceptance_criteria: [quote],
    execution_policy: { requires_existing_contract: true, contract_evidence: [ref] } };
  const context = { task_id: "T", project_id: "P", base_sha: base, source_revision: "REV", state: "coding" };
  const ledger = createTicketChangeLedger({ fileService: files, projectId: "P" });
  const workspace = { projectRoot: root, path: root, root_only: true, base_commit: base, fileService: files,
    executionContexts: { load: async () => context }, changeLedger: { snapshot: () => ledger.snapshot("T") } };
  const request = { task_id: "T", project_id: "P", ticket, execution_context: context, payload: { execution_id: "EXEC", sprint_basis: { version: 1 } } };
  const plan = { content: { objective: quote, tickets: ["T"], ticket_specs: [ticket] } };
  const events = [];
  const logs = [];
  let checkpoint = { task_id: "T", last_completed_turn: 33, status: "in_progress" };
  const options = { sprintRegistry: { assertReady: async () => ({ plan }) }, resolveTicketWorkspace: async () => workspace,
    checkpoints: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
    eventBus: { publish: async (event) => events.push(event) }, projectLogger: (event) => logs.push(event) };
  return { root, files, git, original, updated, path, quote, base, ref, ticket, context, ledger, workspace, request, plan, events, logs, options,
    checkpoint: () => checkpoint, verify: createTicketContractSource({ request, workspace }),
    write: () => ledger.write({ taskId: "T", path, before: original, after: updated }) };
}

