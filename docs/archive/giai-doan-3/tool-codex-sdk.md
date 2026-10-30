# Báo cáo nghiên cứu Codex SDK — sử dụng đúng Forge tools (chưa code)

> Gate thiết kế vẫn hiệu lực: báo cáo này chỉ là findings, **không sửa file** nào.

## 1) Tóm tắt 1 dòng

`@openai/codex-sdk 0.154.0` không phải API client — nó spawn binary `codex` qua `codex exec --experimental-json` và trao đổi JSONL qua stdio; mọi config xuống model đều đi qua các cờ `--config key=value` dạng TOML. Đường Forge MCP hiện tại **hai tiến trình** (HTTP session loopback + bridge subprocess stdio) và **chỉ đúng khi bật feature gate** `mcp_2026_07_28`. Nhưng có 1 lỗi blocking: gói CLI `@openai/codex` **chưa được cài** nên path nhị phân không tồn tại (xem §6).

---

## 2) SDK hoạt động như thế nào (đã đọc mã nguồn đã cài)

### 2.1 Wrapper CLI

- `backend/node_modules/@openai/codex-sdk/README.md:15-25` ghi nguyên văn: *"wraps the `codex` CLI ... spawns the CLI and exchanges JSONL events over stdin/stdout"*.
- `backend/node_modules/@openai/codex-sdk/dist/index.d.ts:1-286` định nghĩa hợp đồng: `CodexOptions`, `ThreadOptions`, `TurnOptions`, `Thread.runStreamed(input, turnOptions) -> Promise<StreamedTurn>` với `StreamedTurn.events: AsyncGenerator<ThreadEvent>`, `ThreadEvent = thread.started|turn.started|turn.completed|turn.failed|item.started|item.updated|item.completed|error`, `ThreadItem = agent_message|reasoning|command_execution|file_change|mcp_tool_call|...` và `McpToolCallItem { id, type, server, tool, arguments, result?, error?, status }`.

### 2.2 Serialization config -> TOML -> argv

- `dist/index.js: findCodexPath / CodexExec.run`: dựng `commandArgs = ["exec","--experimental-json"]`, rồi lần lượt push `--config` cho:
  1. `config` có cấu trúc (qua `serializeConfigOverrides -> flattenConfigOverrides -> toTomlValue -> formatTomlKey`),
  2. `configOverrides[]` thô,
  3. SDK-managed (`baseUrl -> --config openai_base_url=...`, `apiKey -> CODEX_API_KEY` env),
  4. thread-specific (`model_reasoning_effort`, `web_search`, `approval_policy`, sandbox, cwd), rồi `spawn(executablePath, commandArgs, { env })`.
- `toTomlValue` serializes: string qua `JSON.stringify`, number bare, boolean `true/false`, array `[a,b]`, object inline `{k = v}`. `null` **throw** `Codex config override at <path> cannot be null`; `undefined` bị skip. Key khớp `/^[A-Za-z0-9_-]+$/` giữ bare, còn lại quote — `formatTomlKey`.
- `env` semantics (README + `CodexOptionsDoc`): *khi cung cấp `env`, SDK không inherit `process.env`* — vì thế gateway phải tự merge `env: {...environment, ...options.env}` nếu muốn giữ env hiện tại.

### 2.3 Enum hợp lệ (từ `dist/index.d.ts`)

- `ApprovalMode = "never"|"on-request"|"on-failure"|"untrusted"`
- `SandboxMode = "read-only"|"workspace-write"|"danger-full-access"`
- `ModelReasoningEffort = "minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"|"persistent"` — **"none" không hợp lệ**, nên `normalizeReasoningEffort` trả `undefined` là đúng.
- `WebSearchMode = "disabled"|"cached"|"live"`

---

## 3) Đường đi Forge tools hiện tại cho Codex (đúng thiết kế, còn thiếu chặn cứng)

Chuỗi đã verify qua đọc code tuần tự:

1. **Chọn agent & handoff** — `backend/src/modules/supervisor/nodeforge-task-integration.js:11-50` (`submitTicket`): `agentResolver.resolveAvailable(required_role)` (throw `AGENT_NOT_AVAILABLE` nếu không có), build `request`, `await handoffQueue.enqueue(request)`, log `supervisor.ticket_handoff`, **rồi ngay trong cùng call** rẽ nhánh `isOpenAiProfile -> runOpenAiHello`, `isCodexProfile -> runCodexTask`, else `runToolTicket`.

2. **Chuẩn bị Forge tools cho Codex** — `nodeforge-task-integration.js:94-136` (`runCodexTask`):
   - `runtimeGovernance.createExecutionContext({ task_id, execution_id, agent_identity, capabilities: ["search_code","read_code","read_file","write_diff","run_test","check_test","commit_changes","report_done"], allowed_file_paths, allowed_prefixes, lifecycle:"RUNNING", audit_context:{correlation_id} })`
   - `forgeTools = { registry: toolRegistry, context:{...context, ticket, task, task_context, allowed_file_paths, allowed_prefixes, session_id: executionId}, definitions:[searchCodeDefinition, readCodeDefinition, readFileDefinition, writeDiffDefinition, runTestDefinition, checkTestDefinition, reportDoneDefinition] }` — lưu ý comment `106-108` nói rõ run này là governed verification nên **không expose `commit_changes`**.
   - `prompt = buildCodexToolTestPrompt(request, targetPath, allowedPrefixes)` (`189-197`): *"use Forge MCP tools only; do not use built-in shell, file, patch, or search tools. Call Forge tools in this order: search_code, read_code, read_file, write_diff, run_test, check_test until terminal status, report_done ... Target test path: ..."*
   - `codexSdkGateway.execute({ agentId, correlationId, cwd: projectRoot, prompt, options:{ forgeTools }, onEvent: logCodexEvent })` — `onEvent` map `item.completed` (`mcp_tool_call|file_change|command_execution|agent_message`) và `turn.failed|error` ra `supervisor.agent_tool_event` (`118-132`).

3. **Gateway Codex** — `backend/src/modules/agent/codex-sdk-gateway.js:22-107` (`createCodexSdkGateway(...).execute`):
   - `getEnabledConfig` (`109-117`): yêu cầu profile tồn tại, `enabled`, `status==="ready"`, `gateway_url` khớp `/^https:\/\//`, trả `structuredClone(config)`.
   - `normalizeBaseUrl` (`126-130`): bắt buộc HTTPS, trim `/`, strip `/responses?`, append `/v1` nếu thiếu `/vN`.
   - Khi `options.forgeTools` tồn tại: `mcpSession = await createCodexForgeMcpSession(options.forgeTools)` (`31`), rồi dựng `codexConfig` (`38-53`):
     ```js
     { features:{ mcp_2026_07_28: true }, mcp_optional_startup_grace_ms: 10000,
       mcp_servers:{ forge:{ command: process.execPath, args:[bridgePath],
         env:{ NODEFORGE_CODEX_MCP_URL, NODEFORGE_CODEX_MCP_TOKEN, NODEFORGE_CODEX_MCP_DEFINITIONS }, enabled:true } } }
     ```
     Comment `33-37` giải thích SDK 0.154 giữ MCP sau feature gate này, nếu thiếu gate bridge vẫn start nhưng tools không expose.
   - `new CodexClass({ apiKey: credential, baseUrl: normalizeBaseUrl(profile.gateway_url), env:{...environment,...options.env}, ...(codexConfig?{config:codexConfig}:{}) })` (`57-62`). `credential` resolve qua `credentialResolver(credential_ref)` (`119-123`) — không log.
   - `codex.startThread({ model, workingDirectory, sandboxMode: workspace-write, approvalPolicy: never, modelReasoningEffort, networkAccessEnabled:false, webSearchMode:disabled, skipGitRepoCheck:false })` (`63-72`).
   - `thread.runStreamed(prompt,{signal, outputSchema})` (`73`), `for await (rawEvent of streamed.events)` + `sanitizeItems(rawEvent, credential)` (`78`) + `onEvent`, gom `items`, lấy `finalResponse` từ `agent_message`, `usage` từ `turn.completed`, return `{ agent_id, agent_name, role, correlation_id, status:"completed", text, items, usage, thread_id }` (`87-97`). `finally { clearTimeout; await mcpSession?.close() }`.
   - `sanitizeItems` (`141-146`): đệ quy thay chuỗi credential bằng `[REDACTED]` — **không redact MCP token**.

4. **HTTP session** — `backend/src/modules/agent/codex-forge-mcp-session.js:1-56`:
   - `createCodexForgeMcpSession({ registry, context, definitions })`: `token = randomBytes(24).toString("hex")`, `tools = definitions.filter(registry[name].execute).map({name,description,inputSchema})`.
   - `createServer` listen `127.0.0.1:0`, chỉ `POST /mcp`, check `authorization === Bearer ${token}` (401 nếu sai), `handleMessage`: `initialize -> {protocolVersion:"2024-11-05", capabilities:{tools:{listChanged:false}}, serverInfo}`, `notifications/initialized->{ }`, `tools/list->{tools}`, `tools/call -> registry[name].execute(args, context) -> {content:[{type:"text", text: JSON.stringify(result)}]}` hoặc `{isError:true, content:[{type:"text", text: JSON.stringify({error_code,message})}]}`. Return `{url, token, tools, close}`.

5. **Bridge subprocess** — `backend/scripts/codex-forge-mcp-bridge.mjs:1-22`:
   - Đọc `NODEFORGE_CODEX_MCP_URL/TOKEN/DEFINITIONS` từ env, `new Server({name:"nodeforge"}, {capabilities:{tools:{}}})`, `ListToolsRequestSchema -> {tools: definitions}`, `CallToolRequestSchema -> fetch(endpoint,{method:"POST", headers:{authorization: Bearer, content-type:json}, body:{jsonrpc:"2.0", method:"tools/call", params:{name,arguments}}}) -> body.result ?? {content:[{type:"text",text:"{}"}]}`. Tự trả `initialize` handshake, chỉ proxy `tools/list`+`tools/call`.

6. **Registry & governance** — `backend/src/tools/index.js:1-123`:
   - Freeze definitions `search_code, read_code, read_file, write_diff, run_test, check_test, commit_changes, report_done (+ readTranscriptBlocks, selectCodeGraphCandidates)`.
   - `createForgeToolRegistry({ protocolStorage, fileService, maxChars, codeSearch, relevantTreeSelector, enableReadCode=false, testService, gitService, reportService, governance, projectLogger })`: `read_code` chỉ register khi `enableReadCode===true`; các tool khác có guard tương tự; mỗi `execute` chạy `withDefaultBudget(context) -> authorizeTool(name, scoped) -> dispatch(name,tool,input,scoped)` qua `governance.dispatch` nếu có, và emit `forge.tool_started|success|failed`.

7. **Tests hiện có** — `backend/tests/unit/codex-sdk-gateway.test.js:1-67`: chỉ 3 test — normalize URL, run ticket với `workspace-write/never`, và bật MCP feature gate. Chưa cover session/bridge/filtering.

So với đường Claude (`claude-sdk-gateway.js`): Claude hard-block built-ins bằng `tools:[], allowedTools:[mcp__forge__*], createSdkMcpServer(Zod)` in-process — Codex **không có** hard block tương đương.

---

## 4) Trả lời câu hỏi "có dùng đúng Forge tools không?"

- **Có đúng ở mức wiring**: Codex gateway đã đi đúng registry Forge + governance context + schemas đã freeze (`nodeforge-task-integration.js:102-109`, `codex-forge-mcp-session.js:28-37`, `tools/index.js:39-92`). `authorizeTool` + `governance.dispatch` vẫn chạy cho mỗi `tools/call`.
- **Chưa đủ đúng ở mức enforcement**:
  - Chỉ có **prompt** cấm built-ins (`189-192`), không có chặn cứng. Với `sandboxMode: "workspace-write"` + `approvalPolicy: "never"` (`codex-sdk-gateway.js:66-67`), model vẫn có thể gọi shell/file/patch/search native và ghi file vượt governance/checksum — bypass `allowed_file_paths/prefixes` và `write_diff` checksum guard.
  - Prompt bắt gọi `read_code` nhưng registry chỉ có `read_code` khi `enableReadCode===true` (`tools/index.js: read_code guard`). Nếu runtime không bật flag này, tool sẽ 404 dù prompt yêu cầu.
  - `capabilities` vẫn liệt kê `commit_changes` (`nodeforge-task-integration.js:102`) nhưng `definitions` đã loại `commit_changes` — đúng cho tool-lab nhưng gây lệch contract nếu ai đọc capabilities để suy ra tools được phép.

Vì vậy: **path MCP đúng, nhưng thiếu lớp chặn cứng** như Claude. Đây là gap cần reconcile trước khi chạy ticket thật.

---

## 5) Cần reconcile (không code trong báo cáo này)

1. **Thiếu hard block built-ins cho Codex** — `codex-sdk-gateway.js:63-72` để `sandboxMode: "workspace-write"` cho cả run verification. Cần tách: run governed verification dùng `sandboxMode: "read-only"` (hoặc config allow/deny tools của Codex nếu SDK expose), chỉ run materialize mới `workspace-write`. Đồng thời bổ sung allowlist tương đương `allowedTools` phía Codex — hiện SDK chưa có field `allowedTools` như Claude, phải làm bằng `mcp_servers` allowlist + sandbox/approval.
   - *Why*: prompt không đủ; model có thể bypass Forge governance.
   - *How to apply*: khi chuyển sang code, thêm option `sandboxMode` per-run type và document mapping với SDK types.

2. **`read_code` definition vs registry divergence** — `nodeforge-task-integration.js:108` luôn đưa `readCodeDefinition` vào `definitions`, còn `tools/index.js` chỉ register `read_code` khi `enableReadCode`. Bridge sẽ filter bằng `registry[name].execute` (`codex-forge-mcp-session.js:6`) nên tool sẽ biến mất khỏi `tools/list` — prompt sẽ fail.
   - *Fix*: hoặc luôn enable `read_code` cho Codex lab, hoặc đổi prompt/order khi flag off.

3. **`commit_changes` lệch capabilities/definitions** — `nodeforge-task-integration.js:102` giữ `commit_changes` trong capabilities nhưng comment `104-108` nói không expose. Nên đồng bộ: bỏ khỏi capabilities cho lab run, hoặc giữ và đưa vào definitions khi là run thật.

4. **MCP token lộ trên argv/env của process con** — `codex-sdk-gateway.js:45-49` đặt `NODEFORGE_CODEX_MCP_TOKEN` và `NODEFORGE_CODEX_MCP_DEFINITIONS` (JSON lớn) vào `mcp_servers.forge.env`, sẽ hiện trên `ps` / process listing và log. `sanitizeItems` (`141-146`) chỉ redact `credential`, không redact token.
   - *Fix*: redact token trong logs/events, cân nhắc truyền definitions qua file descriptor hoặc shorten, và không log `codexConfig`.

5. **`protocolVersion` cố định `2024-11-05`** — `codex-forge-mcp-session.js:25`. MCP SDK hiện tại `^1.30.0` có thể đã bump protocol; nên đọc từ SDK hoặc để bridge tự negotiate.

6. **Binary `codex` chưa cài — BLOCKING** — `backend/package.json:25` chỉ có `@openai/codex-sdk 0.154.0`, không có `@openai/codex`. Kiểm tra `node_modules/@openai/` chỉ có `agents` + `codex-sdk`, không có `codex`; `findCodexPath` trong `dist/index.js:390-470` dùng `moduleRequire.resolve("@openai/codex/package.json")` để tìm `vendor/<triple>/bin/codex` — sẽ throw `Unable to locate Codex CLI binaries...` ngay khi `new Codex()` lần đầu. Phải `npm i @openai/codex@<version khớp SDK 0.154>` (hoặc version được SDK 0.154 pin) mới chạy được. Không workaround bằng `codexPathOverride` trừ khi tự build binary.

7. **Thiếu tests cho session/bridge/filtering** — `codex-sdk-gateway.test.js` chưa test `createCodexForgeMcpSession`, `codex-forge-mcp-bridge.mjs`, filtering `definitions` theo registry, và `submitTicket` handoff-vs-execution separation (§5 của plan).

8. **`supervisor-loop.js:36` ReferenceError tiềm ẩn** — `onEvent` tham chiếu `initial` (local của `start()`) khi `roundController` trả `{request}` — chưa được suite cover.

9. **Handoff tự chạy SDK trong cùng call** — `nodeforge-task-integration.js:30-41` vừa `enqueue` vừa `runCodexTask` ngay. Plan §5 muốn `sender.handoff` chỉ receive, SDK execution explicit riêng. Giữ nguyên hiện tại thì smoke test sẽ tự chạy task ngoài ý muốn khi enqueue.

---

## 6) Bằng chứng binary thiếu (mới verify)

```
ls node_modules/@openai/              -> agents, codex-sdk   (không có codex)
ls node_modules/@openai/codex/        -> No such file or directory
grep package.json                     -> "@openai/codex-sdk": "0.154.0"  (không có @openai/codex)
ls node_modules/@openai/codex/vendor/*/bin/ -> No such file or directory
```

`dist/index.js: findCodexPath / resolveNativePackage` yêu cầu file `vendor/<triple>/bin/codex` + `codex-package.json` + `codex-path`. Không có thì mọi `gateway.execute` sẽ throw trước khi tới MCP.

---

## 7) Kết luận & đề xuất thứ tự khi cho phép code

1. Cài `@openai/codex` đúng version tương thích 0.154 (verify `codex --version` + `findCodexPath` resolve thành công).
2. Thêm hard block built-ins cho Codex (sandbox per-run type + allowlist).
3. Đồng bộ `read_code`/`commit_changes` giữa prompt, capabilities và registry.
4. Redact MCP token + tránh lộ definitions JSON trên argv.
5. Bổ sung tests session/bridge/filtering + tách handoff receive-only vs explicit SDK execution.
6. Smoke thủ công qua Control API theo plan §8 (restart, ticket không truyền concrete `agent_id`, check log không lộ secret, 1 tool Zod được validate, không trigger materializer/verification/repair).

---

## 8) Trích dẫn file:dòng chính

- SDK wrapper & JSONL: `backend/node_modules/@openai/codex-sdk/dist/index.js: CodexExec.run / Thread.runStreamedInternal / serializeConfigOverrides`
- SDK types: `backend/node_modules/@openai/codex-sdk/dist/index.d.ts:1-286`
- SDK README: `backend/node_modules/@openai/codex-sdk/README.md:15-40`
- Codex gateway: `backend/src/modules/agent/codex-sdk-gateway.js:22-146` (đặc biệt `31-53` MCP gate, `57-72` startThread, `141-146` sanitize)
- HTTP session: `backend/src/modules/agent/codex-forge-mcp-session.js:1-56`
- Bridge: `backend/scripts/codex-forge-mcp-bridge.mjs:1-22`
- Task integration: `backend/src/modules/supervisor/nodeforge-task-integration.js:11-197` (đặc biệt `94-136` runCodexTask, `189-197` prompt)
- Tool registry: `backend/src/tools/index.js:1-123`
- Tests: `backend/tests/unit/codex-sdk-gateway.test.js:1-67`
- Schemas: `schemas/agent/tools/write-diff.schema.json`, `search-code.schema.json`, `run-test.schema.json`

Báo cáo kết thúc. Khi bạn nói **"code đi!"** mới bắt đầu sửa file theo thứ tự §7.
