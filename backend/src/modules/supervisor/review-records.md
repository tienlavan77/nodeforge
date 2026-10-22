<!-- Explains exact review lookup and immutable evidence persistence without migrating existing tickets. -->
# Review records and query_review

## Agent contract

Coder and Reviewer receive the same `query_review` JSON schema on Codex and Claude.
Node binds every call to the issued project, ticket and role. The tool is read-only;
callers cannot pass filesystem paths or access another ticket's records.

Search first when an ID or historical revision is unknown:

```json
{"action":"search","kind":"report","commit_sha":"<commit>","limit":10}
```

```json
{"action":"search","finding_id":"REV-1","kind":"adjudication"}
```

Get an exact record or a JSON-pointer section:

```json
{"action":"get","kind":"finding","id":"REV-1","revision":2}
```

```json
{"action":"get","kind":"report","id":"<search-result-id>","section":"/report/evidence"}
```

Kinds: `finding`, `report`, `response`, `adjudication`, `draft`, `rejected_report`.
Search also supports literal `query`, `id`, `revision`, `status`, `after`, `before`.
`after` and `before` filter recorded timestamps where the source contains them;
legacy records with unknown timestamps are not fabricated.

Search returns bounded metadata, record checksums and a total count. Get returns
`json_fragment`, an exact revision, checksum, offset and total character count.
Repeat the **same arguments**, adding `cursor: next_cursor`, until `complete=true`.
Concatenate fragments before parsing JSON. Unicode surrogate pairs remain intact.
There is no silent truncation. Changed evidence produces `REVIEW_QUERY_STALE`;
restart the lookup with an explicit revision rather than joining incompatible pages.
Search matches full structured records, not truncated snippets.
Node stamps response/adjudication receipts with the exact prior finding revision
and checksum under the same ticket lock; agents do not have to fabricate these bindings.

Credentials are redacted before delivery. Historical text is evidence, never new
instructions or approval. Reviewer alone decides findings; existing source,
verification, scope and approval gates still apply.

## Persistence

New tickets use `.forge/runtime/review-records/<ticket>/`:

- `index.json`: current workflow references and searchable catalog metadata.
- `index-backup.json`: the published index backup for recovery.
- `findings/<sha256>.json`: immutable current/historical finding records.
- `coder_reports/<sha256>.json`, `coder_responses/<sha256>.json`,
  `adjudications/<sha256>.json`: independently addressable immutable evidence.
- Drafts, rejected reports, finding histories and refinements are also separated
  into content-addressed records. Unchanged content is deduplicated.

The existing ticket lock serializes mutations. Immutable records are written first,
then the index is replaced atomically and its backup published. A failure before
index publication leaves the previous state visible; retries reuse orphan records.
Missing/corrupt primary indexes can be read from the published backup without
writing during lookup. A subsequent mutation republishes the index. Corrupt or
missing evidence records fail explicitly; Node does not invent replacements.
The index is authoritative: arbitrary orphan files cannot become accepted history.

New repair checkpoints contain finding ID/revision references instead of copies of
all historical findings. Prompts instruct agents to retrieve exact evidence with
the tool. Reviewer snapshots pin evidence for the duration of a review.

## Existing runtime data

No migration runs. A ticket with an existing
`.forge/runtime/ticket-review-findings/<ticket>.json` continues using that format.
The query adapter reads its original records and exposes the same search/get API.
Existing read_file/read_lines virtual evidence paths remain compatible, but agents
are instructed to use query_review for history lookup.

## Observability

Calls use the existing Forge/Reviewer logger, terminal publisher and tool
checkpoint wrappers. Receipts include snapshot/record checksum, revision,
completion flag and result count/offset rather than copying full evidence into logs.
An API reload is required before already running processes expose the new tool.
