# Audit 18/09 — retrieval 3 tang + style + embedding ha tang

Ngay: 2026-09-18. Pham vi: nhung gi da lam va dat duoc trong dot tinh chinh candidate/search vua qua (relevant-tree, code-search, style ticket, explore pre-pass, embedding).

## 1. Da lam

### 1.1. Ticket style bat buoc
- `schemas/governance/ticket.schema.json`: them `style` (array, enum `frontend|backend|security|infra|docs`, `minItems: 1`) vao `required`.
- `ticket-crud-service.js`: prompt sprint-leader yeu cau tra `style` (REQUIRED, khong duoc omit); `UPDATABLE` them `style`; `updateTicket` tu infer style khi patch doi title/objective/AC ma chua co style; them ham `inferStyle` regex.
- `prose-ticket-service.js`: `createFromObject` / `parse` / `regenerateEnglish` deu gan `style` qua `inferStyle` neu thieu; them ham `inferStyle`.
- Backfill: 8/8 tickets o `governance_roadmaps` seq 620 da co style (7 tu infer + 1 co san). Ticket mau: `1789610673670` -> `["frontend"]`, `1789621594709` -> `["frontend","backend"]`.

### 1.2. Style-aware filtering trong relevant-tree
- `relevant-tree.js`: nhan `style`, map qua `styleToPrefixes()` (`frontend -> ui/,web/src/`, `backend -> backend/,schemas/`, ...). Ticket mixed (`style.length > 1`) thi limit 4 -> 8.
- Thread `ticket.style` vao moi `select()`: `nodeforge-task-integration.js` (qua explore pre-pass), `stage1-ticket-runner.js:87` (limit 30), `attempt-context-builder.js:89`.
- Loai file `.test.` o moi duong search (candidates + `search_code`).

### 1.3. Ranking 3 tang (thay the score cu)
- Tang 1 (ten file/ham, shortlist khong diem truoc): search `kind:file` + `kind:symbol` theo tung term, thu thap set terms/file, roi cham mot lan (toi da 3 terms khac nhau + bonus file+symbol). Khong cong don vo han cho tu chung.
- Tang 2 (graph 1 buoc): chi tu top-8 tang 1, moi file dich toi da 2 seeds.
- Tang 3 (recall FTS): chi lap cho file duoi 4 diem, tran 2d.
- Sort: tong diem -> t1 -> direct (khong relations) -> path ngan -> alphabet.

### 1.4. Stop-word + tokenizer
- `search-vocabulary.js`: mo rong stop-word EN (~60 tu chung: get/set/can/update/return/response/...), split snake_case/kebab-case thanh token rieng, giu camelCase nguyen.

### 1.5. Explore pre-pass (inline)
- Moi `backend/src/modules/supervisor/explore-pre-pass.js`: `createExplorePrepass({ relevantTreeSelector }).run({ ticket })`, read-only, tra `targetFiles/targetPath/allowedPrefixes/confidence`.
- Cam vao `runToolTicket` + `runCodexTask` truoc keyword fallback; prompt coder co dong pre-pass; log `supervisor.explore_prepass`; luu `toolContext.explorePrepass`. Loi thi fallback, khong block.
- Noi `relevantTreeSelector` tu `production-runtime.js`.
- Docs `docs/giai-doan-3/explore-agent.md`: quy trinh, project map, style-prefix table, contract, test plan.

### 1.6. Chan semantic (embedding, chua bat)
- Moi `embedding-provider.js` (OpenAI-compatible `/embeddings`), `ollama-embedding-provider.js` (Ollama LAN `http://192.168.1.180:11434/api/embeddings`, queue concurrency=1, timeout 8s), `embedding-store.js` (chuyen sang `symbol_embeddings`: `symbol_id PK, embedding_model tag, vector base64, content_checksum`).
- `index-database.js`: migration 9 tao `symbol_embeddings` chung connection (khong ensureTable rieng).
- `incremental-indexer.js`: hook per-symbol trong `indexContent` qua `queueSymbolEmbedding` (skip khi checksum+model trung, best-effort, serial nho provider queue); `clearContentIndex` don `removeByFile`; xoa code file-level cu.
- `relevant-tree.js`: `selectWithEmbeddings()` async merge semantic (tran 4d, bo qua file >= 6d), fallback ve `select()` khi chua cau hinh.
- Moi `backend/scripts/backfill-symbol-embeddings.mjs` (tai dung text+checksum rule cua hook, `--limit`, `--model`, `OLLAMA_BASE_URL`).
- Chua wiring vao `control-api-platform.mjs`, chua chay backfill that, chua restart API de migration 9 apply.

### 1.7. Chat/messages API + UI (ticket chay that)
- `forge-v1-router.js`: `GET /conversations/:id/messages` tra user+agent history qua `toConversationChatHistory`, co limit/cursor/order, validate conversation.
- `server.js`: xoa route legacy `POST /projects/:id/conversations/:id/messages` va GET stream duplicate; chat chi qua `/forge/v1/conversations/:id/messages`.
- `project-stream.js` (+schema): mo rong stream event cho chat.
- UI: `page.jsx` (chat state localStorage, active conversation, typing/loading), `node-client.js` (client messages API), `ConversationsAccordion.jsx`, xoa route stream Next.js thua.
- Cac ticket da completed: accordion interactive row + drag reorder (`1789610673670`), ConversationsBlock moi (`1789618154255`), load conversations on page load (`1789618365350`), active block styling (`1789717510702`).

## 2. Dat duoc (do duoc)
- Unit: `relevant-tree.test.js` 4/4, `select-code-graph-candidates` 6/6 (sau sua mock), `code-search` 7/7, tools 20/20 pass.
- Ticket `1789610673670` (`style: frontend`): candidates `globals.css, ConversationsAccordion.jsx, layout.jsx, page.jsx` — toan UI, Accordion top 2.
- Ticket `1789618154255` (mixed): limit 8 -> 7 files, co `ConversationsAccordion.jsx` + `conversation-state-store.js`, khong file `.test.` nao.
- Ticket `1789715548287` (`style: backend`): co `owner-chat-service.js` top 4 (truoc rot), `errors.js` bien mat khoi top nho 3-term cap + test filter.
- Run that `1789715548287`: 24 turns, sua `agent-contract.js` + `audit-history-service.js` + `forge-v1-router.js`, 2 commits (`f3515d9`, `b34a6cb`), nhung `in_progress` (thieu commit/report) va `target_path` roi vao `agent-contract.js` (noise top 1) — cho thay ranking con yeu o truong hop tu chung (`agent`, `contract`).
- Embedding: syntax OK, queue serial verify (aaa|bbb|ccc), fallback khong-embed chay binh thuong; chua co vector that trong DB (`file_embeddings` khong ton tai, `symbol_embeddings` cho migration).

## 3. Chua dat / rui ro
- FTS OR + bm25 cho diem bang nhau hang loat (3 = 3 = 3) nen tie-break quyet dinh, chua on dinh cho ticket dai.
- File hub (`errors.js`, `agent-contract.js`) van leo top nho khop tu chung; IDF tren shortlist nho khong phan biet duoc, can IDF toan index hoac chan ngu nghia that.
- Summary comment phu khong deu giua cac file nen chua dung lam tin hieu chinh.
- `search_code` truc tiep cua agent van tra test truoc khi filter (da fix o code-search.js nhung chua verify tren run that).
- Chua commit/push, chua restart API (migration 9, wiring embedding, pre-pass chua co tac dung tren production).
