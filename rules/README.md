# Forge workflow rules for Node

`forge-sprint-delivery.rules.json` converts the immutable constraints in the Forge Constitution and the mandatory Sprint Delivery Workflow into deterministic Node checks.

Node loads the ruleset in descending `priority` order. A matching `blocking` rule rejects the requested action and persists a structured violation; `orchestrator` rules guide state handling; `advisory` rules are reported but do not stop work. `status.json` remains the authoritative record for an active Commit's lifecycle state and test evidence.

`forge-sprint-delivery.workflow.json` is the allowed state graph. Its transition `condition` values reference ruleset IDs or a Node-defined predicate. Before advancing a Commit, Node must validate the transition, actor, required artifacts, dependency approvals, allowlisted changed paths, and test evidence.

The ruleset intentionally does not turn judgment-only constitutional requirements—such as readability or explainability—into false deterministic checks. Node should send those rules to the independent Reviewer using `project/rule.schema.json` with `enforcement: "review"`.
