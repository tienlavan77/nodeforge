// Migration owners for existing modal users adopting the shared dialog primitive.
export const DIALOG_MIGRATION_INVENTORY = [
  {
    modal: "AddAgentModal",
    owner: "ui/nextjs/app/agents/page.jsx",
    state: "Keep visibility, form, and submit state in the page; Dialog owns presentation and focus.",
  },
  {
    modal: "Conversation modal users",
    owner: "Each existing conversation feature owner",
    state: "Keep visibility and conversation data in the feature owner; migrate presentation only.",
  },
  {
    modal: "Confirmation dialogs",
    owner: "The invoking feature",
    state: "Keep action and confirmation state in the invoking feature; use ConfirmationDialog for presentation.",
  },
  {
    modal: "Drawers",
    owner: "The invoking feature",
    state: "Keep drawer visibility and content in the invoking feature; use Dialog variant=drawer.",
  },
];
