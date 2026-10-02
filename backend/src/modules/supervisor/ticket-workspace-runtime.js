// Binds ticket Coder and Reviewer SDK tools to one isolated worktree.
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";
import { createReviewWorker } from "./review-worker.js";
import { createCodeCacheService } from "../context/code-cache-service.js";

// Builds ticket-local execution workers while retaining central checkpoints and protocol state.
export function createTicketWorkspaceRuntime({ workspace, gateways, agentResolver, runtimeGovernance, projectLogger, checkpoints, protocolStorage }) {
  const projectRoot = workspace.projectRoot;
  const executors = createNodeforgeTaskExecutors({ ...gateways, toolRegistry: workspace.toolRegistry, runtimeGovernance, projectRoot, projectLogger, checkpoints, relevantTreeSelector: workspace.relevantTreeSelector, protocolStorage });
  const reviewCache = createCodeCacheService({ projectId: `${workspace.base_commit}:${workspace.branch}`, fileService: workspace.worktreeFileService, logger: projectLogger });
  const reviewer = createReviewWorker({ agentResolver, ...gateways, fileService: workspace.worktreeFileService, rulesFileService: workspace.fileService, gitService: workspace.gitService, codeCache: reviewCache, projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings, projectLogger });
  return { executors, reviewer };
}
