# Conversations: luu tru va tao qua API

Tai lieu giai thich (1) conversation duoc luu vao database nhu the nao va (2) tao mot conversation bang route API nao.

## Tong quan

Mot "conversation" gom 3 phan luu o 3 noi khac nhau:

- **Danh muc conversation** (id, project, agent, title, status): bang SQLite `conversations`.
- **Tin nhan** (messages): bang SQLite `agent_communications`, cung controlDb, gan lien qua cot `conversation_id`.
- **Runtime state** theo conversation (vi du `last_provider_response_id` de resume Claude/Codex): **file-based**, khong phai SQLite.

## 1. Bang `conversations`

Dinh nghia trong `backend/src/application/conversation-crud-service.js:51` (ham `ensureTable`):

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived | closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_project_agent ON conversations (project_id, agent_id, updated_at);
CREATE INDEX IF NOT EXISTS conversations_project       ON conversations (project_id, updated_at);
```

Logic CRUD cung file, tao boi `createConversationCrudService({ database, clock })`:

- `create({ id?, project_id!, agent_id!, title?, status? })` — `id` mac dinh `CONV-${randomUUID()}`, `title` mac dinh `"New conversation"`, `status` mac dinh `active`. Trung `id` → 409.
- `ensure({ id, project_id, agent_id, title })` — `get(id)` neu da co thi tra ve, chua co thi `create`. Day la duong tao conversation ngam dinh khi chat.
- `list({ projectId?, agentId? })`, `get(id)`, `update(id, { title?, status? })` (chi doi duoc title/status), `remove(id)`.

## 2. File SQLite nao?

`database` duoc inject tu `backend/scripts/start-control-api.mjs:47` → `backend/scripts/control-api-platform.mjs:38`:

```js
const conversations = createConversationCrudService({ database }); // database = controlDb
```

`controlDb` tao tai `backend/scripts/control-api-storage.mjs:15`:

```js
controlDb = await createDatabaseService({ dataDir: config.dataDir, runtimeDir: "." })
```

Duong dan file:

- `config.dataDir` (`control-api-config.mjs:5`) = `NODE_CONTROL_DATA_DIR` hoac mac dinh `join(cwd, ".forge/runtime/nf")`.
- `database-service.js` → `index-database.js:7,163`: ten file la `index.db`, `databasePath = join(runtimeDir, DATABASE_FILE)`.

→ conversations nam trong **SQLite `index.db` cua controlDb** = `.forge/runtime/nf/index.db`.

Luu y: day KHAC voi `indexDb` (code-index) o `.forge/runtime/wc/index.db`.

## 3. Messages va runtime state

- **Messages** khong nam trong bang `conversations` ma trong bang `agent_communications` (`backend/src/modules/governance/agent-communication-store.js:115`), cung controlDb, cot `conversation_id` + index `agent_communications_conversation`.
- **Runtime state** theo conversation (vi du `last_provider_response_id`) luu **file-based** qua `backend/src/modules/protocol/conversation-state-store.js`, duoi `.forge/runtime/protocol-storage/conversations` — khong phai SQLite.

## 4. Tao conversation bang route API nao?

### Route tuong minh (CRUD)

`backend/src/transport/http/forge-v1-router.js:78`:

```
POST /forge/v1/conversations
Body: { project_id: string!, agent_id: string!, title?: string, status?: "active"|"archived"|"closed", id?: string }
→ 201 { id, project_id, agent_id, title, status, created_at, updated_at }
```

CRUD du bo (`forge-v1-router.js:76-86`):

```
GET    /forge/v1/conversations?project_id=&agent_id=   → list
GET    /forge/v1/conversations/:id                      → get (404 neu khac project)
PUT    /forge/v1/conversations/:id   { title?, status? }
DELETE /forge/v1/conversations/:id
```

### Route ngam dinh qua chat (tu `ensure`)

Ca 4 route chat deu goi `ownerChatService.submit` → `backend/src/application/owner-chat-service.js:44` tu dong `conversationCrudService.ensure({ id: conversation_id, project_id, agent_id, title })`:

```
POST /forge/v1/conversations                              // canonical — forgeV1("/conversations")
POST /forge/v1/projects/:id/conversations                 // :262
POST /forge/v1/projects/:id/conversations/:cid/messages   // :267
POST /forge/v1/conversations/:cid/messages                // :272
```

→ chi can gui tin nhan dau tien voi `conversation_id` chua ton tai, conversation se duoc tao tu dong, khong can goi CRUD rieng.

## Dau moi tham chieu

- `backend/src/application/conversation-crud-service.js` — schema + CRUD.
- `backend/src/transport/http/forge-v1-router.js:76-86, 262-281` — route.
- `backend/src/application/owner-chat-service.js:44` — ensure khi chat.
- `backend/scripts/start-control-api.mjs:47`, `control-api-platform.mjs:38`, `control-api-storage.mjs:15`, `control-api-config.mjs:5`, `src/infrastructure/sqlite/index-database.js:7,163` — duong dan den file `index.db`.
- `backend/src/modules/governance/agent-communication-store.js:115` — bang messages.
- `backend/src/modules/protocol/conversation-state-store.js` — runtime state file-based.
