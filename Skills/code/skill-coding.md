---
name: nodeforge-code-structure
description: Enforce Nodeforge code structure rules for source files. Use when creating, modifying, refactoring, or reviewing code in the Nodeforge project.
---

# Nodeforge Code Structure

Follow these rules for every code file created or modified in the Nodeforge project.

## Rules

### 1. Maximum 4 functions per file

A single code file MUST contain no more than 4 functions.

Count all functions defined in the file, including:

- function declarations
- function expressions
- arrow functions
- class methods
- static methods
- exported functions

If implementing a feature requires more than 4 functions, split the implementation into multiple focused files.

Do NOT bypass this rule by hiding additional functions inside callbacks, closures, or nested scopes.

### 2. Maximum 4 external imports per file

A code file MUST import no more than 4 external/local modules.

Count each distinct imported module/path, not each imported symbol.

For example:

```js
import { a, b, c } from "./module-a.js";
import x from "./module-b.js";
import y from "./module-c.js";
import z from "./module-d.js";
```

This is 4 imports.

Do NOT split one module import into multiple import statements to bypass this limit.

If a file requires more than 4 modules, reconsider the module boundary and split the responsibility across multiple files.

### 3. File summary comment

Every code file MUST begin with a comment describing the primary responsibility of the file.

The comment MUST appear before imports and implementation code.

Example:

```js
// Summary: Executes agent workflow steps sequentially.
```

The summary should describe WHAT the file is responsible for, not implementation details.

### 4. Function responsibility comment

Every function MUST have a comment immediately below its function declaration/name and before its implementation body.

The comment MUST describe the specific responsibility of that function.

Example:

```js
function executeStep(step) {
  // Executes one workflow step and returns its execution result.
  return run(step);
}
```

For arrow functions:

```js
const validateStep = (step) => {
  // Validates the required fields of a workflow step.
  return Boolean(step?.id && step?.title);
};
```

For class methods:

```js
class Executor {
  execute(step) {
    // Executes a single workflow step.
    return this.run(step);
  }
}
```

## Enforcement

When creating or modifying code:

1. Count the functions in the target file.
2. Verify the count is <= 4.
3. Count distinct imported modules.
4. Verify the count is <= 4.
5. Verify the file begins with a `Summary:` comment.
6. Verify every function has its responsibility comment immediately below its declaration/name.
7. If any rule would be violated, restructure the implementation instead of ignoring the rule.

These rules apply to newly created files and modified files.

Do not weaken, remove, or bypass these rules merely to keep an implementation inside one file.