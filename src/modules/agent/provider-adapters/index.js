import * as codex from "./codex-adapter.js";
import * as anthropic from "./anthropic-adapter.js";
import * as custom from "./custom-adapter.js";
import * as openai from "./openai-adapter.js";

export function getAdapter(provider) {
  if (provider === "claude" || provider === "anthropic") return anthropic;
  if (provider === "custom") return custom;
  if (provider === "openai") return openai;
  return codex;
}

export { codex, anthropic, openai, custom };
