// Defines the shared agent contract with validation and normalization.
import { ConfigurationError } from "../shared/errors.js";

// Creates a validated agent contract with normalized execution.
export function createAgentContract(agent) {
  validateAgentContract(agent);
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    canHandle: (task) => agent.canHandle(task),
    execute: async (context) => normalizeResult(await agent.execute(context))
  });
}

// Validates that an agent contract has required fields.
export function validateAgentContract(agent) {
  if (!agent || typeof agent !== "object") throw new ConfigurationError("Agent contract must be an object.");
  if (typeof agent.id !== "string" || agent.id.length === 0) throw new ConfigurationError("Agent contract requires id.");
  if (typeof agent.name !== "string" || agent.name.length === 0) throw new ConfigurationError("Agent contract requires name.");
  if (typeof agent.canHandle !== "function") throw new ConfigurationError("Agent contract requires canHandle(task).");
  if (typeof agent.execute !== "function") throw new ConfigurationError("Agent contract requires execute(context).");
  return true;
}

// Validates and freezes an agent execution result.
function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string" || result.status.length === 0) {
    throw new ConfigurationError("Agent execute() must return a result object with status.");
  }
  return Object.freeze({ ...result });
}

// Resolves a chat role for a conversation message so clients can distinguish user from agent.
export function resolveConversationMessageRole(message) {
  const senderRole = typeof message?.sender === "string" ? undefined : message?.sender?.role;
  const role = senderRole ?? message?.sender_role ?? message?.role;
  if (role === "project_owner" || role === "user" || role === "owner") return "user";
  if (role === "node" || role === "system") return "system";
  return "agent";
}

// Normalizes a conversation message while preserving its existing contract fields.
export function normalizeConversationMessage(message, index = 0) {
  if (!message || typeof message !== "object") throw new ConfigurationError("Conversation message must be an object.");
  const role = message.role ?? resolveConversationMessageRole(message);
  const senderId = typeof message.sender === "string" ? message.sender : message.sender?.id;
  const author = message.author ?? senderId ?? message.sender_role ?? null;
  return Object.freeze({
    ...structuredClone(message),
    role,
    author,
    sequence: message.sequence ?? index,
  });
}

// Projects stored communication messages as full chat history with user and agent roles.
export function toConversationChatHistory(messages = []) {
  if (!Array.isArray(messages)) throw new ConfigurationError("Conversation messages must be an array.");
  return messages.map((message, index) => normalizeConversationMessage(message, index));
}
