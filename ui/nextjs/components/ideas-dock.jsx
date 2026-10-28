/**
 * Adds a notebook control to the existing workspace monitor dock without owning conversation state.
 * The selected project supplies an immutable client generation; opening the floating panel changes
 * only local visibility. Keeping the panel mounted preserves inputs during conversation or agent changes.
 */
"use client";
import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createNodeClient } from "../lib/node-client.js";
import { getProjectSelection, subscribeProjectSelection } from "../lib/project-selection.js";
// eslint-disable-next-line no-unused-vars -- The panel is rendered through JSX.
import { IdeasPanel } from "./ideas-panel.jsx";

/** Keep server rendering deterministic until the admitted client project snapshot becomes available. */
const initialSelection = { projectId: null, generation: 0 };

/** Toggle the project notebook from the existing dock and restore keyboard focus when closing it. */
export function IdeasDock({ projectId: propProjectId } = {}) {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const explicitProjectId = propProjectId && propProjectId !== selection.projectId ? propProjectId : undefined;
  const activeProjectId = explicitProjectId || selection.projectId;
  const client = useMemo(() => createNodeClient(explicitProjectId), [explicitProjectId, selection.projectId, selection.generation]);
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  const panelId = useId();
  /** Close only the notebook; do not affect conversation navigation or stream subscriptions. */
  function close() { setOpen(false); button.current?.focus(); }
  if (!activeProjectId) return null;
  return <>
    <button ref={button} type="button" aria-label="Ý tưởng" aria-pressed={open} aria-expanded={open}
      aria-controls={panelId} onClick={() => setOpen((previous) => !previous)}>Ý tưởng</button>
    <IdeasPanel key={activeProjectId} client={client} projectId={activeProjectId} open={open} onClose={close} panelId={panelId} />
  </>;
}
