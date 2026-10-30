// Resolves ticket-local read services for manual review without changing Coder execution or source identity.
import { ConfigurationError } from "../../../shared/errors.js";
import { createCodeCacheService } from "../../context/code-cache-service.js";
import { createReviewWorker } from "./review-worker.js";

// Supplies the same existing Code Search and read-only Git tools to workspace-bound review-only requests.
export async function resolveReviewOnlyWorkspace({ resolveTicketWorkspace, taskId, commit, baseCommit, reviewer, gitService, fileService, agentResolver, gateways, codeSearch, checkpoints, projectLogger }) {
  const workspace = resolveTicketWorkspace ? await resolveTicketWorkspace(taskId) : null;
  const useWorkspace = workspace && (workspace.root_only ? (await workspace.gitService.assertAncestor(commit), true) : await workspace.gitService.getHead() === commit);
  const reviewGitService = useWorkspace ? workspace.gitService : gitService;
  const reviewWorker = useWorkspace ? createReviewWorker({ agentResolver, ...gateways, fileService: workspace.worktreeFileService, rulesFileService: fileService,
    gitService: workspace.gitService, codeSearch: workspace.codeSearch ?? codeSearch,
    codeCache: createCodeCacheService({ projectId: `${workspace.base_commit}:${workspace.branch}`, fileService: workspace.worktreeFileService, logger: projectLogger }),
    projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings, checkpoints, projectLogger }) : reviewer;
  const head = await reviewGitService?.getHead?.();
  if (!workspace?.root_only && head && head !== commit) throw Object.assign(new ConfigurationError(`Review-only commit is not the current checkout: ${commit}.`), { code: "REVIEW_COMMIT_NOT_CHECKED_OUT" });
  const reviewBase = baseCommit ?? await reviewGitService?.getCommitParent?.(commit);
  return { workspace, useWorkspace, reviewWorker, reviewBase };
}
