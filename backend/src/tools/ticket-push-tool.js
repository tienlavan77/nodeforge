// Pushes only the latest durable ticket commit through the project's governed Git service.
import { ConfigurationError } from "../shared/errors.js";

// Checks ticket ledger and execution identity before publishing a requested commit.
export function createTicketPushTool({ gitService, changeLedger, executionContexts }) {
  return { execute: async ({ commit_sha }, context) => {
    const ledger = await changeLedger.snapshot(context.task_id);
    const execution = await executionContexts.load(context.task_id);
    const latestRevision = Math.max(0, ...Object.keys(ledger.commits ?? {}).map(Number));
    const latestCommit = ledger.commits?.[latestRevision];
    if (!latestCommit || latestCommit !== commit_sha || execution?.review_commit_sha !== commit_sha || latestRevision !== ledger.revision) {
      throw Object.assign(new ConfigurationError("Push requires the latest committed ticket revision and its exact recorded SHA."), { code: "PUSH_COMMIT_SCOPE_INVALID" });
    }
    return gitService.pushCommit(commit_sha);
  } };
}
