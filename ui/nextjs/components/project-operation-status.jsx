// Presents backend operation receipts with explicit recovery actions and honest progress.
// Unknown totals stay indeterminate. Committed file/function inventory and embedding work
// are separate facts; neither is extrapolated into a fabricated percentage or ETA.
"use client";
import { useState } from "react";
import { reloadOperation, retryProjectOperation } from "../lib/project-lifecycle-client.js";

// Keep operation diagnostics, connection failures and recovery buttons distinct for keyboard and screen-reader users.
export function ProjectOperationStatus({ operation, intent, connectionError, retryable = true, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = operation?.request_key || intent?.request_key;
  const progress = operation?.progress;
  // Execute the user's selected recovery action once, then refresh membership without replaying submission.
  async function act(retry) {
    setBusy(true); setError("");
    try { await (retry ? retryProjectOperation(operation) : reloadOperation(key)); await onChange?.(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section aria-label="Operation status" aria-live="polite" aria-busy={busy}>
    <p>{operation ? `${operation.kind} — ${operation.status}; attempt ${operation.attempt}; stage ${progress?.stage || operation.stage}` : "Outcome unknown. Reload status using the original request key."}</p>
    <p>Request key: <code>{key}</code></p>
    {operation?.status === "succeeded" && <p>Operation succeeded.</p>}
    {operation?.status === "failed" && <p role="alert" data-error="project">{operation.diagnostic?.message || "Project operation failed."}</p>}
    {operation?.status === "running" && <progress aria-label="Index progress" />}
    {progress && <>
      <ul aria-label="Backend stages">{Object.entries(progress.stages || {}).map(([stage, status]) => <li key={stage}>{stage}: {status}</li>)}</ul>
      <dl aria-label="Committed index counters">{Object.entries(progress.counters || {}).map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count}</dd></div>)}</dl>
      {progress.checkpoint && <p>Committed files: {progress.checkpoint.files}; functions: {progress.checkpoint.functions}; index version: {progress.checkpoint.version}</p>}
      <p>Embedding: {progress.embedding?.status}; pending: {progress.embedding?.pending}; processing: {progress.embedding?.processing}; succeeded: {progress.embedding?.succeeded}; failed: {progress.embedding?.failed}</p>
    </>}
    {(connectionError || error) && <p role="alert" data-error="connection">Connection/status error: {error || connectionError}</p>}
    <button type="button" disabled={busy} onClick={() => act(false)}>Reload status</button>
    {operation?.status === "failed" && retryable && <button type="button" disabled={busy} onClick={() => act(true)}>Retry operation</button>}
  </section>;
}
