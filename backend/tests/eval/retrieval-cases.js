// Retrieval eval cases: real Forge tickets with ground-truth files from final reports.
export const RETRIEVAL_EVAL_CASES = [
  {
    id: "1789610673670",
    note: "Frontend accordion update after create-conversation; no final report, truth from audit run",
    title: "Frontend: Update conversation accordion after creating new conversation",
    objective: "Update the frontend so that after successfully sending a create-conversation request and receiving the response, the conversation accordion is immediately updated with a new single-line entry. Style the new entry with CSS that matches the existing UI theme.",
    acceptance_criteria: ["After a successful create-conversation API request and response, the conversation accordion list is updated without reload"],
    style: ["frontend"],
    ground_truth: ["ui/nextjs/components/ConversationsAccordion.jsx", "ui/nextjs/app/globals.css", "ui/nextjs/app/page.jsx"]
  },
  {
    id: "1789618154255",
    note: "Mixed style: new ConversationsBlock component + state store",
    title: "Create Conversations Block component for conversation accordion",
    objective: "Implement a frontend UI Conversations Block component to be displayed inside the conversation accordion. The component must contain three aligned sections: a check input on the left, a title on the left, and an actions menu on the right. The menu must allow users to delete, rename, and archive a conversation.",
    acceptance_criteria: ["Conversations Block component is created with layout: check input aligned left | title aligned left | menu aligned right", "Menu provides functional actions: Delete conversation, Rename conversation, and Archive conversation"],
    style: ["frontend", "backend"],
    ground_truth: ["ui/nextjs/components/ConversationsBlock.jsx", "backend/src/modules/protocol/conversation-state-store.js", "ui/nextjs/components/ConversationsAccordion.jsx", "ui/nextjs/app/globals.css"]
  },
  {
    id: "1789715548287",
    note: "Backend messages API; agent-contract.js is known hub noise that once took top 1",
    title: "Update conversation messages API to return user and agent chat messages",
    objective: "Modify the backend endpoint GET /forge/v1/conversations/:id/messages to return the complete chat history for a conversation, including messages sent by both the user and the agent.",
    acceptance_criteria: ["The GET /forge/v1/conversations/:id/messages endpoint returns messages belonging to the requested conversation.", "The response includes both user-authored messages and agent-authored messages."],
    style: ["backend"],
    ground_truth: ["backend/src/application/conversation-audit-history-service.js", "backend/src/transport/http/forge-v1-router.js"],
    hub_paths: ["backend/src/agents/agent-contract.js", "backend/src/shared/errors.js"]
  },
  {
    id: "1789618365350",
    note: "Load conversations on page load into accordion",
    title: "Load conversations on page load and render in Conversations accordion",
    objective: "On page load, fetch conversations data from GET /forge/v1/conversations filtered by project_id and agent_id, then render each conversation using the existing conversation_block component inside the Conversations_accordion container.",
    acceptance_criteria: ["On initial page load, client calls GET /forge/v1/conversations with project_id and agent_id as query parameters"],
    style: ["frontend", "backend"],
    ground_truth: ["ui/nextjs/components/ConversationsAccordion.jsx"]
  },
  {
    id: "1789717510702",
    note: "Single-file CSS change; hub noise must not outrank it",
    title: "Differentiate Active Conversation Block Styling",
    objective: "Update the frontend CSS so that a conversation_block with the is-active state is visually distinct from other conversation blocks.",
    acceptance_criteria: ["The conversation_block element with the is-active class has a clearly different visual style from inactive conversation blocks."],
    style: ["frontend"],
    ground_truth: ["ui/nextjs/app/globals.css"]
  },
  {
    id: "1789481976392",
    note: "Backend schema migration: team field; test file excluded from truth",
    title: "Update database schema to add team field",
    objective: "Modify the backend schema to include a new 'team' field in the database, enabling team-based data association and queries.",
    acceptance_criteria: ["The database schema is updated to include a 'team' field with an appropriate data type and constraints.", "A corresponding migration script is created and can be applied successfully."],
    style: ["backend"],
    ground_truth: ["backend/src/modules/projects/task-store.js", "backend/src/modules/projects/task-schema-migration.js", "schemas/project/task.schema.json"]
  },
  {
    id: "1789549690715",
    note: "Backend UUID migration for conversation id",
    title: "Migrate conversation schema id field to UUID format",
    objective: "Modify the backend conversation schema so that the id field is generated using UUID format instead of the current identifier strategy. Ensure existing data is handled appropriately during the migration.",
    acceptance_criteria: ["The conversation schema id field is defined to accept and generate values in UUID format.", "New conversation records created through the backend API automatically receive a UUID-based id."],
    style: ["backend"],
    ground_truth: ["backend/src/application/conversation-crud-service.js", "backend/src/infrastructure/sqlite/index-database.js"]
  },
  {
    id: "1789572090025",
    note: "Frontend modal + backend route in one ticket",
    title: "Implement New Conversation modal with name input and API integration",
    objective: "Edit the frontend UI so that clicking the 'New Conversation' button opens a modal containing a text input for the conversation name and a 'Create' button that calls POST /forge/v1/conversations.",
    acceptance_criteria: ["Clicking the 'New Conversation' button opens a modal dialog.", "The modal contains a single text input field for the user to name the conversation."],
    style: ["frontend", "backend"],
    ground_truth: ["backend/src/transport/http/forge-v1-router.js", "ui/nextjs/components/ConversationsAccordion.jsx"]
  },
  {
    id: "1789476103218",
    note: "Regenerate English flow: frontend call + backend sprint-leader path",
    title: "Implement Regenerate English backend flow via sprint leader",
    objective: "When a user clicks 'Regenerate English' in the UI, the frontend calls the ticket API. The backend receives the request, uses the stored Vietnamese context to instruct the sprint leader to recreate the English version of the ticket, persists the updated ticket to the database, and returns the refreshed ticket.",
    acceptance_criteria: ["Clicking 'Regenerate English' in the UI triggers the corresponding ticket regeneration API endpoint", "The backend passes the original Vietnamese context to the sprint leader for English ticket regeneration"],
    style: ["backend"],
    ground_truth: ["ui/nextjs/lib/node-client.js", "ui/nextjs/components/NodeForgePanels.jsx"]
  },
  {
    id: "1789481898268",
    note: "Team selector in agent modals: UI component + settings service",
    title: "Add 'Team' selector to Add Agent and Edit Agent modals on Agents page",
    objective: "Update the frontend Agents page UI by adding a 'Team' selector (dropdown) to both the Add Agent and Edit Agent modals. The selector should appear directly below the existing 'Role' field and offer three options: Backend, Frontend, Security.",
    acceptance_criteria: ["A selector/dropdown labeled 'Team' is visible in the Add Agent modal on the Agents page.", "A selector/dropdown labeled 'Team' is visible in the Edit Agent modal on the Agents page."],
    style: ["frontend", "backend"],
    ground_truth: ["ui/nextjs/components/AddAgentModal.jsx", "backend/src/application/agent-settings-service.js"]
  },
  {
    id: "1789602291693",
    note: "CreateConversationModal component + global CSS",
    title: "Add a Create Conversation Modal to the Frontend UI",
    objective: "Use the existing UI modal component to provide a frontend dialog where users can enter a conversation title and create a new conversation. The modal should follow the visual style and interaction pattern of the existing ticket modal view, with CSS that matches the current theme.",
    acceptance_criteria: ["A modal for creating a conversation is implemented using the existing UI modal component.", "The modal includes an input field for the conversation title."],
    style: ["frontend"],
    ground_truth: ["ui/nextjs/components/CreateConversationModal.jsx", "ui/nextjs/app/globals.css"]
  }
];
