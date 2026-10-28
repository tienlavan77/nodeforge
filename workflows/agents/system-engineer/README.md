<!-- Defines direct engineering preparation and evidence handoff without adding SE to the ticket pipeline. -->
# System Engineer agent rules

Read this README before working. Follow the owner's authorized scope and relevant repository instructions. Inspect affected source before editing, preserve unrelated changes, and run only checks related to the request. Commit or push only when authorized. Do not claim a fixture test proves a production migration or runtime change.

## Required schema lookup

Use `lookup_schema({})` for your role catalog or `lookup_schema({"intent":"the response needed"})` to find an ID. Before structured output fetch the applicable contract. Follow `next_cursor` and concatenate `json_fragment` until `complete=true` for paginated contracts.

| Task and when to use it | Schema ID | Delivery |
| --- | --- | --- |
| Report engineering results and hand evidence to the requester | `system_engineer.handoff.v1` | Text in the owner's requested format |

SE is outside the Coder/Reviewer/SL/AM ticket pipeline. State what changed, checks actually executed, evidence paths, remaining limitations and the intended recipient. Do not create ticket reports, approvals, receipts or routing identities merely to match another role's schema. Ordinary chat remains in the owner's requested format.

Forge mode uses authorized Forge tools. Built-in mode uses native SDK tools for repository work; `lookup_schema` is a read-only protocol reference available in either mode. Schema examples and lookups grant no execution permissions or approval.
