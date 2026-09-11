# Forge Architecture — Extra Clarifications & Decisions (Sprint 5+)

> Bổ sung chi tiết cho `ARCHITECTURE.md` v1.3 — các quyết định sau mục 66.8 cần triển khai ở Sprint 6–8.

---

## Owner Decision Gate — Routing & Veto Mechanism

### Problem Statement

Architecture Manager cần xin phép Project Owner khi:
- Scope change (WF-008)
- Architecture violation
- Dependency change
- Resource conflict
- Deadline slip

**Constraint:** mọi quyết định phải routing qua Node (không chat trực tiếp) để:
1. Node giữ visibility (observe & orchestrate)
2. Decision memory ghi nhận hệ thống
3. Workflow gate có record cấu trúc (schema-driven)

### Solution: Decision Gate Flow

```
Architecture Manager (phát hiện issue)
    ↓
Node receive Command: OWNER_DECISION_REQUIRED
    ├─ validate + store decision_id
    ├─ emit Event: "decision.required"
    ↓
Node → UI (Sprint 8)
    ├─ render modal
    ├─ display question + options + rationale
    ↓
Project Owner (human)
    ├─ review + click 1 option
    ↓
Node receive UI choice
    ├─ validate + create Event: OWNER_DECISION_PROVIDED
    ├─ store in runtime/state.json + Event Store
    ↓
Architecture Manager receive Event
    ├─ continue workflow (PROCEED / ROLLBACK / DEFER)
    └─ [có thể] emit veto Command sau
```

### Decisions Finalized

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Timeout behavior | ⏸️ PAUSE indefinite | Không auto-action; chờ Owner manual |
| 2 | Multiple choice | 1️⃣ Single choice | Owner chọn đúng 1 option |
| 3 | Veto after approve | ✅ YES, AM can veto | Nếu phát hiện issue mới, AM có thể reject |
| 4 | Notification channel | 🎨 UI modal + notice | Modal trên giao diện, notice toast/banner; không Email/Slack |
| 5 | Audit storage | 📋 Event Store riêng | `events/` trong `.forge/runtime/`; KHÔNG append commit message |

### Triggers for OWNER_DECISION_REQUIRED

| Trigger | Rule | Example |
|---------|------|---------|
| Scope Change | WF-008 | Commit auth.js only, diff has adapters/woocommerce.js |
| Architecture Violation | Mục 19 Rules | Modify public API outside Commit scope |
| Dependency Change | Verification Policy | Add dependency outside allowlist |
| Resource Conflict | Concurrent modification (mục 45) | Builder A & B want same file |
| Deadline Slip | Timeline policy | Sprint end > deadline |

### State Machine: OWNER_GATE

```
BUILDING
    ↓
(Verification PASSED)
    ↓
Architecture Manager detects: "cần Owner quyết định"
    ↓
Node: emit OWNER_DECISION_REQUIRED
    ↓
    ╔════════════════════════════╗
    ║   OWNER_GATE (PAUSED)      ║  ← Workflow blocks here
    ║   indefinite wait          ║
    ╚════════════════════════════╝
    ↓
[Owner quyết định sau]
    ↓
Event: OWNER_DECISION_PROVIDED (choice = approve/reject/defer)
    ├─ choice == "approve"
    │   ├─ Node update runtime/state
    │   ├─ Architecture Manager continue
    │   └─→ REVIEWING (Reviewer)
    │       ├─ Reviewer: nếu approve → APPROVED
    │       └─ [AFTER] Architecture Manager: có thể veto (WF-006 gate)
    │
    ├─ choice == "reject"
    │   └─→ BUILDING (Builder làm lại)
    │
    └─ choice == "defer"
        └─→ DEFERRED (move to next sprint)
```

### Schema: Command & Event

**Command (`OWNER_DECISION_REQUIRED`):**
```json
{
  "command_id": "cmd-req-12345",
  "type": "OWNER_DECISION_REQUIRED",
  "decision_id": "dec-scope-auth-2026-08-18",
  "question": "Được phép mở rộng scope sang WooCommerce adapter?",
  "options": [
    {
      "id": "approve",
      "label": "Approve",
      "description": "Proceed with extended scope"
    },
    {
      "id": "reject",
      "label": "Reject",
      "description": "Keep original scope only"
    },
    {
      "id": "defer",
      "label": "Defer to next sprint",
      "description": "Schedule for later"
    }
  ],
  "rationale": "Commit NF-099: auth middleware update impacts adapter layer",
  "context": {
    "commit_id": "NF-099",
    "task_id": "TASK-456",
    "affected_files": ["src/auth.js", "adapters/woocommerce.js"],
    "rule_violated": "WF-008"
  },
  "deadline_ms": 3600000,
  "timestamp": "2026-08-18T14:00:00Z"
}
```

**Event (`OWNER_DECISION_PROVIDED`):**
```json
{
  "event_id": "evt-decision-67890",
  "type": "decision.owner_provided",
  "decision_id": "dec-scope-auth-2026-08-18",
  "commit_id": "NF-099",
  "task_id": "TASK-456",
  "owner_name": "Tiến La Văn",
  "choice": "approve",
  "rationale_optional": "Auth changes are critical, scope expansion justified",
  "timestamp": "2026-08-18T14:30:00Z"
}
```

**Event (Architecture Manager Veto):**
```json
{
  "event_id": "evt-veto-89012",
  "type": "decision.architecture_veto",
  "decision_id": "dec-scope-auth-2026-08-18",
  "commit_id": "NF-099",
  "task_id": "TASK-456",
  "reason": "Security issue discovered in new dependency compatibility",
  "next_action": "ROLLBACK_TO_BUILDING",
  "timestamp": "2026-08-18T14:45:00Z"
}
```

### Event Store Record (`.forge/runtime/events/`)

```json
{
  "event_id": "evt-decision-67890",
  "type": "decision.owner_provided",
  "decision_id": "dec-scope-auth-2026-08-18",
  "commit_id": "NF-099",
  "task_id": "TASK-456",
  "owner_name": "Tiến La Văn",
  "choice": "approve",
  "rationale": "Auth changes are critical, scope expansion justified",
  "timestamp": "2026-08-18T14:30:00Z",
  "veto_history": [
    {
      "event_id": "evt-veto-89012",
      "vetoed_at": "2026-08-18T14:45:00Z",
      "reason": "Security issue discovered",
      "next_action": "ROLLBACK_TO_BUILDING"
    }
  ]
}
```

**Note:** Decision log lưu riêng, KHÔNG append vào commit message. Commit message chỉ chứa code change.

---

## Permission Matrix: Who Decides What

| Decision Type | Owner | Architecture Manager | Sprint Lead | Rule |
|---------------|-------|----------------------|-------------|------|
| Scope change | ✅ YES | ❌ no | 🟡 recommend | WF-008 |
| Architecture violation | ✅ YES | 🟡 report | ❌ no | WF-008 |
| Tech debt trade-off | ✅ YES | 🟡 analyze | ❌ no | Custom |
| Priority reorder | ✅ YES | ❌ no | 🟡 suggest | Custom |
| Deadline extension | ✅ YES | ❌ no | 🟡 request | Custom |
| Commit rejection (quality) | ❌ no | ✅ YES | 🟡 veto | WF-006 |
| Builder resource allocation | ✅ YES | ❌ no | 🟡 manage | Custom |
| Implementation detail approval | ❌ no | ✅ YES | ❌ no | WF-003 |

---

## Sprint 6 (Workflow Engine) Todo Checklist

- [ ] Define **OWNER_GATE** state (blocking, pause indefinite)
- [ ] Add `OWNER_DECISION_REQUIRED` command to Agent Protocol vocabulary (mục 40, beyond current 12 verbs)
- [ ] Add `decision.owner_provided` + `decision.architecture_veto` to Event schema (mục 40)
- [ ] Node stores `decision_id` in Task record + `runtime/state.json`
- [ ] Architecture Manager can emit `OWNER_DECISION_REQUIRED` command
- [ ] Node routes command → UI (Sprint 8 handles rendering)
- [ ] Architecture Manager receives `decision.owner_provided` event
- [ ] Architecture Manager can emit `decision.architecture_veto` command (new veto mechanism)
- [ ] Node stores all decision events in `.forge/runtime/events/`
- [ ] Workflow transition: OWNER_GATE → (based on choice) → REVIEWING / BUILDING / DEFERRED

---

## Sprint 7 (History) Integration

- [ ] Query API: "danh sách tất cả decision của Commit X"
- [ ] Query API: "danh sách veto của Architecture Manager trong Sprint Y"
- [ ] Audit view: timeline của decision_id → timeline của veto (nếu có)
- [ ] Report: "bao nhiêu commits yêu cầu Owner quyết định" vs "approved" vs "deferred"

---

## Sprint 8 (Transport/UI) Integration

- [ ] UI Modal component: display `OWNER_DECISION_REQUIRED` command
- [ ] UI Notice: toast/banner khi có decision gate
- [ ] UI Form: radio button / dropdown để Owner chọn 1 option
- [ ] UI Form: optional textarea cho Owner rationale
- [ ] Submit decision → Node via Event (Agent Protocol)
- [ ] UI: show decision history + any veto event

---

## Related Files & Sections

| Reference | Location | Purpose |
|-----------|----------|---------|
| OWNER_GATE state | This doc | Blocking state pending Owner decision |
| OWNER_DECISION_REQUIRED | This doc | New command type |
| decision.owner_provided | This doc | New event type |
| decision.architecture_veto | This doc | Architecture Manager veto |
| WF-008 rule | ARCHITECTURE.md mục 66.5 | Scope change rule |
| WF-006 rule | ARCHITECTURE.md mục 66.5 | Approval rule |
| Agent Protocol | ARCHITECTURE.md mục 40 | Define new command/event |
| Concurrent Modification | ARCHITECTURE.md mục 45 | Resource conflict detection |
| Verification Policy | ARCHITECTURE.md mục 62.6 | Decision trigger |

---

## Key Principles Reinforced

1. **No direct Agent↔Agent communication** — Architecture Manager ↔ Node ↔ Owner (UI is transport)
2. **Pause indefinite, not timeout** — Owner drives decision, no auto-action
3. **Single choice, not approval list** — Owner picks 1 option
4. **Veto is allowed** — Architecture Manager can reject after Owner approve (2nd gate)
5. **UI modal only** — No Slack/Email for decision gates (separate integration layer)
6. **Event Store is audit** — Decision log is workflow metadata, not code artifact

---

**Last Updated:** 2026-08-18  
**Scope:** Sprint 6–8 implementation  
**Related to:** ARCHITECTURE.md v1.3, mục 62–66
