"use client";
// Displays a referenced project Markdown file beside the conversation without leaving chat.

import { useEffect, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { MarkdownPreviewContent } from "./markdown-preview-content.jsx";

// Loads the selected Markdown file through the Control API and lets the owner close its preview.
export function MarkdownPreviewPanel({ client, projectId, path, onClose }) {
  const [state, setState] = useState({ status: "loading", content: "" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading", content: "" });
    client.getMarkdownFile(projectId, path).then((result) => { if (active) setState({ status: "ready", content: result.content ?? "" }); }).catch((error) => { if (active) setState({ status: "error", content: error.message ?? "Unable to load Markdown." }); });
    return () => { active = false; };
  }, [client, path, projectId]);
  return <aside className="markdown-preview-panel" aria-label={`Markdown preview: ${path}`}><header><strong>{path}</strong><button type="button" onClick={onClose} aria-label="Close Markdown preview">×</button></header>{state.status === "loading" ? <p className="markdown-preview-state">Loading…</p> : <MarkdownPreviewContent markdown={state.content} />}</aside>;
}
