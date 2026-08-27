#!/usr/bin/env node

/**
 * Test script: Verify devquote adapter works with gateway
 *
 * Usage:
 *   DEVQUOTE_API_KEY=sk-xxxx node test-devquote-adapter.js [--debug]
 *
 * Or set in .env file:
 *   DEVQUOTE_API_KEY=sk-xxxx
 */

import { request, stream } from "../src/modules/agent/provider-adapters/devquote-adapter.js";

const API_KEY = process.env.DEVQUOTE_API_KEY;
const GATEWAY_URL = process.env.DEVQUOTE_GATEWAY_URL || "https://sv.devquote.shop";
const MODEL = process.env.DEVQUOTE_MODEL || "claude-haiku-4-5";
const DEBUG = process.argv.includes("--debug");

if (!API_KEY) {
  console.error("❌ Missing DEVQUOTE_API_KEY environment variable");
  console.error("   Set it: export DEVQUOTE_API_KEY=sk-xxxx");
  process.exit(1);
}

console.log("🧪 Testing Devquote Gateway Adapter");
console.log(`   Gateway: ${GATEWAY_URL}`);
console.log(`   Model: ${MODEL}`);
console.log(`   Auth: Bearer token`);
if (DEBUG) console.log(`   Debug mode: ON`);
console.log();

// Test 1: Request (non-streaming)
console.log("📝 Test 1: Request (non-streaming)");
try {
  const response = await request({
    url: GATEWAY_URL,
    credential: API_KEY,
    payload: { text: "Say 'Hello from NodeForge Builder!' in one sentence." },
    model: MODEL,
    correlationId: "TEST-REQ-001"
  });

  console.log(`   ✅ Status: ${response.status}`);
  console.log(`   ✅ Response ID: ${response.payload.response_id}`);
  console.log(`   ✅ Response text: "${response.payload.text}"`);
} catch (error) {
  console.error(`   ❌ Error: ${error.message}`);
  if (DEBUG) {
    console.error("\n   🔍 Debug info:");
    console.error(`      Gateway URL used: ${GATEWAY_URL}/v1/messages`);
    console.error(`      Model: ${MODEL}`);
    console.error(`      Payload: ${JSON.stringify({ text: "Hello from NodeForge Builder!" }, null, 2)}`);
  }
}

console.log();

// Test 2: Stream (real-time)
console.log("📡 Test 2: Stream (real-time)");
try {
  const streamPromise = stream({
    url: GATEWAY_URL,
    credential: API_KEY,
    payload: { text: "Explain what NodeForge is in 3 sentences." },
    model: MODEL,
    correlationId: "TEST-STREAM-001"
  });

  let fullText = "";
  let eventCount = 0;
  for await (const event of streamPromise) {
    if (event.text) {
      fullText += event.text;
      eventCount++;
      process.stdout.write(event.text);
    }
    if (event.completed) {
      console.log("\n   ✅ Stream complete");
      break;
    }
  }

  console.log(`\n   📄 Full response: "${fullText}"`);
  if (DEBUG) {
    console.log(`   📊 Events received: ${eventCount}`);
  }
} catch (error) {
  console.error(`   ❌ Error: ${error.message}`);
  if (DEBUG) {
    console.error("\n   🔍 Debug info:");
    console.error(`      Gateway URL used: ${GATEWAY_URL}/v1/messages`);
    console.error(`      Model: ${MODEL}`);
  }
}

console.log();
console.log("✅ Tests complete!");

if (DEBUG) {
  console.log("\n📋 Next steps:");
  console.log("   1. Check API key is valid:");
  console.log(`      curl -X POST ${GATEWAY_URL}/v1/messages \`
`);
  console.log(`        -H "Authorization: Bearer $DEVQUOTE_API_KEY" \`
`);
  console.log(`        -H "content-type: application/json" \`
`);
  console.log(`        -d '{"model":"${MODEL}","max_tokens":100,"messages":[{"role":"user","content":"Say OK"}]}'`);
  console.log();
  console.log("   2. Check model availability:");
  console.log(`      curl -X GET ${GATEWAY_URL}/v1/models \`
`);
  console.log(`        -H "Authorization: Bearer $DEVQUOTE_API_KEY"`);
}
