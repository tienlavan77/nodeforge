# Explore Agent: quy trinh tim file truoc khi coder chay

Tai lieu mo ta Explore pre-pass — buoc tim file chinh xac truoc khi coder agent chay, de coder khong sua nham file (VD sua `.workspace` thay vi `.home-workspace`).

## Van de

Coder agent nhan candidates tu FTS (`relevant-tree.js` + tool `select_code_graph_candidates`, limit 4) nen hay sai:

- Sua nham selector (`.workspace` thay vi `.home-workspace` tren Home Chat).
- File `.test.js` lot vao candidates.
- Ticket frontend lan backend (vi scope suy tu keyword regex).

`ticket.style` da co tu sprint-leader (Bat buoc: `frontend|backend|security|infra|docs`) nhung truoc day chua duoc tieu thu luc run.

## Quy trinh

```
ticket (title/objective/AC/style)
  -> Explore pre-pass (read-only, inline, truoc coder)
       -> relevantTreeSelector.select({ title, objective, acceptance_criteria, style, limit, depth: 1 })
       -> FTS content + graph getDependencies/getDependents
       -> { targetFiles, targetPath, allowedPrefixes }
  -> runToolTicket / runCodexTask
       -> targetPath = prepass.targetPath ?? ticketTargetPath(ticket)
       -> allowedPrefixes = union(prepass.prefixes, prefixForPath(target), ticketAllowedPrefixes)
       -> toolContext.explorePrepass (audit)
       -> prompt coder co dong pre-pass
  -> coder (9 Forge tools, khong built-in)
```

Pre-pass chay inline trong cung tien trinh, khong ton session SDK moi, khong goi built-in. Loi thi fallback ve duong keyword cu, khong block coder.

## Project map

| Mien | Prefix |
|---|---|
| frontend | `ui/nextjs/`, `ui/src/`, `web/src/` |
| backend | `backend/src/`, `schemas/` |
| contracts | `schemas/` |

## Style -> prefix

| style | Prefix |
|---|---|
| frontend | `ui/`, `web/src/` |
| backend | `backend/`, `schemas/` |
| security | `backend/src/modules/agent/`, `backend/src/infrastructure/`, `schemas/` |
| infra | `backend/src/infrastructure/`, `.forge/` |
| docs | `docs/`, `schemas/` |

Ticket mixed (`style.length > 1`) thi limit 4 -> 8 de du ca hai mien. File `.test.` bi loai o moi dang search.

## Input / Output contract

Input: `{ ticket: { title, objective, acceptance_criteria, style } }`.
Output: `{ targetFiles[], targetPath|null, allowedPrefixes[], confidence, reason, durationMs }`.

## Diem cam

- `nodeforge-task-integration.js`: `runToolTicket` + `runCodexTask` (goi pre-pass, seed prompt).
- `stage1-ticket-runner.js:87`: `select({ ..., style: ticket.style, limit: 30 })`.
- `attempt-context-builder.js:89`: `select({ ..., style: ticket.style })`.

## Test plan

1. `node --check` cac file sua.
2. `node --test backend/tests/unit/relevant-tree.test.js backend/tests/tools/*.test.js`.
3. `select({ style: ["frontend"] })` cho ticket conversation-accordion -> top co `ConversationsAccordion.jsx`, khong `.test.`.
4. Dispatch 1 ticket frontend that, kiem tra log `supervisor.explore_prepass` co target dung.
