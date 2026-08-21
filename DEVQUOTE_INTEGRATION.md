# Devquote Gateway Integration — Summary

## Files Created/Modified

### New Files
| File | Purpose |
|------|---------|
| `src/modules/agent/provider-adapters/devquote-adapter.js` | Adapter mới — Anthropic API format + bearer auth |
| `docs/GUIDE_DEVQUOTE_GATEWAY.md` | Hướng dẫn cấu hình đầy đủ |
| `schemas/examples/agent-profile-devquote-builder.json` | Mẫu profile Builder |
| `schemas/examples/agent-profile-devquote-reviewer.json` | Mẫu profile Reviewer |
| `scripts/test-devquote-adapter.js` | Test script để verify adapter |

### Modified Files
| File | Change |
|------|--------|
| `src/modules/agent/provider-adapters/index.js` | Register `devquote` provider |
| `src/modules/agent/node-agent-configuration.js` | Add `"devquote"` to allowed providers list |

---

## Quick Start

### 1. Set environment variable
```bash
export DEVQUOTE_API_KEY=sk-xxxx-xxxx-xxxx-xxxx-xxxx
```

### 2. Create agent profile (SQLite)
```sql
INSERT INTO agent_profiles (agent_id, profile_json) VALUES (
  'BUILDER-001',
  '{
    "agent_id": "BUILDER-001",
    "project_id": "PROJECT-114A",
    "agent_name": "Forge Builder",
    "role": "builder",
    "provider": "devquote",
    "model": "claude-haiku-4-5",
    "gateway_url": "https://sv.devquote.shop",
    "credential_ref": "DEVQUOTE_API_KEY",
    "enabled": true
  }'
);
```

### 3. Test connection
```bash
cd /path/to/nodeforge
DEVQUOTE_API_KEY=sk-xxxx node scripts/test-devquote-adapter.js
```

Expected output:
```
🧪 Testing Devquote Gateway Adapter
   Gateway: https://sv.devquote.shop
   Model: claude-haiku-4-5
   Auth: Bearer token

📝 Test 1: Request (non-streaming)
   ✅ Status: completed
   ✅ Response ID: msg_01ABC...
   ✅ Response text: "Hello from NodeForge Builder!"

📡 Test 2: Stream (real-time)
   Forge Builder is an AI-powered coding assistant...
   ✅ Stream complete
   📄 Full response: "Forge Builder is an AI-powered coding assistant..."

✅ Tests complete!
```

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────┐
│                    NodeForge Builder                     │
├─────────────────────────────────────────────────────────┤
│  Task: "Fix session timeout bug"                        │
│  ↓                                                       │
│  Context Engine (filters secrets, enforces budget)      │
│  ↓                                                       │
│  Agent Gateway → devquote-adapter.js                    │
│  ↓                                                       │
│  HTTP POST https://sv.devquote.shop                     │
│  Headers:                                               │
│    - Authorization: Bearer <API_KEY>                    │
│    - content-type: application/json                     │
│  Body:                                                  │
│    {                                                     │
│      "model": "claude-haiku-4-5",                       │
│      "max_tokens": 8192,                                │
│      "messages": [{"role": "user", "content": "..."}]   │
│    }                                                     │
│  ↓                                                       │
│  Anthropic Messages API Response                        │
│  ↓                                                       │
│  Stream events:                                         │
│    - content_block_delta (text chunks)                  │
│    - message_stop (completion)                          │
│  ↓                                                       │
│  Builder receives text, writes code to filesystem       │
│  ↓                                                       │
│  Node Watcher detects changes → Code Index update       │
│  ↓                                                       │
│  Test Runner → Reviewer → Approve/Changes               │
└─────────────────────────────────────────────────────────┘
```

---

## Configuration Reference

### Agent Profile Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agent_id` | string | ✅ | - | Unique ID (VD: `BUILDER-001`) |
| `agent_name` | string | ✅ | - | Display name |
| `role` | string | ✅ | - | `builder` or `reviewer` |
| `provider` | string | ✅ | - | **`devquote`** |
| `model` | string | ❌ | `claude-haiku-4-5` | Model ID |
| `gateway_url` | string | ✅ | - | `https://sv.devquote.shop` |
| `credential_ref` | string | ✅ | - | Credential reference |
| `enabled` | boolean | ✅ | - | `true` to enable |

### Available Models

| Model | Context | Use Case |
|-------|---------|----------|
| `claude-haiku-4-5` | 200K | Builder (fast, cheap) |
| `claude-sonnet-4-6` | 200K | Reviewer (balanced) |
| `claude-opus-4-7` | 200K | Architecture decisions |
| `claude-opus-5` | 200K | Complex reasoning |
| `claude-opus-4-8[1m]` | 1M | Large codebase analysis |

---

## Security Checklist

Before using in production:

- [ ] **Secrets redaction** implemented (context engine filters `.env`, `*.key`, `*.pem`)
- [ ] **Token budget enforcement** active (builder: 40k, reviewer: 30k)
- [ ] **Event store persistent** (SQLite, not in-memory)
- [ ] **History archive persistent** (survives Node restart)
- [ ] **DLQ drain mechanism** implemented
- [ ] **Optimistic concurrency** on workflow transitions
- [ ] **Test runner timeout** configured
- [ ] **Idempotency cache** race condition fixed

Xem: [CODE_REVIEW_REPORT.md](CODE_REVIEW_REPORT.md), [governance-sprint-plan-stabilization.json](schemas/examples/governance-sprint-plan-stabilization.json)

---

## Troubleshooting

### Problem: "Devquote Gateway response is invalid"

**Solution:**
1. Check API key: `curl -X POST https://sv.devquote.shop -H "Authorization: Bearer $DEVQUOTE_API_KEY" -H "content-type: application/json" -d '{"model":"claude-haiku-4-5","max_tokens":100,"messages":[{"role":"user","content":"Say OK"}]}'`
2. Check model exists in gateway
3. Check network connectivity

### Problem: "Unknown Agent Gateway profile"

**Solution:**
1. Verify profile in `agent_profiles` table
2. Check `agent_id` matches configuration
3. Ensure `enabled = true`

### Problem: Stream not working

**Solution:**
1. Check gateway supports streaming (most do)
2. Verify `content_block_delta` event parsing
3. Check network for SSE support

---

## Next Actions

1. **Implement critical fixes** (from code review):
   - NF-STAB-T01: Secrets redaction
   - NF-STAB-T02: Event store persistence
   - NF-STAB-T03: Error isolation
   - NF-STAB-T07: Context budget enforcement

2. **Deploy to production** after stabilization sprint

3. **Monitor** for:
   - Token usage (budget enforcement)
   - Error rates (error isolation)
   - Data loss (persistence)

---

**Last updated:** 2026-08-20
**Author:** NodeForge Team
