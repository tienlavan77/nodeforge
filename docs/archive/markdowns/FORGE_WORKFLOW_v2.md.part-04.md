<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
rules
allowed_change_areas
acceptance_criteria
relevant_context
test_policy
workspace_policy
```

Builder then implements directly in the target project workspace.

The project filesystem remains the implementation source of truth.

---

# 11. Builder Verification

Builder runs the required focused checks:

```text
FOCUSED
+
syntax checks
+
git diff --check
```

Builder creates:

```text
builder-report.md
```

and optionally:

```text
changes.diff
```

Builder then reports completion to Node.

Node does not trust an Agent's textual claim alone.

---

# 12. Node Verification

This is a major responsibility of Node.

Node runs deterministic verification independently where possible.

Recommended escalation:

```text
FOCUSED
   ↓
RELATED
   ↓
FULL
```

### Focused

Changed module/direct behavior.

### Related

Shared modules, contracts, public APIs, adjacent behavior.

### Full

Required:

- final Commit/Sprint integration gate;
- release/merge;
- broad regression risk;
- changes to shared contracts;
- dependency changes;
- public API changes;
- core Architecture changes unless explicit exception is approved.

---

# 13. Test Result Compression

Raw output:

```text
20,000 lines
```

must not automatically be sent to Builder/Reviewer.

Node transforms it into:

```json
{
  "status": "failed",
  "level": "focused",
  "failed_checks": 1,
  "failure": {
    "test": "runner timeout",
    "file": "test/runner/timeout.test.js",
    "line": 82,
    "category": "assertion",
    "summary": "Expected process termination after timeout"
  }
}
```

Only the relevant evidence is added to the next Agent context.

This is one of the main mechanisms for reducing token consumption.

---

# 14. Reviewer Dispatch

After the Builder handoff and required verification:

```text
Node
 ↓
Reviewer Task Package
```

Reviewer receives:

```text
Commit Contract
+
Architecture scope
+
Rules
+
Sprint decisions
+
Builder Report
+
Diff
+
Relevant source
+
Test evidence
+
Previous review findings
```

Reviewer does not need the entire project.

---

# 15. Reviewer Gate

Reviewer performs:

1. artifact consistency gate;
2. Commit/acceptance criteria review;
3. Architecture/decision review;
4. source/diff inspection;
5. focused/related test verification;
6. bug/regression review;
7. scope review;
8. Architecture compliance review.

Then exactly one:

```text
APPROVED
REQUEST_CHANGES
BLOCKED
```

---

# 16. Request Changes Loop

If Reviewer returns:

```text
REQUEST_CHANGES
```

Node routes the same Commit back to Builder.

```text
Builder
   ↓
Verification
   ↓
Reviewer
