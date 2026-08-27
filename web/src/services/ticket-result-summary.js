export function summarizeTicketResult(message) {
  const payload = message?.payload ?? {};
  if (message?.message_type === "git.commit" && payload.status !== "failed") {
    const commit = payload.commit ?? payload.commit_hash ?? payload.commit_id;
    return commit ? `Commit created: ${commit}.` : "Commit created successfully.";
  }
  const isFailed = payload.to === "failed" || payload.status === "failed" || message?.message_type?.endsWith(".error");
  if (isFailed) {
    const detail = payload.error ?? payload.message ?? payload.reason ?? "Unknown error";
    const code = payload.error_code ? `${payload.error_code}: ` : "";
    const temporary = /(?:provider|upstream)|\b(?:429|500|502|503|504)\b/i.test(`${code}${detail}`);
    return `Ticket failed: ${code}${detail}${temporary ? " (temporary provider error; please try again)" : ""}`;
  }
  if (payload.to !== "done" && payload.status !== "done") return null;
  const files = payload.files ?? payload.paths ?? payload.changed_files;
  const fileText = Array.isArray(files) && files.length ? ` Files: ${files.join(", ")}.` : "";
  const commit = payload.commit ?? payload.commit_hash ?? payload.commit_id;
  const commitText = commit ? ` Commit: ${commit}.` : "";
  const insertions = payload.insertions ?? payload.additions;
  const deletions = payload.deletions ?? payload.removals;
  const diffText = insertions !== undefined || deletions !== undefined ? ` Changes: +${insertions ?? 0}/-${deletions ?? 0}.` : "";
  return `Ticket completed.${fileText}${commitText}${diffText}`;
}
