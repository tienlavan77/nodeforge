<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
      "items": {
        "type": "object",
        "required": ["type", "reference", "relevance"],
        "properties": {
          "type": {
            "enum": ["source", "symbol", "diff", "architecture", "rule", "memory", "decision", "verification", "review"]
          },
          "reference": {"type": "string"},
          "summary": {"type": "string"},
          "relevance": {"type": "number", "minimum": 0, "maximum": 1},
          "fingerprint": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "max_items": {"type": "integer", "minimum": 1},
        "max_tokens": {"type": "integer", "minimum": 1}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## 9.9 execution-event.schema.json

Event stream for Node/UI/audit.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/execution-event.schema.json",
  "type": "object",
  "required": ["event_id", "event_type", "timestamp"],
  "properties": {
    "event_id": {"type": "string"},
    "event_type": {
      "enum": [
        "task_created", "task_ready", "task_dispatched",
        "agent_started", "agent_output", "agent_completed",
        "file_changed", "index_updated",
        "verification_started", "verification_completed",
        "review_started", "review_completed",
        "decision_created", "state_changed",
        "blocked", "escalated", "task_completed"
      ]
    },
    "timestamp": {"type": "string", "format": "date-time"},
    "task_id": {"type": "string"},
    "agent_role": {"enum": ["builder", "reviewer", "decision", "node"]},
    "payload_ref": {"type": "string"},
    "summary": {"type": "string"}
  },
  "additionalProperties": false
}
```

------------------------------------------------------------------------

# 10. End-to-End Example

``` text
Roadmap / Sprint Plan
        ↓
Node builds Execution Graph
        ↓
Node determines eligible task
        ↓
Node resolves architecture + rules + code + memory
        ↓
Node creates Agent Task Package
        ↓
Builder
        ↓
Filesystem changes
        ↓
Node detects + indexes changes
        ↓
Node runs focused verification
        ├── FAIL → normalized failure → Builder
        ↓ PASS
Node creates Review Package
        ↓
Reviewer
        ├── REQUEST_CHANGES → Builder
        ↓ APPROVED
Node updates execution state
        ↓
Node resolves next eligible task
        ↓
repeat
```

------------------------------------------------------------------------

# 11. Migration Rule

The previous workflow should **not** be patched into the new
architecture.

Replace this:

``` text
Agent reads roadmap
Agent reads status
Agent decides next step
Agent writes status
Agent runs tests
Agent interprets raw output
```

with this:

``` text
Node reads plan
Node builds execution graph
Node owns runtime state
Node builds context
Node dispatches bounded task
Node observes filesystem
Node verifies
Node normalizes evidence
Node collects review
Node decides next action
```

Existing roadmap, sprint, history, and other artifacts may remain as
persistent records, but they are no longer the direct control interface
for Agents.

------------------------------------------------------------------------

# 12. Final Principle

> **Forge is a deterministic project orchestration system with an AI
> reasoning layer --- not an AI agent that happens to orchestrate a
> project.**

The architecture should therefore evolve toward:

``` text
                 FORGE NODE
                     |
          deterministic foundation
                     |
       +-------------+-------------+
       |             |             |
     State         Graph         Index
       |             |             |
    Verify         Rules        Memory
       |             |             |
       +-------------+-------------+
                     |
              Intelligent Layer
                     |
                Decision AI
                     |
          +----------+----------+
          |                     |
       Builder               Reviewer
```

This preserves agent specialization while making Node the control plane,
context firewall, verification engine, and future intelligent
orchestrator.
