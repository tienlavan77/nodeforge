export function createBuilderContext({ roadmaps, indexDb, contextEngine } = {}) {
  return async function buildBuilderContext({ message }) {
    const ticketId = message.payload.text.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9]+-T\d+\b/i)?.[0];
    if (!ticketId) return "";
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id.toLowerCase() === ticketId.toLowerCase());
    if (!ticket) return "";
    const targetPath = canonicalizeAgentPath(ticket.commit?.target_path ?? ticket.target_path ?? ticket.commit_target_path);
    const sections = [`Ticket ${ticket.id}: ${ticket.title ?? ""}`, ticket.objective ? `Objective: ${ticket.objective}` : ""];
    if (targetPath) {
      try {
        if (!indexDb.all("SELECT path FROM files WHERE path = ?", [targetPath]).length) throw new Error(`Indexed file not found: ${targetPath}`);
        const pack = await contextEngine.build({ task_id: ticket.id, line_ranges: [{ path: targetPath, start_line: 1, end_line: 2147483647 }], include_dependencies: true, agent_role: "builder" });
        for (const file of pack.files ?? []) if (file.content) sections.push(`File ${file.path}:\n${file.content}`);
      } catch {
        // The agent tool loop reports stale or unavailable indexed context.
      }
    }
    return sections.filter(Boolean).join("\n\n");
  };
}

function canonicalizeAgentPath(path) {
  if (typeof path !== "string") return path;
  return path.replace(/^src\/backend\/project\/tasks\//, "backend/src/modules/projects/")
    .replace(/^src\/backend\//, "backend/src/")
    .replace(/^src\/web\//, "web/");
}
