# FORGE-STREAM-001a - Unified event envelope

`schemas/stream/unified-event.schema.json` defines the task-scoped stream contract. Every event has `event_type`, `task_id`, ISO-8601 `timestamp`, and a type-specific `payload`. The union currently accepts five event types:

- `node.status_change`: `payload.from` and `payload.to` describe ticket/node state transitions.
- `node.execution_step`: `payload.result` is the existing `execution-result.schema.json` object from Execution Layer trace data.
- `node.command`: announces a shell check with `command_id`, command text, and optional phase (`runLint`, `runTests`, or `runBuildCheck`).
- `node.command_result`: reports the matching `command_id`, success, optional execution result, exit code, and output.
- `agent.text_stream`: forwards a text chunk with optional message/conversation/agent correlation and sequence metadata.

Five validating examples live in `schemas/examples/stream-*.json`. This ticket only defines and validates the contract; no runtime event emitters are wired yet.
