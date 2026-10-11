// Keeps the conversation statusbar slot; project identity and Git status live beside the composer in SystemToolMode.
"use client";

export function ConversationProjectGit({ children }) {
  return <div className="home-plan-approval-notice" role="status">{children}</div>;
}
