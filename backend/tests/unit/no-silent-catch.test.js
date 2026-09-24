// Summary: Unit tests proving the no-silent-catch rule flags silent fallbacks only.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RuleTester } = require("eslint");
const rule = require("../../../eslint-rules/no-silent-catch.js");

test("no-silent-catch flags empty and silent-fallback catches only", () => {
  const tester = new RuleTester({ parserOptions: { ecmaVersion: "latest", sourceType: "module" } });
  tester.run("no-silent-catch", rule, {
    valid: [
      "function f() { try { work(); } catch (error) { throw error; } }",
      "function f() { try { work(); } catch (error) { logger.warn('failed', { error: error.message }); return null; } }",
      "function f() { try { work(); } catch (error) { console.error(error); } }",
      "function f() { try { work(); } catch (error) { publish('failed', { error: error.message }); } }",
      "function f() { try { work(); } catch (error) { warnings.push({ message: error.message }); } }",
      "function f() { try { work(); } catch (error) { return { reason: `failed: ${error.message}` }; } }",
      "function f() { try { work(); } catch { throw new Error('invalid'); } }",
      "function f() { try { work(); } catch (error) { if (error.code === 'ENOENT') throw error; return fallback(error); } }",
      "function f() { try { work(); } catch (error) { warn('failed'); throw error; } }",
    ],
    invalid: [
      { code: "function f() { try { work(); } catch {} }", errors: [{ message: /Empty catch block/ }] },
      { code: "function f() { try { work(); } catch { return null; } }", errors: [{ message: /without logging/ }] },
      { code: "function f() { try { work(); } catch (error) { return null; } }", errors: [{ message: /without logging/ }] },
      { code: "function f() { try { work(); } catch (error) { const f = () => { throw error; }; return f; } }", errors: [{ message: /without logging/ }] },
    ],
  });
  assert.ok(true);
});
