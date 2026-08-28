export default function ProjectLogPreview({ entries = [] }) {
  return <section className="dashboard-section project-log-preview" aria-label="Project log preview"><h2>Project Log</h2>{entries.length ? <ol>{entries.slice(0, 10).map((entry, index) => <li key={entry.id ?? `${entry.timestamp}-${index}`}><strong>{entry.type ?? entry.event_type ?? "event"}</strong><span>{entry.message ?? entry.payload?.text ?? JSON.stringify(entry.content ?? entry.payload ?? {})}</span></li>)}</ol> : <p className="dashboard-state">No project log entries.</p>}</section>;
}
