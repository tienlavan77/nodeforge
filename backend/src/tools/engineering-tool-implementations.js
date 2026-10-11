// Reuses governed ticket services for canonical Forge discovery names without opening project-wide access.
import { createOwnerSearchTreeTool } from "./owner-search-tree.js";
import { isAgentPathAllowed } from "./tool-authorization.js";

// Adds schema-equivalent discovery aliases and filters directory listings to the Node-issued ticket scope.
export function engineeringToolImplementations({ registry, fileService, wrap }) {
  const tools = {};
  for (const [name, alias] of Object.entries({ list_files: "rg_files", search_text: "rg_search", read_lines: "sed_lines" })) {
    if (registry[alias]) tools[name] = Object.freeze({
      // Reuses the governed legacy service while preserving the canonical operation identity.
      execute: (input, context = {}) => registry[alias].execute(input, {
        ...context,
        capabilities: [...new Set([...(context.capabilities ?? []), alias])]
      })
    });
  }
  if (fileService?.listFiles && fileService?.listDirectories) {
    tools.search_tree = wrap({ execute: async (input, context) => {
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
