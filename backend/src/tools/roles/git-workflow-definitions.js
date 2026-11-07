// Business purpose: Defines the MCP/SDK input schemas for governed Git workflow tools (`git_branch`, `git_restore`, `git_stash`) so agents can inspect and manage branches, restore files, and stash changes safely through Node Git Service.
// Technical description: Exports frozen tool definition objects with strict JSON Schema validation for actions, branch names, and project-relative path arrays.

const RELATIVE_PATH_PATTERN = "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$)).+$";

export const gitBranchDefinition = Object.freeze({
  name: "git_branch",
  description:
    "Inspect or manage Git branches through Node Git Service. 'list' and 'current' are read-only for all roles; 'create', 'switch', and 'delete_merged' run under mutationLock for SE and Coder with protected-branch guards and working-tree sha256 reconciliation.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: Object.freeze({
      action: Object.freeze({
        type: "string",
        enum: ["list", "current", "create", "switch", "delete_merged"],
        description: "Branch operation to perform."
      }),
      name: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "Target branch name (required for create, switch, and delete_merged)."
      }),
      start_point: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "Optional base revision when action='create'."
      })
    })
  })
});

export const gitRestoreDefinition = Object.freeze({
  name: "git_restore",
  description:
    "Restore explicit project-relative working-tree files or unstage index paths through Node Git Service under mutationLock, automatically reconciling changed_paths and active_file_checksums. Global reset --hard is forbidden.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["action", "paths"],
    properties: Object.freeze({
      action: Object.freeze({
        type: "string",
        enum: ["restore_worktree", "unstage"],
        description: "Restore working-tree files ('restore_worktree') or unstage index entries ('unstage')."
      }),
      paths: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN }),
        description: "Required non-empty list of project-relative paths to restore."
      }),
      source: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "Optional source revision when action='restore_worktree'."
      })
    })
  })
});

export const gitStashDefinition = Object.freeze({
  name: "git_stash",
  description:
    "Manage Git stashes (list, push, pop, apply) through Node Git Service under mutationLock, automatically reconciling changed_paths and active_file_checksums after working-tree mutations.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: Object.freeze({
      action: Object.freeze({
        type: "string",
        enum: ["list", "push", "pop", "apply"],
        description: "Stash operation to execute."
      }),
      message: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Optional description when action='push'."
      }),
      paths: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN }),
        description: "Optional project-relative paths to scope action='push'."
      }),
      index: Object.freeze({
        type: "integer",
        minimum: 0,
        maximum: 50,
        description: "Optional stash index (0..50, default 0) for pop or apply."
      })
    })
  })
});
