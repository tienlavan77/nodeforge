import * as codex from "./codex-adapter.js";
import * as anthropic from "./anthropic-adapter.js";
import * as custom from "./custom-adapter.js";
import * as openai from "./openai-adapter.js";
import * as devquote from "./devquote-adapter.js";
import * as claude from "./claude-adapter.js";
import * as ollama from "./ollama-adapter.js";

export function getAdapter(provider) {
  if (provider === "claude") return claude;
  if (provider === "anthropic") return anthropic;
  if (provider === "devquote") return devquote;
  if (provider === "custom") return custom;
  if (provider === "openai") return openai;
  if (provider === "ollama") return ollama;
  return codex;
}

export { codex, claude, anthropic, ollama, openai, custom, devquote };
