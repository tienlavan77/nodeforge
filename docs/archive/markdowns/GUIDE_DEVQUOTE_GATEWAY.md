# Hướng dẫn cấu hình Builder dùng devquote.shop Gateway trong NodeForge

## Tổng quan

Devquote.shop là **Anthropic Messages API compatible gateway** cho phép gọi Claude models qua bearer auth. NodeForge đã có adapter mới (`devquote-adapter.js`) để tích hợp.

### Thông tin gateway
| Field | Value |
|-------|-------|
| **Base URL** | `https://sv.devquote.shop` |
| **Auth scheme** | Bearer token |
| **API format** | Anthropic Messages API |
| **Models** | `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-opus-5`, `claude-opus-4-8[1m]`, ... |

---

## Bước 1: Tạo Agent Profile

Tạo profile trong `agent_profiles` table hoặc file configuration.

### Schema (agent-profile.schema.json)

```json
{
  "id": "NF-AGENT-BUILDER-001",
  "project_id": "PROJECT-114A",
  "agent_id": "BUILDER-001",
  "agent_name": "Forge Builder",
  "role": "builder",
  "provider": "devquote",
  "model": "claude-haiku-4-5",
  "gateway_url": "https://sv.devquote.shop",
  "credential_ref": "DEVQUOTE_API_KEY",
  "enabled": true,
  "status": "configured",
  "created_at": "2026-08-20T10:00:00+07:00",
  "updated_at": "2026-08-20T10:00:00+07:00"
}
```

### Field giải thích

| Field | Required | Description |
|-------|----------|-------------|
| `agent_id` | ✅ | Unique ID cho agent (VD: `BUILDER-001`) |
| `agent_name` | ✅ | Tên hiển thị |
| `role` | ✅ | `builder` hoặc `reviewer` |
| `provider` | ✅ | **`devquote`** (adapter mới) |
| `model` | ❌ | Model để dùng (default: `claude-haiku-4-5`) |
| `gateway_url` | ✅ | `https://sv.devquote.shop` |
| `credential_ref` | ✅ | Reference đến API key (resolved bởi credentialResolver) |
| `enabled` | ✅ | `true` để bật, `false` để tắt |

---

## Bước 2: Cấu hình Credential

Credential được resolve bởi `credentialResolver` function. Hai cách phổ biến:

### Cách 1: Environment Variable (khuyến nghị)

```bash
# .env file
DEVQUOTE_API_KEY=sk-xxxx-xxxx-xxxx-xxxx-xxxx
```

```javascript
// credentialResolver function
async function resolveCredential(reference) {
  if (reference === "DEVQUOTE_API_KEY") {
    return process.env.DEVQUOTE_API_KEY;
  }
  throw new ConfigurationError(`Unknown credential: ${reference}`);
}
```

### Cách 2: Persistent Secret Backend

```javascript
// Sử dụng persistent-secret-backend.js
const secretBackend = createPersistentSecretBackend({ database });
const credentialResolver = async (reference) => {
  const secret = await secretBackend.get(reference);
  if (!secret) throw new ConfigurationError(`Secret not found: ${reference}`);
  return secret.value;
};
```

---

## Bước 3: Khởi động Builder

### Code example

```javascript
import { createAgentGateway } from "./modules/agent/agent-gateway.js";
import { createNodeAgentConfiguration } from "./modules/agent/node-agent-configuration.js";
import { createAgentProfileStore } from "./modules/agent/agent-profile-store.js";

// 1. Create profile store (SQLite)
const profileStore = createAgentProfileStore({ database });

// 2. Create agent configuration
const configPath = ".forge/runtime/agent-config.json";
const agentConfig = createNodeAgentConfiguration({
  profiles: profileStore,
  configurationPath: configPath
});

// 3. Resolve credentials
async function resolveCredential(reference) {
  return process.env.DEVQUOTE_API_KEY;
}

// 4. Create gateway
const gateway = createAgentGateway({
  configuration: agentConfig,
  credentialResolver: resolveCredential,
  timeoutMs: 30000 // 30 seconds default
});

// 5. Test connection
const testResult = await gateway.testConnection("BUILDER-001");
console.log(testResult); // { agent_id: "BUILDER-001", status: "CONNECTED", gateway_url: "https://sv.devquote.shop" }

// 6. Send request
const response = await gateway.request({
  agentId: "BUILDER-001",
  payload: { text: "Hello, write a function to calculate Fibonacci." },
  correlationId: "REQ-001"
});

console.log(response);
// {
//   agent_id: "BUILDER-001",
//   correlation_id: "REQ-001",
//   status: "completed",
//   payload: {
//     text: "function fibonacci(n) { ... }",
//     response_id: "msg_01ABC..."
//   }
// }
```

---

## Bước 4: Stream Response (Real-time)

```javascript
// Stream mode
const streamPromise = gateway.stream({
  agentId: "BUILDER-001",
  payload: { text: "Explain how async/await works in JavaScript." },
  correlationId: "REQ-002"
});

for await (const event of streamPromise) {
  if (event.text) {
    process.stdout.write(event.text); // Real-time streaming
  }
  if (event.completed) {
    console.log("\n[Stream complete]");
    break;
  }
}
```

---

## Models Available

| Model ID | Description | Recommended Use |
|----------|-------------|-----------------|
| `claude-haiku-4-5` | Fast, cheap | Builder (default), quick tasks |
| `claude-sonnet-4-6` | Balanced | Reviewer, complex tasks |
| `claude-opus-4-7` | Powerful | Architecture decisions, planning |
| `claude-opus-5` | Latest | Complex reasoning, debugging |
| `claude-opus-4-8[1m]` | 1M context | Large codebase analysis |

### Change model per agent

```json
{
  "agent_id": "REVIEWER-001",
  "role": "reviewer",
  "provider": "devquote",
  "model": "claude-sonnet-4-6",  // Reviewer dùng model mạnh hơn
  "gateway_url": "https://sv.devquote.shop",
  "credential_ref": "DEVQUOTE_API_KEY",
  "enabled": true
}
```

---

## Troubleshooting

### Error: "Devquote Gateway response is invalid"

**Check:**
1. API key có valid không? → Test với curl:
   ```bash
   curl -X POST https://sv.devquote.shop \
     -H "Authorization: Bearer $DEVQUOTE_API_KEY" \
     -H "content-type: application/json" \
     -d '{
       "model": "claude-haiku-4-5",
       "max_tokens": 100,
       "messages": [{"role": "user", "content": "Say OK"}]
     }'
   ```

2. Gateway URL có đúng không? → Must start with `https://`

3. Model có available không? → Check model list từ Claude Desktop settings

### Error: "Agent Gateway request timed out"

**Increase timeout:**
```javascript
const gateway = createAgentGateway({
  timeoutMs: 60000 // 60 seconds
});
```

### Error: "Unknown Agent Gateway profile: BUILDER-001"

**Check:**
1. Profile có được create trong `agent_profiles` table không?
2. `agent_id` có trùng với configuration file không?
3. `enabled` = `true` không?

---

## Security Notes

### ⚠️ Secrets Redaction (CRITICAL)

**Before using this adapter, ensure secrets redaction is implemented** (from code review findings):

```javascript
// context-read-handler.js
const SECRET_PATTERNS = /\.(env|key|pem|crt|pfx|keystore)$/;

function shouldRedact(path) {
  return SECRET_PATTERNS.test(path);
}

// context-engine.js
function filterSensitivePaths(paths) {
  return paths.filter(path => !shouldRedact(path));
}
```

**Why:** Context engine gửi file contents cho LLM. Nếu không redact, `.env` files, API keys, private keys sẽ bị leak.

---

## Testing Checklist

- [ ] Profile được create trong `agent_profiles` table
- [ ] `credential_ref` resolve được API key
- [ ] `gateway_url` = `https://sv.devquote.shop`
- [ ] `provider` = `devquote`
- [ ] `testConnection()` trả về `status: "CONNECTED"`
- [ ] `request()` trả về response có `text` field
- [ ] `stream()` stream text real-time
- [ ] Secrets redaction active (context engine filter paths)
- [ ] Token budget enforcement active (context engine enforce limits)

---

## Next Steps

1. **Implement secrets redaction** (NF-STAB-T01) — CRITICAL
2. **Enforce context budget** (NF-STAB-T07) — CRITICAL
3. **Add test runner timeout** (NF-STAB-T09) — HIGH
4. **Fix event store persistence** (NF-STAB-T02) — CRITICAL

Xem chi tiết: [CODE_REVIEW_REPORT.md](CODE_REVIEW_REPORT.md), [governance-sprint-plan-stabilization.json](schemas/examples/governance-sprint-plan-stabilization.json)
