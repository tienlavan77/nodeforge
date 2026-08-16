import assert from "node:assert/strict";
import test from "node:test";

import { extractorRegistry } from "../../src/modules/index/parser/index.js";

test("extracts a PHP class and its methods with line ranges", () => {
  const source = `<?php
class Account {
  public function login() {
  }
  public function logout() {
  }
}`;

  const extraction = extractorRegistry.extract("/project/src/account.php", source);

  assert.deepEqual(extraction.symbols, [
    { name: "Account", kind: "class", start_line: 2, end_line: 7 },
    { name: "login", kind: "method", start_line: 3, end_line: 4 },
    { name: "logout", kind: "method", start_line: 5, end_line: 6 }
  ]);
});

test("normalizes PHP use and static require imports", () => {
  const source = `<?php
use App\\Services\\Auth;
require_once __DIR__ . '/auth.php';
$dynamic = 'other.php';
require_once $dynamic;`;

  const extraction = extractorRegistry.extract("/project/src/index.php", source);

  assert.deepEqual(extraction.imports, [
    { source: "App\\Services\\Auth", imported: "Auth", local: "Auth", kind: "use", external: true },
    { source: "/project/src/auth.php", imported: null, local: null, kind: "require", external: false }
  ]);
});

test("ignores dynamic PHP require expressions without throwing", () => {
  const source = `<?php
$path = 'auth.php';
require $path;
require ($isDev ? 'dev.php' : 'prod.php');`;

  assert.doesNotThrow(() => extractorRegistry.extract("/project/src/index.php", source));
  assert.deepEqual(extractorRegistry.extract("/project/src/index.php", source).imports, []);
});

test("extracts direct PHP calls with their caller symbol", () => {
  const extraction = extractorRegistry.extract("/project/src/example.php", `<?php
function second() {}
function first() {
  second();
}`);

  assert.deepEqual(extraction.calls, [
    { callee_name: "second", line: 4, caller_symbol: "first" }
  ]);
});
