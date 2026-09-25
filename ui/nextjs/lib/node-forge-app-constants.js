// Static agent roster, conversation routing, and provider/model catalog for the legacy NodeForge app shell.

export const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan" },
  { id: "builder", label: "Builder", short: "BU", tone: "amber" },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green" }
];
export const PROJECT_ID = "PROJECT-NODEFORGE";
export const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
export const CONVERSATIONS = {
  "architecture-manager": "CONV-ARCHITECTURE",
  "sprint-leader": "CONV-SPRINT-LEADER",
  "builder": "CONV-BUILDER",
  "reviewer": "CONV-REVIEWER"
};
export const CHAT_PAGE_SIZE = 10;
