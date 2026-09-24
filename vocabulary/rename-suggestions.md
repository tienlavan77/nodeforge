# Rename Suggestions - pending human review

Proposed from smoke batch A-vs-B diff (8 pending tickets). PROPOSALS ONLY — never auto-execute. A human reviews each row before any code change.

| # | File / symbol | Current | Proposed | Reason | Risk |
|---|---|---|---|---|---|
| 1 | `backend/src/application/owner-chat-service.js` :: `roleForAgent()` return values | `"architecture_manager"`, `"sprint_lead"` (snake) | Keep as-is (no rename) | Agent IDs are kebab (`architecture-manager`, `sprint-leader`) while role strings are snake by message-contract convention (`sprint-leader-adapter.js:31` sends `role: "sprint_lead"`). Renaming roles to kebab would break `sprint.plan.completed` consumers. Documented instead via glossary rows. | High if renamed — breaks cross-agent message contract. RECOMMEND NO CHANGE. |
| 2 | `backend/src/modules/protocol/conversation-state-store.js` :: `createConversationStateStore` / `list` / `listByAgent` | `conversation` terminology | Keep as-is (no rename) | Ticket T1 says "chat framework" but glossary now maps Chat->`conversation`; code term already matches the standard. The retrieval miss was fixed by business-wording summaries, not by renaming. | Low, but unnecessary churn. RECOMMEND NO CHANGE. |

Last run: tickets=8 diff-files=1 (T1 miss `conversation-state-store.js`) at=2026-09-22. No code renamed; awaiting human review.
