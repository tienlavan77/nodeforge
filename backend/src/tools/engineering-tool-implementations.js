// Supplies scoped tree discovery alongside the canonical Node-owned engineering services.
import { createOwnerSearchTreeTool } from "./owner-search-tree.js";
import { isAgentPathAllowed } from "./tool-authorization.js";
import { isDependencyPath } from "../infrastructure/filesystem/dependency-read.js";
import { createRoleFileService } from "../infrastructure/filesystem/file-service-role-policy.js";

// Filters directory listings to the Node-issued ticket scope without widening repository authority.
export function engineeringToolImplementations({ fileService, projectRoot, wrap }) {
  const tools = {};
  if (fileService?.listFiles && fileService?.listDirectories) {
    tools.search_tree = wrap({ execute: async (input, context) => {
      if (projectRoot && isDependencyPath(input?.path)) {
        if (!isAgentPathAllowed(input.path, context)) throw new Error("Dependency tree is outside the approved project scope.");
        return createOwnerSearchTreeTool({ fileService: createRoleFileService({ fileService, projectRoot, role: context.agent_identity?.role }) }).execute(input, context);
      }
      const scope = [...(context.allowed_file_paths ?? []), ...(context.allowed_prefixes ?? [])];
      const visible = (path) => isAgentPathAllowed(path, context);
      const tree = createOwnerSearchTreeTool({ fileService: {
        listFiles: async () => (await fileService.listFiles()).filter(visible),
        listDirectories: async () => (await fileService.listDirectories()).filter((path) => visible(path) || scope.some((entry) => entry.startsWith(`${path}/`)))
      } });
      return tree.execute(input);
    } }, "search_tree");
  }
  return tools;
}
