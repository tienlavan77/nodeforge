// Retrieval eval cases auto-backfilled from historical final reports - generated file, do not edit by hand.
// Regenerate with: node backend/scripts/backfill-eval-cases.mjs (repo root is resolved from the script location).
export const RETRIEVAL_EVAL_CASES_AUTO = [
  {
    "id": "TICKET-DOC-VALIDATE-SCHEMAS",
    "note": "Backfilled from final report TICKET-DOC-VALIDATE-SCHEMAS.md (status=completed)",
    "title": "Document validate-schemas with a summary comment",
    "objective": "Read backend/scripts/validate-schemas.mjs and prepend an English summary comment at the very top of the file describing its purpose, main responsibilities, and key exports. Do not change any existing logic.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "backend/scripts/validate-schemas.mjs gains a block comment at the very top summarizing what the file does",
      "No existing lines of backend/scripts/validate-schemas.mjs are modified, reordered, or removed"
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/scripts/validate-schemas.mjs"
    ],
    "files_changed": [
      "backend/scripts/validate-schemas.mjs"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789356670440",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789356670440.md (status=completed)",
    "title": "Decouple Architecture Manager Chat from the Legacy Agent ID",
    "objective": "Update the chat framework so it no longer relies on the hardcoded legacy agent ID `architecture_manage` and instead uses each agent's current ID, ensuring that users see the correct conversations for the selected agent.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The chat framework does not contain a hardcoded dependency on the legacy `architecture_manage` agent ID.",
      "Conversation retrieval and display use the currently selected agent's new ID.",
      "Existing conversations are correctly isolated by agent and are not shown under the wrong agent.",
      "Switching between agents refreshes the chat view with only the selected agent's conversations.",
      "Automated tests cover conversation retrieval and display for multiple agent IDs."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/modules/protocol/conversation-state-store.js",
      "backend/tests/unit/conversation-state-store-agent-isolation.test.js"
    ],
    "files_changed": [
      "backend/src/modules/protocol/conversation-state-store.js",
      "backend/tests/unit/conversation-state-store-agent-isolation.test.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789433096732",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789433096732.md (status=completed)",
    "title": "Add Agent Process Status to the Watcher Header",
    "objective": "Update the watcher UI to display an agent process status line in the right side of the header, showing PID, RAM usage, CPU percentage, and uptime.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The watcher header includes an agent process status area aligned to the right.",
      "The status area displays values in the format: PID | RAM | %CPU | Uptime.",
      "PID, RAM, CPU usage, and uptime are populated from the current agent process data.",
      "The status area remains readable and correctly aligned across supported screen sizes."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789465305283",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789465305283.md (status=completed)",
    "title": "Add Vietnamese Ticket Content Editing and English Regeneration",
    "objective": "When a user views a ticket, display an editable content change panel that preserves the existing Vietnamese context. Allow the user to modify the content and submit it to the backend, which invokes the Sprint Leader agent to regenerate the ticket in English.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Viewing a ticket displays a content change panel containing the ticket's existing Vietnamese context.",
      "Users can edit the ticket content within the change panel before submission.",
      "Submitting the edited content sends the original Vietnamese context and the user's changes to the backend.",
      "The backend invokes the agent with the Sprint Leader role to regenerate the ticket content in English.",
      "The regenerated English ticket content is returned and displayed to the user.",
      "Submission failures provide a clear error state and do not overwrite the existing ticket content."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789471789710",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789471789710.md (status=completed)",
    "title": "Reorganize the ticket view modal frontend layout",
    "objective": "Update the ticket view modal so that the ticket language summary remains unchanged, the ticket's English content appears below it, the Vietnamese context from the database is displayed in the Vietnamese context textarea, and the Regenerate English button is positioned below that textarea and aligned to the right.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The ticket-language-summary section remains unchanged and stays at the top of the modal.",
      "The ticket's English content is displayed below the ticket-language-summary section.",
      "The Vietnamese context textarea displays the Vietnamese context retrieved from the database.",
      "The English content is no longer incorrectly displayed in the Vietnamese context textarea.",
      "The Regenerate English button is placed below the Vietnamese context textarea and aligned to the right.",
      "The revised layout remains usable and visually consistent across supported screen sizes."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx",
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx",
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789476103218",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789476103218.md (status=completed)",
    "title": "Implement Regenerate English backend flow via sprint leader",
    "objective": "When a user clicks 'Regenerate English' in the UI, the frontend calls the ticket API. The backend receives the request, uses the stored Vietnamese context to instruct the sprint leader to recreate the English version of the ticket, persists the updated ticket to the database, and returns the refreshed data to the UI.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Clicking 'Regenerate English' in the UI triggers the corresponding ticket regeneration API endpoint",
      "The backend passes the original Vietnamese context to the sprint leader for English ticket regeneration",
      "The regenerated English ticket is persisted to the database, replacing or updating the previous English version",
      "The API response returns the updated ticket so the UI reflects the changes without a manual refresh",
      "Error handling is in place so the user receives clear feedback if regeneration fails"
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789476530143",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789476530143.md (status=completed)",
    "title": "Migrate all frontend ticket API calls to /forge/v1/tickets",
    "objective": "Update the frontend UI so that all ticket-related API requests use the /forge/v1/tickets endpoint.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "All frontend ticket-related API calls use /forge/v1/tickets as their base endpoint.",
      "No frontend code continues to call legacy ticket API endpoints.",
      "Existing ticket UI workflows continue to function correctly after the endpoint migration."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789477493372",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789477493372.md (status=completed)",
    "title": "Implement Regenerate English Ticket Feature (Frontend + Backend)",
    "objective": "Enable the 'Regenerate English' button on the frontend to call the PUT /forge/v1/tickets/:ticket_id?project endpoint with project_id, sprint_id, and user-provided Vietnamese context as payload. On the backend, use the Vietnamese context to invoke the sprint leader agent to regenerate the ticket in English, persist the updated ticket to the database, and reflect the changes on the UI.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Frontend: Clicking the 'Regenerate English' button sends a PUT request to /forge/v1/tickets/:ticket_id?project with payload containing project_id, sprint_id, and context (Vietnamese user input).",
      "Backend: The endpoint extracts the Vietnamese context from the request payload and passes it to the sprint leader agent to regenerate the ticket in English.",
      "Backend: The regenerated English ticket is persisted to the database, replacing or updating the existing ticket record.",
      "Backend: A success response is returned to the frontend with the updated ticket content.",
      "Frontend: The UI reflects the newly regenerated English ticket after a successful API response.",
      "Error handling: If the sprint leader fails to produce a valid ticket, the UI displays an appropriate error message and the database record is not corrupted."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/lib/node-client.js",
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789478889604",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789478889604.md (status=completed)",
    "title": "Gate Regenerate English button on actual Vietnamese content changes",
    "objective": "In the frontend UI, implement validation logic that detects whether the user has made real edits to the Vietnamese context. The \"Regenerate English\" button must remain disabled unless the current Vietnamese content differs from its original value.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Track the original Vietnamese content on mount/load and compare against the current value in real time.",
      "The \"Regenerate English\" button is disabled by default when the Vietnamese content is unchanged from its original.",
      "The \"Regenerate English\" button becomes enabled only when the user has introduced an actual edit (non-trivial diff) to the Vietnamese content.",
      "If the user reverts changes back to the original content, the button returns to a disabled state.",
      "Trim or whitespace-only changes should be considered when determining if an edit is real (define and apply a consistent normalization rule).",
      "No extra network requests should be triggered solely by the enable/disable toggle of the button."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789479214703",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789479214703.md (status=completed)",
    "title": "Backend: Implement Regenerate English Workflow with Vietnamese Context Propagation",
    "objective": "When the user clicks the 'Regenerate English' button, the backend must read the current Vietnamese context, dispatch a request to the sprint leader to regenerate the ticket in English, persist the updated Vietnamese context to the database, rewrite the corresponding ticket file under .forge/runtime/nf/tickets, and propagate the changes to the UI.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Clicking 'Regenerate English' triggers the sprint leader to produce an English-localized version of the ticket.",
      "The updated Vietnamese context is persisted to the database after regeneration.",
      "The ticket file in .forge/runtime/nf/tickets is overwritten with the regenerated content.",
      "The UI reflects the newly regenerated ticket without requiring a manual page refresh.",
      "All translatable fields (title, objective, acceptance_criteria) in the regenerated ticket are written in English.",,
      candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The original ticket identity (ID) is preserved across the regeneration cycle."
    ],
    "style": [
      "frontend",
      "backend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx",
      "backend/src/application/prose-ticket-service.js"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx",
      "backend/src/application/prose-ticket-service.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789481898268",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789481898268.md (status=completed)",
    "title": "Add 'Team' selector to Add Agent and Edit Agent modals on Agents page",
    "objective": "Update the frontend Agents page UI by adding a 'Team' selector (dropdown) to both the Add Agent and Edit Agent modals. The selector should appear directly below the existing 'Role' field and offer three options: Backend, Frontend, Security.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "A selector/dropdown labeled 'Team' is visible in the Add Agent modal on the Agents page.",
      "A selector/dropdown labeled 'Team' is visible in the Edit Agent modal on the Agents page.",
      "The 'Team' selector is positioned immediately below the 'Role' field in both modals.",
      "The 'Team' selector offers exactly three options: Backend, Frontend, Security.",
      "The selected team value is persisted and displayed correctly when reopening the Edit Agent modal for an existing agent.",
      "The UI renders without layout breakage or overflow issues across supported viewport sizes."
    ],
    "style": [
      "frontend",
      "backend"
    ],
    "ground_truth": [
      "ui/nextjs/components/AddAgentModal.jsx",
      "backend/src/application/agent-settings-service.js"
    ],
    "files_changed": [
      "ui/nextjs/components/AddAgentModal.jsx",
      "backend/src/application/agent-settings-service.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789481976392",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789481976392.md (status=completed)",
    "title": "Update database schema to add team field",
    "objective": "Modify the backend schema to include a new 'team' field in the database, enabling team-based data association and queries.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The database schema is updated to include a 'team' field with an appropriate data type and constraints.",
      "A corresponding migration script is created and can be applied successfully.",
      "The 'team' field is properly integrated into the existing ORM/model layer.",
      "Unit tests pass and confirm the new field behaves as expected (create, read, update).",
      "No regressions are introduced in existing schema consumers or queries."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/modules/projects/task-store.js",
      "backend/src/modules/projects/task-schema-migration.js",
      "schemas/project/task.schema.json",
      "backend/tests/unit/task-store-team.test.js"
    ],
    "files_changed": [
      "backend/src/modules/projects/task-store.js",
      "backend/src/modules/projects/task-schema-migration.js",
      "schemas/project/task.schema.json",
      "backend/tests/unit/task-store-team.test.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789485929114",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789485929114.md (status=completed)",
    "title": "Allow editable context and ticket regeneration in frontend modal view",
    "objective": "In the ticket modal view on the frontend, enable users to edit the original raw context (e.g. a Vietnamese or mixed-language owner request) and regenerate the English ticket fields (title, objective, acceptance_criteria) from the updated context, replacing any previous auto-generated values.",,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The ticket modal displays an editable text area containing the original raw context (in any language, e.g. Vietnamese).",
      "Users can modify the context content directly within the modal.",
      "A 'Regenerate' action is available that re-runs the ticket generation using the edited context and updates the English title, objective, and acceptance_criteria fields.",,
      candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Previously generated English ticket fields are replaced (not appended) with the newly regenerated content.",
      "The Vietnamese (or other non-English) context is treated as source input only and is never included verbatim in the generated ticket output.",
      "The modal preserves unsaved edits to context until the user explicitly triggers regeneration or closes without saving."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789486236267",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789486236267.md (status=completed)",
    "title": "Restyle CSS for 'Generate English' button to align with current UI design",
    "objective": "Refactor the CSS styling of the 'Generate English' button on the frontend so that it is visually consistent with the existing UI design system.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The 'Generate English' button uses CSS styles that match the current design language (colors, typography, spacing, border-radius).",
      "The button remains fully functional after the CSS changes.",
      "No visual regressions are introduced to surrounding UI elements.",
      "The updated styles are consistent across all frontend pages where the button appears."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789486494111",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789486494111.md (status=completed)",
    "title": "Re-add Vietnamese Context textarea and Generate English button to Ticket View Modal",
    "objective": "Restore the Vietnamese context textarea and the Generate English button to the ticket view modal in the frontend UI. These components were previously removed and need to be re-integrated so users can input Vietnamese context and generate English translations directly within the modal.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The Vietnamese context textarea is visible and functional within the ticket view modal",
      "The Generate English button is present next to or below the Vietnamese context textarea in the modal",
      "Clicking the Generate English button triggers the translation flow using the content from the Vietnamese context textarea",
      "The modal layout remains responsive and does not break with the re-added components",
      "The re-added components match the existing UI design system and styling conventions"
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789488462481",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789488462481.md (status=completed)",
    "title": "Add 'team' field to agent profile in backend",
    "objective": "Modify the backend to support a 'team' field on the agent profile entity. The field must be accepted and persisted during both the create (add new) and update (save) operations triggered from the agents page.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The agent profile data model/schema includes a 'team' field.",
      "The create-agent API endpoint accepts and stores the 'team' field when a new agent is added.",
      "The update-agent API endpoint accepts and updates the 'team' field when an existing agent is saved.",
      "The 'team' field is returned in agent profile read/fetch responses.",
      "Appropriate validation is applied to the 'team' field (e.g. type, length constraints as defined by the project spec)."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/application/agent-settings-service.js",
      "backend/tests/integration/agent-settings-service.test.js"
    ],
    "files_changed": [
      "backend/src/application/agent-settings-service.js",
      "backend/tests/integration/agent-settings-service.test.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789489861283",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789489861283.md (status=completed)",
    "title": "Add 'team' field to agent schema profile for database persistence",
    "objective": "Modify the backend agent schema profile to include a new 'team' field, enabling it to be written to and stored in the database.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The agent schema profile definition includes a new 'team' field with an appropriate data type.",
      "The 'team' field is persisted to the database when an agent profile is created or updated.",
      "The 'team' field is retrievable via existing agent profile read operations.",
      "Database migration is generated and applied to add the 'team' column to the relevant table.",
      "Existing agent profiles without a 'team' value continue to function correctly (field is nullable or has a default)."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/modules/agent/agent-profile-store.js",
      "backend/src/infrastructure/sqlite/index-database.js",
      "backend/src/application/ticket-crud-service.js",
      "backend/tests/integration/agent-profile-store.test.js"
    ],
    "files_changed": [
      "backend/src/modules/agent/agent-profile-store.js",
      "backend/src/infrastructure/sqlite/index-database.js",
      "backend/src/application/ticket-crud-service.js",
      "backend/tests/integration/agent-profile-store.test.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789491448083",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789491448083.md (status=completed)",
    "title": "Persist architecture manager selector value to localStorage keyed by project_id",
    "objective": "Edit the frontend UI so that the architecture manager selector's chosen agent value is saved to localStorage under the key 'arch' using the data structure { \"<project_id>\": { \"agent\": \"<id>\" }, ... }. Every selector change must be persisted, and on page reload the stored agent value must be read based on the current project_id and applied as the selector's default.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The architecture manager selector persists its selected agent value to localStorage under the key 'arch' whenever the user changes the selection.",
      "The localStorage data structure follows the format { \"<project_id>\": { \"agent\": \"<id>\" }, ... } so that multiple projects can store their respective agent selections independently.",
      "On page reload, the application reads the value from localStorage key 'arch' using the current project_id and sets the corresponding agent as the default selection in the architecture manager selector.",
      "If no stored value exists for the current project_id, the selector falls back to its original default state without errors.",
      "Selector changes for one project_id do not overwrite or corrupt entries for other project_ids in localStorage."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/src/architecture-manager-selection.js",
      "ui/nextjs/app/page.jsx",
      "ui/src/architecture-manager-selection.test.js"
    ],
    "files_changed": [
      "ui/src/architecture-manager-selection.js",
      "ui/nextjs/app/page.jsx",
      "ui/src/architecture-manager-selection.test.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789545675977",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789545675977.md (status=completed)",
    "title": "Simplify New Conversation button and add smooth expand animation to accordion UI",
    "objective": "Improve the frontend accordion conversation UI by simplifying the 'New Conversation' button design and introducing smooth transition animations when accordion panels expand or collapse.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The 'New Conversation' button is visually simplified (cleaner icon/label, reduced visual noise) while remaining clearly identifiable and accessible.",
      "Accordion panels animate smoothly on expand and collapse with a fluid transition (e.g. height or opacity easing) rather than an abrupt jump.",
      "The existing accordion conversation layout and functionality remain intact after the changes.",
      "No regression in responsiveness or interaction behavior on the updated components."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789549690715",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789549690715.md (status=completed)",
    "title": "Migrate conversation schema id field to UUID format",
    "objective": "Modify the backend conversation schema so that the id field is generated using UUID format instead of the current identifier strategy. Ensure existing data is handled appropriately during the migration.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The conversation schema id field is defined to accept and generate values in UUID format (e.g. UUID v4).",
      "New conversation records created through the backend API automatically receive a UUID-based id.",
      "A migration strategy or script is provided for any existing conversation records to ensure backward compatibility or data integrity.",
      "All existing tests and integration points that reference conversation ids continue to pass after the change.",
      "Documentation or type definitions reflecting the updated schema are revised accordingly."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/application/conversation-crud-service.js",
      "backend/src/infrastructure/sqlite/index-database.js"
    ],
    "files_changed": [
      "backend/src/application/conversation-crud-service.js",
      "backend/src/infrastructure/sqlite/index-database.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789551381340",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789551381340.md (status=completed)",
    "title": "Reduce font size of priority label in frontend",
    "objective": "Decrease the font size of the priority text/label displayed in the frontend UI to improve visual hierarchy and readability.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The priority label font size is visibly smaller than its current size in the frontend.",
      "The priority text remains legible and does not break layout at the reduced font size.",
      "The change is applied consistently across all views where the priority label appears."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789572090025",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789572090025.md (status=completed)",
    "title": "Add New Conversation Creation Modal",
    "objective": "Update the frontend so clicking the New Conversation button opens a modal containing a conversation title input and a Create button. The Create button must submit a POST request to the /forge/v1/conversations API route.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Clicking New Conversation opens a modal.",
      "The modal contains an input field for entering the conversation title.",
      "The modal contains a Create button.",
      "Clicking Create sends a POST request to /forge/v1/conversations with the entered conversation title.",
      "The modal handles the API response and provides appropriate feedback for successful creation or failure."
    ],
    "style": [
      "frontend",
      "backend"
    ],
    "ground_truth": [
      "backend/src/transport/http/forge-v1-router.js",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ],
    "files_changed": [
      "backend/src/transport/http/forge-v1-router.js",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789597790168",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789597790168.md (status=completed)",
    "title": "Add a Create Conversation Modal to the Frontend UI",
    "objective": "Use the existing UI modal component to provide a frontend dialog where users can enter a conversation title and create a new conversation. The modal should follow the visual style and interaction pattern of the existing ticket modal view, with CSS that matches the current interface.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "A modal for creating a conversation is implemented using the existing UI modal component.",
      "The modal includes an input field for the conversation title.",
      "Users can submit the form to create a conversation with the entered title.",
      "The modal provides appropriate handling for empty or invalid titles.",
      "The modal's layout and behavior are consistent with the existing ticket modal view.",
      "CSS styling is added or updated so the modal matches the current frontend interface across supported screen sizes."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/CreateConversationModal.jsx",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/CreateConversationModal.jsx",
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789602291693",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789602291693.md (status=completed)",
    "title": "Move conversation modal to global level and set backdrop to full viewport",
    "objective": "Refactor the frontend UI so that the conversation modal is rendered at a global (top-level) scope rather than being nested inside a page or feature component, and ensure the .conversations-modal-backdrop CSS class uses width: 100vw and height: 100vh to cover the entire viewport.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The conversation modal is mounted at a global level (e.g., app root or a dedicated global overlay layer), not scoped to a single page or nested component.",
      "The CSS rule for .conversations-modal-backdrop sets width to 100vw and height to 100vh.",
      "The modal backdrop visually covers the full viewport regardless of which route or page is active.",
      "Existing modal open/close behavior and event handling continue to function correctly after the refactor.",
      "No duplicate modal instances are rendered when navigating between pages."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/CreateConversationModal.jsx",
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/components/CreateConversationModal.jsx",
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789603906931",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789603906931.md (status=completed)",
    "title": "Remove max-height from conversations-modal-backdrop",
    "objective": "Update the frontend UI so that the conversations-modal-backdrop component no longer applies a max-height constraint.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The max-height CSS rule is removed from conversations-modal-backdrop.",
      "The conversations modal backdrop remains visually and functionally correct across supported viewport sizes.",
      "No unrelated frontend styles or components are changed."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789610673670",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789610673670.md (status=completed)",
    "title": "Enhance conversation accordion with interactive row and drag-and-drop reordering",
    "objective": "Update frontend to display newly created conversations in the conversation accordion immediately after a successful create-conversation request and response, with a consistent row layout, contextual actions, and drag-and-drop sorting styled to match the existing UI.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "After sending create-conversation request and receiving successful response, automatically append/update a single row for the new conversation in the conversation accordion without page reload",
      "Each accordion row layout is: checkbox for selecting conversation on the left | conversation title in the center | three-dot menu button right-aligned",
      "Three-dot button is right-aligned and on click opens a contextual menu with options: Delete, Rename, and Archive",
      "Menu actions are functional: Delete removes conversation with confirmation, Rename allows inline editing, Archive moves conversation to archived state",
      "Enable drag-and-drop reordering of conversations within the accordion and persist the new order",
      "Implement CSS styling for row, checkbox, title, three-dot menu, and drag states to be visually consistent with current interface theme and responsive"
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789618154255",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789618154255.md (status=completed)",
    "title": "Create Conversations Block component for conversation accordion",
    "objective": "Implement a frontend UI Conversations Block component to be displayed inside the conversation accordion. The component must contain three aligned sections: a check input on the left, a title on the left, and an actions menu on the right. The menu must allow users to delete, rename, and archive a conversation. The component should be dynamically added to the conversation accordion upon receiving a successful response from the create new conversation request.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "Conversations Block component is created with layout: check input aligned left | title aligned left | menu aligned right",
      "Menu provides functional actions: Delete conversation, Rename conversation, and Archive/Store conversation",
      "Component is automatically appended/inserted into the conversation accordion when create-new-conversation request returns a successful response",
      "Title truncation, alignment, and menu positioning are verified across desktop and responsive breakpoints",
      "Delete, rename, and archive actions trigger correct API calls/callbacks and update UI state without full page reload"
    ],
    "style": [
      "frontend",
      "backend"
    ],
    "ground_truth": [
      "ui/nextjs/components/ConversationsBlock.jsx",
      "backend/src/modules/protocol/conversation-state-store.js",
      "ui/nextjs/components/ConversationsAccordion.jsx",
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/components/ConversationsBlock.jsx",
      "backend/src/modules/protocol/conversation-state-store.js",
      "ui/nextjs/components/ConversationsAccordion.jsx",
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789618365350",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789618365350.md (status=completed)",
    "title": "Load conversations on page load and render in Conversations accordion",
    "objective": "On page load, fetch conversations data from GET /forge/v1/conversations filtered by project_id and agent_id, then render each conversation using the existing conversation_block component inside the Conversations_accordion container.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "On initial page load, client calls GET /forge/v1/conversations with project_id and agent_id as query parameters",
      "Fetched conversations response is correctly parsed and iterated",
      "Each conversation item is rendered using the existing conversation_block component",
      "All rendered blocks are appended/injected into the Conversations_accordion component",
      "Loading, empty (no conversations), and error states are handled gracefully without breaking the page",
      "No duplicate fetching or duplicate blocks on re-render / navigation"
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/ConversationsAccordion.jsx"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789714123525",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789714123525.md (status=completed)",
    "title": "Adjust Frontend Panel Column Widths",
    "objective": "Update the frontend layout so the home-chat-panel occupies 40% of the available width, while the home-sprint-panel and workspace-panel each occupy 30%.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The home-chat-panel width is set to 40% of the parent layout.",
      "The home-sprint-panel width is set to 30% of the parent layout.",
      "The workspace-panel width is set to 30% of the parent layout.",
      "The three panels fit within the parent layout without unintended overflow or gaps.",
      "The updated layout remains usable and visually consistent across supported viewport sizes."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789715172097",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789715172097.md (status=completed)",
    "title": "Simplify Conversation Block Actions and Header Layout",
    "objective": "Update the frontend conversation block by removing the selection input, timestamp, ellipsis icon, and dropdown menu, then placing Rename, Archive, and Delete as three small horizontally aligned buttons to the right of the conversation title.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The conversation block no longer displays the selection input or checkbox.",
      "The conversation block no longer displays the conversation timestamp.",
      "The ellipsis icon and dropdown menu are removed from the conversation block.",
      "Rename, Archive, and Delete are displayed as three separate small buttons.",
      "The three action buttons are arranged horizontally and aligned to the right of the conversation title.",
      "The Rename, Archive, and Delete actions continue to perform their existing functions.",
      "The updated layout remains usable and visually aligned across supported desktop and mobile viewport sizes."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789715548287",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789715548287.md (status=completed)",
    "title": "Update conversation messages API to return user and agent chat messages",
    "objective": "Modify the backend endpoint GET /forge/v1/conversations/:id/messages to return the complete chat history for a conversation, including messages sent by both the user and the agent.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The GET /forge/v1/conversations/:id/messages endpoint returns messages belonging to the requested conversation.",
      "The response includes both user-authored messages and agent-authored messages.",
      "Each returned message identifies its author or role so clients can distinguish user messages from agent messages.",
      "The endpoint preserves the existing response contract for fields unrelated to message authorship.",
      "The endpoint returns an appropriate not-found or validation error when the conversation ID is invalid or does not exist."
    ],
    "style": [
      "backend"
    ],
    "ground_truth": [
      "backend/src/agents/agent-contract.js"
    ],
    "files_changed": [
      "backend/src/agents/agent-contract.js"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789717233391",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789717233391.md (status=completed)",
    "title": "Align conversation_block action button styles with the current UI",
    "objective": "Update the frontend CSS for the Rename, Delete, and Archive buttons in conversation_block so they match the existing interface's visual style, spacing, states, and interaction patterns.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The Rename, Delete, and Archive buttons in conversation_block visually match the current UI design.",
      "Button typography, spacing, sizing, colors, borders, and icons are consistent with comparable controls in the existing interface.",
      "Hover, focus, active, and disabled states remain clear and consistent with the established UI behavior.",
      "The updated styles are responsive and do not cause layout regressions in conversation_block."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-PROJECT-NODEFORGE-1789717510702",
    "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1789717510702.md (status=completed)",
    "title": "Differentiate Active Conversation Block Styling",
    "objective": "Update the frontend CSS so that a conversation_block with the is-active state is visually distinct from other conversation blocks.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The conversation_block element with the is-active class has a clearly different visual style from inactive conversation blocks.",
      "Inactive conversation blocks retain their existing default styling.",
      "The active styling is implemented in the frontend CSS without changing unrelated component behavior.",
      "The updated styling is verified across supported desktop and mobile layouts."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/app/globals.css"
    ],
    "files_changed": [
      "ui/nextjs/app/globals.css"
    ]
  },
  {
    "id": "TICKET-STYLE-ADD-TICKET-001",
    "note": "Backfilled from final report TICKET-STYLE-ADD-TICKET-001.md (status=completed)",
    "title": "Refine Add a ticket button and modal styling",
    "objective": "Adjust the CSS styling of the Add a ticket button and its ticket-creation modal so they fit more naturally with the current website interface, while preserving the existing ticket creation behavior.",
    "acceptance_criteria": [,
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }]
      "The Add a ticket button uses spacing, typography, colors, borders, radius, and hover or focus states consistent with the existing sprint action buttons and page theme.",
      "The Add a ticket modal uses the current interface styling for its container, header, form controls, textarea, validation feedback, and action buttons.",
      "The modal remains usable and visually coherent at the existing responsive breakpoints without changing its ticket parsing or submission behavior.",
      "Only the styling required for the Add a ticket button and modal is changed; unrelated dashboard controls retain their current appearance and behavior."
    ],
    "style": [
      "frontend"
    ],
    "ground_truth": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ],
    "files_changed": [
      "ui/nextjs/components/NodeForgePanels.jsx"
    ]
  },
{
  "id": "TICKET-PROJECT-NODEFORGE-1790143726042",
  "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1790143726042.md (status=completed)",
  "title": "Add pinning for conversations in the chat list",
  "objective": "Implement conversation pinning across the backend and frontend so users can pin or unpin conversations from the left chat list, pinned conversations remain at the top, and the pinned state persists across page reloads.",
  "acceptance_criteria": [
    "The conversations data model persists a boolean pinned state for every conversation, with existing conversations receiving a safe default of false.",
    "GET /forge/v1/conversations returns the pinned state for every conversation and orders pinned conversations before unpinned conversations while preserving a deterministic order within each group.",
    "The backend provides authenticated, project-scoped pin and unpin API operations for a conversation, validates that the conversation exists and belongs to the active project, and returns the updated conversation.",
    "The frontend renders a pin/unpin control for each conversation in the left conversation list with accessible labels and state.",
    "Clicking the control calls the corresponding pin or unpin API and updates the conversation row and ordering immediately after a successful response without requiring a full page reload.",
    "Loading or refreshing the page retrieves the persisted pinned state from the list API and displays pinned conversations at the top.",
    "Pin and unpin failures do not falsely persist the optimistic state; the UI reports or restores the prior state when the API request fails."
  ],
  "style": [
    "frontend",
    "backend"
  ],
  "ground_truth": [
    "ui/nextjs/components/ConversationsAccordion.jsx",
    "backend/src/application/conversation-crud-service.js",
    "ui/nextjs/components/conversation-list-utils.js"
  ],
  "files_changed": [
    "ui/nextjs/components/ConversationsAccordion.jsx",
    "backend/src/application/conversation-crud-service.js",
    "ui/nextjs/components/conversation-list-utils.js"
  ]
},
{
  "id": "TICKET-PROJECT-NODEFORGE-1790325440606",
  "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1790325440606.md (status=completed)",
  "title": "Replace agent status selector with a color-coded status badge",
  "objective": "Update the Agents frontend page to remove the editable agent status selector and display the current status as a non-interactive badge. Use green for READY, orange for WORKING, and red for NOT CONNECT.",
  "acceptance_criteria": [
    "The agent card status selector is removed and no longer allows users to edit or persist agent status manually.",
    "Each agent card displays a non-interactive status badge with one of the labels READY, WORKING, or NOT CONNECT.",
    "READY badges use a green visual treatment, WORKING badges use an orange visual treatment, and NOT CONNECT badges use a red visual treatment.",
    "The badge reflects status updates received from the existing project stream without requiring a page refresh.",
    "Agents with missing, unknown, or unavailable status values are displayed as NOT CONNECT.",
    "The existing agent enable/disable switch, edit action, test action, and delete action continue to work independently of the status badge."
  ],
  "style": [
    "frontend"
  ],
  "ground_truth": [
    "ui/nextjs/app/agents/page.jsx",
    "ui/nextjs/app/globals.css",
    "ui/nextjs/app/tailwind.css"
  ],
  "files_changed": [
    "ui/nextjs/app/agents/page.jsx",
    "ui/nextjs/app/globals.css",
    "ui/nextjs/app/tailwind.css"
  ]
},
{
  "id": "TICKET-PROJECT-NODEFORGE-1790327458311",
  "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1790327458311.md (status=completed)",
  "title": "Refine Agents page status indicators and compact UI styling",
  "objective": "Update the Agents frontend page to use a more compact visual treatment: reduce typography size, remove card background frames, and display each agent status with a colored circular indicator and matching label color. READY must use a blue dot and blue text, WORKING must use an orange dot and orange text, and NOT CONNECT must use a red dot and red text.",
  "acceptance_criteria": [
    "The Agents page uses smaller typography for agent names, metadata, status labels, and related controls without reducing readability.",
    "Agent cards no longer display framed or filled background containers; the layout remains visually clear in both light and dark themes.",
    "READY status displays a blue circular dot followed by READY text, with both the dot and text using the same blue status color.",
    "WORKING status displays an orange circular dot followed by WORKING text, with both the dot and text using the same orange status color.",
    "NOT CONNECT status displays a red circular dot followed by NOT CONNECT text, with both the dot and text using the same red status color.",
    "Status indicators preserve accessible text labels and remain visually consistent across all agent cards and supported themes.",
    "Existing agent loading, editing, testing, deletion, and status-update behavior continues to work unchanged."
  ],
  "style": [
    "frontend"
  ],
  "ground_truth": [
    "ui/nextjs/app/agents/page.jsx",
    "ui/nextjs/app/globals.css"
  ],
  "files_changed": [
    "ui/nextjs/app/agents/page.jsx",
    "ui/nextjs/app/globals.css"
  ]
},
{
  "id": "TICKET-PROJECT-NODEFORGE-1790327815866",
  "note": "Backfilled from final report TICKET-PROJECT-NODEFORGE-1790327815866.md (status=completed)",
  "title": "Restore agent card borders and green READY status styling",
  "objective": "Update the Agents page frontend UI so each agent card displays a visible border again and the READY status uses green for both its indicator dot and READY label in all supported themes.",
  "acceptance_criteria": [
    "Agent cards on the Agents page have a visible border consistent with the existing NodeForge surface and border styling.",
    "The READY status label is rendered in green.",
    "The status dot accompanying READY is rendered in the same green color.",
    "The border and READY colors remain legible in both dark and light themes.",
    "WORKING, NOT CONNECTED, card actions, and existing agent card layout behavior are unchanged."
  ],
  "style": [
    "frontend"
  ],
  "ground_truth": [
    "ui/nextjs/app/globals.css"
  ],
  "files_changed": [
    "ui/nextjs/app/globals.css"
  ]
}
];
