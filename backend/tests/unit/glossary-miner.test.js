// Verifies glossary-miner opt-in controls so ordinary retrieval evals remain LLM-free.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveGlossaryMinerEnabled } from "../eval/glossary-miner.mjs";

test("glossary miner is disabled by default, even when credentials exist", () => {
  assert.equal(resolveGlossaryMinerEnabled({ args: {}, env: { GLOSSARY_MINER_ENABLED: "0", GLOSSARY_LINGUIST_API_KEY: "secret" } }), false);
});

test("glossary miner can be enabled by env or CLI flag", () => {
  assert.equal(resolveGlossaryMinerEnabled({ args: {}, env: { GLOSSARY_MINER_ENABLED: "1" } }), true);
  assert.equal(resolveGlossaryMinerEnabled({ args: { glossary: undefined }, env: { GLOSSARY_MINER_ENABLED: "0" } }), true);
});

test("CLI flags override the environment", () => {
  assert.equal(resolveGlossaryMinerEnabled({ args: { "no-glossary": undefined }, env: { GLOSSARY_MINER_ENABLED: "1" } }), false);
  assert.equal(resolveGlossaryMinerEnabled({ args: { glossary: undefined }, env: { GLOSSARY_MINER_ENABLED: "0" } }), true);
});
