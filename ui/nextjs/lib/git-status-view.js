// Maps project Git status to safe labels without exposing remote addresses.

// Formats clean, dirty, upstream, detached, and unavailable states for the workspace.
export function formatGitStatus(input) {
  if (!input || typeof input !== "object") return { state: "unavailable", label: "Git unavailable" };
  const state = ["clean", "dirty", "ahead-behind", "no-upstream", "detached"].includes(input.state) ? input.state : "unavailable";
  const changed = Number.isInteger(input.changed_files) && input.changed_files >= 0 ? input.changed_files : 0;
  const ahead = Number.isInteger(input.ahead) && input.ahead >= 0 ? input.ahead : 0;
  const behind = Number.isInteger(input.behind) && input.behind >= 0 ? input.behind : 0;
  const branch = typeof input.branch === "string" && /^[A-Za-z0-9._/-]{1,80}$/.test(input.branch) ? input.branch : null;
  const labels = { clean: "Clean", dirty: `${changed} changed`, "ahead-behind": `Ahead ${ahead} · behind ${behind}`, "no-upstream": "No upstream", detached: "Detached HEAD", unavailable: "Git unavailable" };
  return { state, label: labels[state], branch, changed };
}
