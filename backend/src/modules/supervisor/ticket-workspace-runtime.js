// Binds governed Coder SDK tools to one ticket workspace.
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";

// Builds ticket-local execution workers while retaining central checkpoints and protocol state.
export function createTicketWorkspaceRuntime({ workspace, gateways, runtimeGovernance, projectLogger, checkpoints }) {
  const projectRoot = workspace.projectRoot;
  const executors = createNodeforgeTaskExecutors({ ...gateways, toolRegistry: workspace.toolRegistry, runtimeGovernance, projectRoot, projectLogger, checkpoints });
  return { executors };
}
