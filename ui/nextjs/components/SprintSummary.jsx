// Compact sprint summary card with completion stats.
export default function SprintSummary({ sprint }) {
  return <section className="dashboard-section sprint-summary" aria-label={`Sprint ${sprint?.id ?? "summary"}`}><h2>{sprint?.id ?? "Sprint"}</h2><p>{sprint?.objective ?? "No sprint objective provided."}</p><small>{sprint?.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint?.tasks?.length ?? 0} tickets completed · {sprint?.status ?? "planned"}</small></section>;
}
