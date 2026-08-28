export default function SprintSummary({ sprint }) {
  return <section className="dashboard-section sprint-summary" aria-label={`Sprint ${sprint?.id ?? "summary"}`}><h2>{sprint?.id ?? "Sprint"}</h2><p>{sprint?.objective ?? "No sprint objective provided."}</p><small>{sprint?.completed_ticket_count ?? 0}/{sprint?.ticket_count ?? sprint?.tickets?.length ?? 0} tickets completed · {sprint?.status ?? "planned"}</small></section>;
}
