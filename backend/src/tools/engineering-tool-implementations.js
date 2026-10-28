// Supplies scoped tree discovery alongside the canonical Node-owned engineering services.
import { createOwnerSearchTreeTool } from "./owner-search-tree.js";
import { createLookupSchemaTool } from "./lookup-schema-tool.js";
import { isAgentPathAllowed } from "./tool-authorization.js";
import { isDependencyPath } from "../infrastructure/filesystem/dependency-read.js";
import { createRoleFileService } from "../infrastructure/filesystem/file-service-role-policy.js";
import { executionReadScope } from "./execution-file-access.js";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";

// Filters directory listings to the Node-issued ticket scope without widening repository authority.
export function engineeringToolImplementations({ fileService, projectRoot, wrap }) {
  const tools = { lookup_schema: wrap(createLookupSchemaTool(), "lookup_schema") };
  if (fileService?.listFiles && fileService?.listDirectories) {
    tools.search_tree = wrap({ execute: async (input, context) => {
      if (projectRoot && isDependencyPath(input?.path)) {
        if (!isAgentPathAllowed(input.path, context)) throw new Error("Dependency tree is outside the approved project scope.");
        return createOwnerSearchTreeTool({ fileService: createRoleFileService({ fileService, projectRoot, role: context.agent_identity?.role }) }).execute(input, context);
      }
      const readScope = executionReadScope(context);
      const scope = [...readScope.paths, ...readScope.prefixes, ...(context.file_access_version === undefined && context.agent_identity?.role === "coder" ? ["docs"] : [])];
      const visible = (path) => {
        try { assertRoleFileAccess(context.agent_identity?.role, "read", path); }
        catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
        return isAgentPathAllowed(path, context, { operation: "read" });
      };
      const tree = createOwnerSearchTreeTool({ fileService: {
        listFiles: async () => (await fileService.listFiles()).filter(visible),
        listDirectories: async () => (await fileService.listDirectories()).filter((path) => visible(path) || scope.some((entry) => entry.startsWith(`${path}/`)))
      } });
      return tree.execute(input);
    } }, "search_tree");
  }
  return tools;
}
