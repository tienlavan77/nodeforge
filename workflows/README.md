<!-- Architecture Manager workspace for project workflow definitions. -->
# Workflows

Architecture Manager may read, create, update, and delete workflow files here through Forge File Service tools.

## Role rulebooks

Each agent reads **only its assigned role file**; every file includes the operational safeguards needed by that role.

| Role | Rulebook |
| --- | --- |
| Coder | `workflows/agents/coder.md` |
| Reviewer | `workflows/agents/reviewer.md` |
| Sprint leader | `workflows/agents/sprint-leader.md` |
| Architecture manager | `workflows/agents/architecture-manager.md` |
| Supervisor | `workflows/agents/supervisor.md` |

Repository-level and task instructions still apply when they are supplied to the agent. These workflow files are role policies; they do not themselves change the runtime context loader.
