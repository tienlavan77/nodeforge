// Supplies scoped tree discovery alongside the canonical Node-owned engineering services.
import { createOwnerSearchTreeTool } from "./owner-search-tree.js";
import { isAgentPathAllowed } from "./tool-authorization.js";

// Filters directory listings to the Node-issued ticket scope without widening repository authority.
export function engineeringToolImplementations({ fileService, wrap }) {
  const tools = {};
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
