<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
        "root": {"type": "string"},
        "write_allowed": {"type": "boolean"},
        "allowed_paths": {"type": "array", "items": {"type": "string"}}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## 9.3 agent-result.schema.json

Common Agent result envelope.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/agent-result.schema.json",
  "type": "object",
  "required": ["task_id", "agent_role", "result", "summary"],
  "properties": {
    "task_id": {"type": "string"},
    "agent_role": {"enum": ["builder", "reviewer", "decision"]},
    "result": {
      "enum": ["completed", "failed", "blocked", "needs_changes", "approved", "rejected", "escalate"]
    },
    "summary": {"type": "string"},
    "changed_files": {"type": "array", "items": {"type": "string"}},
    "risks": {"type": "array", "items": {"type": "string"}},
    "questions": {"type": "array", "items": {"type": "string"}},
    "evidence": {"type": "array", "items": {"type": "string"}}
  },
  "additionalProperties": false
}
```

## 9.4 execution-state.schema.json

Authoritative Node runtime state.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/execution-state.schema.json",
  "type": "object",
  "required": ["project_id", "state", "updated_at"],
  "properties": {
    "project_id": {"type": "string"},
    "sprint_id": {"type": "string"},
    "task_id": {"type": "string"},
    "state": {
      "enum": [
        "idle", "planned", "ready", "dispatched", "running", "handoff",
        "verifying", "reviewing", "approved", "blocked", "failed",
        "escalated", "cancelled", "completed"
      ]
    },
    "active_agent": {"enum": ["builder", "reviewer", "decision", "none"]},
    "attempt": {"type": "integer", "minimum": 0},
    "updated_at": {"type": "string", "format": "date-time"},
    "reason": {"type": "string"}
  },
  "additionalProperties": false
}
```

## 9.5 decision.schema.json

Node/Decision Agent decision contract.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/decision.schema.json",
  "type": "object",
  "required": ["decision_id", "action", "basis", "confidence"],
  "properties": {
    "decision_id": {"type": "string"},
    "action": {
      "enum": ["continue", "dispatch", "retry", "verify", "review", "request_changes", "block", "escalate", "skip", "complete"]
    },
    "basis": {"type": "array", "items": {"type": "string"}},
    "evidence": {"type": "array", "items": {"type": "string"}},
    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "assumptions": {"type": "array", "items": {"type": "string"}},
    "requires_human": {"type": "boolean"}
  },
  "additionalProperties": false
}
```

## 9.6 verification-result.schema.json

Normalized deterministic verification result.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/verification-result.schema.json",
  "type": "object",
  "required": ["task_id", "status", "checks"],
  "properties": {
    "task_id": {"type": "string"},
    "status": {"enum": ["passed", "failed", "skipped", "blocked"]},
    "level": {"enum": ["focused", "related", "full"]},
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "status"],
        "properties": {
          "name": {"type": "string"},
          "status": {"enum": ["passed", "failed", "skipped"]},
          "duration_ms": {"type": "integer", "minimum": 0},
          "summary": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "failures": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["summary"],
        "properties": {
          "summary": {"type": "string"},
          "file": {"type": "string"},
          "line": {"type": "integer", "minimum": 1},
          "category": {"type": "string"},
          "evidence_ref": {"type": "string"}
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

## 9.7 review-result.schema.json

Reviewer verdict.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/review-result.schema.json",
  "type": "object",
  "required": ["task_id", "verdict", "summary"],
  "properties": {
    "task_id": {"type": "string"},
    "verdict": {"enum": ["approved", "request_changes", "blocked"]},
    "summary": {"type": "string"},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "summary"],
        "properties": {
          "severity": {"enum": ["critical", "high", "medium", "low"]},
          "summary": {"type": "string"},
          "file": {"type": "string"},
          "line": {"type": "integer", "minimum": 1},
          "required_change": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "risks": {"type": "array", "items": {"type": "string"}}
  },
  "additionalProperties": false
}
```

## 9.8 context-pack.schema.json

Context selected by Node.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/context-pack.schema.json",
  "type": "object",
  "required": ["task_id", "role", "items"],
  "properties": {
    "task_id": {"type": "string"},
    "role": {"enum": ["builder", "reviewer", "decision"]},
    "items": {
      "type": "array",
