<!-- Describes compatible-provider role tools and governed ticket execution so
operators can enable Ollama/OpenAI without bypassing source or review authority. -->
# Compatible-provider agent tools

Tool authority follows the agent role and execution context, independently of
the model provider. A model must support function calling to use the tools.

| Context | Role | Forge tools |
| --- | --- | --- |
| Owner conversation | AM | 10: five discovery readers, Git status/diff, documentation write/edit/delete |
| Owner conversation | SL or Coder | 5: search_tree, list_files, search_text, read_file, read_lines |
| Owner conversation | Reviewer | 7: five discovery readers plus Git status/diff |
| Owner conversation | Linguist | 2: read_file, read_lines |
| Blocker investigation | AM or SL | 7: five discovery readers plus scoped Git status/diff |
| Ticket execution | Coder | 15 canonical tools, including scoped edits, run_check and governed completion |

Unavailable services may lock or omit tools. AM documentation writes remain
subject to role and path checks; SL does not acquire Coder mutation authority.
Owner conversations and ticket executions are separate permission contexts.

Codex, Claude and Anthropic retain their existing transports. Ollama uses the
Ollama adapter into OpenAI-compatible function calling; OpenAI, xAI, Alibaba,
Zhipu and DeepSeek use the configured OpenAI-compatible gateway. These providers
are now admitted to governed Coder execution. Unknown providers still fail with
ENGINEERING_PROVIDER_UNSUPPORTED. No agent profile is silently switched.

Compatible Coder tools use the existing execution binding, immutable write scope,
role guards, checkpoint journal and completion validation. Real tool calls create
completion events; a greeting or prose completion does not finish the ticket.
Commit, push, verification and independent review retain their own service gates.
No native shell or arbitrary provisioning tool is supplied to this Coder flow.

Successful phase yields retain SDK input history in memory. After a process
restart, an explicit Resume reconstructs the assignment from durable checkpoints
and recorded tool progress; raw provider history is not stored in checkpoints.
Provider errors and Stop preserve the failure path rather than replaying the run.

For real filesystem fixtures the ticket Coder requests:

```json
{"type":"test","command":"node --test backend/tests/integration/project-filesystem-environment.test.js","environment":"filesystem_namespace"}
```

The existing Node runner owns provisioning and returns verification receipts.
Host prerequisites still apply. Reload the Control API through its normal
lifecycle before expecting a running process to expose the new routing.
This code change does not resume tickets or resolve review findings.
