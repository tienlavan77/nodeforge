// Reads authorized source windows from retained review commits even after the live file changes or disappears.
import { countBudgetLines } from "../../tools/agent-code-conventions.js";
import { ConfigurationError } from "../../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "../../tools/tool-authorization.js";

// Provides the same bounded read contract as sed_lines without consulting post-integration filesystem bytes.
export function createCommittedReviewWindow(fileService, toolName = "sed_lines") {
  return { execute: async (input = {}, context = {}) => {
    authorizeTool(toolName, context);
    if (Object.keys(input).some((key) => !["path", "start_line", "end_line"].includes(key)) || typeof input.path !== "string" || !isAgentPathAllowed(input.path, context)
      || !Number.isSafeInteger(input.start_line) || input.start_line < 1 || !Number.isSafeInteger(input.end_line) || input.end_line < input.start_line || input.end_line - input.start_line + 1 > 80) {
      throw Object.assign(new ConfigurationError("Committed review window is outside the approved scope or line budget."), { code: toolName === "read_lines" ? "READ_LINES_INPUT_INVALID" : "SED_LINES_INPUT_INVALID" });
    }
    const file = await fileService.readForIndex({ path: input.path, maxBytes: 64_000 });
    const lines = file.content.split("\n");
    return { stdout: lines.slice(input.start_line - 1, input.end_line).join("\n") + (input.start_line <= lines.length ? "\n" : ""), stderr: "", exit_code: 0, signal: null, total_lines: lines.length, code_lines: countBudgetLines(file.content) };
  } };
}
