<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
   ↓
REQUEST_CHANGES
   ↓
Builder
```

The next Commit remains locked.

Builder addresses only:

- concrete review findings;
- approved Commit scope.

The loop continues until:

```text
APPROVED
```

or:

```text
BLOCKED
```

---

# 17. Builder Request / Blocker

If Builder discovers that the Commit contract is insufficient:

```text
Builder
   ↓
builder-request.md
   ↓
Node
   ↓
Sprint Lead
```

If the request changes:

- scope;
- Architecture;
- API;
- dependency policy;
- acceptance criteria;

then Project Owner approval is required.

Node routes the request but does not invent the decision.

---

# 18. Opening the Next Commit

When Reviewer approves:

```text
Reviewer
   ↓
APPROVED
   ↓
Node
```

Node validates:

- correct Commit;
- review evidence;
- required tests;
- dependencies;
- specialist gates;
- state consistency.

Then:

```text
Node
 ↓
Sprint Lead coordination
 ↓
next eligible Commit
```

The next Commit is opened only when dependencies are approved.

Code completion alone does not unlock the next Commit.

---

# 19. Sprint Completion

After all required Commits are approved:

```text
All Commits APPROVED
        ↓
Final verification
        ↓
Sprint Report
        ↓
Project Owner
        ↓
SPRINT COMPLETED
```

Project Owner remains responsible for final Sprint closure.

---

# 20. File Watcher vs Node Observation

The previous Architecture explicitly rejected using a File Watcher as the workflow orchestrator.

That principle remains.

The distinction is:

### Not allowed

```text
File changed
   ↓
Watcher decides next Agent
```

### Allowed

```text
Filesystem/Git event
   ↓
Node observation layer
   ↓
State reconciliation
   ↓
Workflow engine
   ↓
Decision
```

The filesystem observer is an **input signal**, not the workflow authority.

---

# 21. Project Change Detection

Node may observe changes made by:

- Builder;
- human coder;
- external tool;
- Git operation;
- another automation process.

On change:

```text
Change detected
      ↓
Identify project
      ↓
Update structure/index
      ↓
Invalidate stale context
      ↓
Analyze affected Commit
      ↓
Run required verification
      ↓
Reconcile execution state
```

Node must not assume that every change originated from Builder.

---

# 22. Structure Index

Each target project has its own Forge-owned structure index.

Conceptually:

```text
<forge-data-root>/
└── projects/
    └── <target-project-fingerprint>/
        └── structure.md
```
