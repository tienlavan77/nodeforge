// Defines Forge-owned command tools that let Codex inspect project files under Node control.
import { createRequire } from "node:module";
import { createRgFilesTool } from "./rg-files.js";
import { createRgSearchTool } from "./rg-search.js";
import { createSedLinesTool } from "./sed-lines.js";

const require = createRequire(import.meta.url);
const rgFilesInputSchema = require("../../../schemas/agent/tools/rg-files.schema.json");
const rgSearchInputSchema = require("../../../schemas/agent/tools/rg-search.schema.json");
const sedLinesInputSchema = require("../../../schemas/agent/tools/sed-lines.schema.json");

export const rgFilesDefinition = Object.freeze({ name: "rg_files", description: "List non-ignored project files with approved ripgrep flags.", input_schema: rgFilesInputSchema });
export const rgSearchDefinition = Object.freeze({ name: "rg_search", description: "Search project source text with approved ripgrep flags.", input_schema: rgSearchInputSchema });
export const sedLinesDefinition = Object.freeze({ name: "sed_lines", description: "Read a bounded project file window and whole-file checksum.", input_schema: sedLinesInputSchema });

// Registers scoped command tools with the same governance wrapper as other Forge agent tools.
export function createAgentCommandTools({ projectRoot, fileService, codeSearch, projectLogger, wrap }) {
  if (!projectRoot) return {};
  const logger = { emit: projectLogger };
  return {
    rg_files: wrap(createRgFilesTool({ projectRoot, logger }), "rg_files", false),
    rg_search: wrap(createRgSearchTool({ projectRoot, logger }), "rg_search", false),
    sed_lines: wrap(createSedLinesTool({ projectRoot, fileService, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch), logger }), "sed_lines", false)
  };
}
