// Deterministic owner create/update/approve trigger classification for conversations.
// Business purpose: approved sections 3.2 and 3.4 let Node recognize a standalone
// imperative "create a plan" or "update the plan" line in ordinary owner conversation
// and route it to planning without the owner typing a path, hash or command, while
// questions, quoted text, fenced examples and ordinary prose that merely contains the
// phrase stay normal chat. The transport intent whitelist (normal_chat/ticket_create)
// is untouched, so the routing is classification only, never a new intent.
// Technical description: a line scanner keeps an explicit code-fence state machine;
// a line counts as a trigger only when its full trimmed form matches an imperative
// phrase, it is outside a ``` fence, does not end with a question mark and does not
// begin with a blockquote marker. Matching is exact per line, never substring search
// over whole prose, so mixed messages are detected by counting distinct trigger kinds.

const HANDOFF_SUFFIX_EN = "(?:(?:\\s*,\\s*|\\s+and\\s+)(?:please\\s+)?(?:hand\\s*off|assign|delegate)(?:\\s+(?:it|the\\s+work|work|this|them))?\\s+to\\s+(?<target_en>se|sl|system\\s+engineer|sprint\\s+leader))?";
const HANDOFF_SUFFIX_VI = "(?:(?:\\s*,\\s*|\\s+và\\s+)(?:giao(?:\\s+việc)?|chuyển\\s+giao|bàn\\s+giao)\\s+cho\\s+(?<target_vi>se|sl|system\\s+engineer|sprint\\s+leader))?";

// Recognized standalone English/Vietnamese imperative create-plan phrases from conversation.
const CONVERSATION_CREATE_PHRASES = [
  new RegExp(`^(?:please\\s+)?(?:create|generate|draft|make)\\s+(?:an?\\s+|the\\s+)?(?:new\\s+)?architecture\\s+plan\\b${HANDOFF_SUFFIX_EN}[.!]?$`, "i"),
  new RegExp(`^(?:please\\s+)?(?:create|generate|draft|make)\\s+(?:an?\\s+|the\\s+)?(?:new\\s+)?(?:architecture\\s+)?plan\\s+from\\s+(?:this|the)\\s+conversation\\b${HANDOFF_SUFFIX_EN}[.!]?$`, "i"),
  new RegExp(`^(?:please\\s+)?tạo\\s+(?:kế\\s+hoạch\\s+)?kiến\\s+trúc${HANDOFF_SUFFIX_VI}[.!]?$`, "i"),
  new RegExp(`^(?:please\\s+)?tạo\\s+kế\\s+hoạch(?:\\s+kiến\\s+trúc)?\\s+từ\\s+cuộc\\s+trao\\s+đổi${HANDOFF_SUFFIX_VI}[.!]?$`, "i")
];

// Recognized standalone English/Vietnamese imperative create-plan phrases from a Markdown file.
const FILE_CREATE_PHRASES = [
  new RegExp(`^(?:please\\s+)?(?:create|generate|draft|make)\\s+(?:an?\\s+|the\\s+)?(?:new\\s+)?(?:architecture\\s+)?plan\\s+from\\s+(?:file\\s+)?(?:\`([^\\\`\\s]+\\.md)\`|"([^"\\s]+\\.md)"|'([^'\\s]+\\.md)'|([^\\s,]+\\.md))${HANDOFF_SUFFIX_EN}[.!]?$`, "i"),
  new RegExp(`^(?:please\\s+)?tạo\\s+kế\\s+hoạch(?:\\s+kiến\\s+trúc)?\\s+từ\\s+(?:file\\s+)?(?:\`([^\\\`\\s]+\\.md)\`|"([^"\\s]+\\.md)"|'([^'\\s]+\\.md)'|([^\\s,]+\\.md))${HANDOFF_SUFFIX_VI}[.!]?$`, "i")
];

// Recognized standalone imperative update-plan phrases that carry no JSON of their own.
const UPDATE_PHRASES = [
  /^(?:please\s+)?update\s+(?:the\s+|this\s+)?(?:architecture\s+)?plan\b[.!]?$/i,
  /^(?:please\s+)?revise\s+(?:the\s+|this\s+)?(?:architecture\s+)?plan\b[.!]?$/i,
  /^(?:please\s+)?cập\s+nhật\s+(?:kế\s+hoạch|kiến\s+trúc)\b[.!]?$/i,
  /^\/(?:plan-update|update-plan|revise-plan)[.!]?$/i
];
// Recognized standalone approve phrases, used only to reject mixed messages.
const APPROVE_PHRASES = [
  /^(?:please\s+)?(?:approve|accept)\s+(?:the\s+|this\s+)?(?:architecture\s+)?plan\b[.!]?$/i,
  /^(?:please\s+)?duyệt\s+(?:kế\s+hoạch|kiến\s+trúc)\b[.!]?$/i
];
// Recognized standalone retry/continue handoff phrases for an already-created plan in the active conversation.
const RETRY_HANDOFF_PHRASES = [
  /^\/(?:handoff|retry-handoff)(?:\s+\S+)?[.!]?$/i,
  /^(?:please\s+)?(?:retry|continue|resume)\s+(?:the\s+)?(?:sl\s+|sprint\s+leader\s+)?handoff\b[.!]?$/i,
  /^(?:please\s+)?(?:chạy\s+)?(?:giao\s+lại|bàn\s+giao\s+lại|chuyển\s+giao\s+lại|tiếp\s+tục\s+giao)(?:\s+kế\s+hoạch)?\s+cho\s+(?:sl|sprint\s+leader)\b.*[.!]?$/i
];
const FENCE_RE = /^[ \t]*(```|~~~)/;

// Business purpose: translates a matched handoff role phrase from the owner's plan creation request into a canonical delivery target token so Node knows whether to pause for manual review or automatically hand off the locked revision to the Sprint Leader or System Engineer.
// Technical description: normalizes the captured role string to lowercase, collapses whitespace, and returns sl for Sprint Leader, se for System Engineer, or none when no handoff target was specified.
function normalizeDeliveryTarget(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "none";
  const lower = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (lower === "sl" || lower === "sprint leader") return "sl";
  if (lower === "se" || lower === "system engineer") return "se";
  return "none";
}

// Business purpose: parses a standalone plan creation trigger line in owner conversation so the planning workflow can accept either the active conversation or a specified Markdown document as its input source and optionally trigger automatic handoff to Sprint Leader or System Engineer.
// Technical description: scans non-fenced, non-quoted, non-interrogative lines against conversation and file creation regex patterns and returns an object containing line, source_kind, source_path, and delivery_target, or null when no trigger is present.
const MARKED_IDEAS_CREATE_PHRASES = [
  new RegExp(`^(?:please\\s+)?(?:create|generate|draft|make)\\s+(?:an?\\s+|the\\s+)?(?:new\\s+)?(?:architecture\\s+)?plans?\\s+from\\s+(?:the\\s+|all\\s+)?(?:marked\\s+)?ideas?(?:\\s+in\\s+(?:this|the)\\s+conversation)?\\b${HANDOFF_SUFFIX_EN}[.!]?$`, "i"),
  new RegExp(`^(?:please\\s+)?tạo\\s+(?:các\\s+)?kế\\s+hoạch(?:\\s+kiến\\s+trúc)?\\s+từ\\s+(?:các\\s+|những\\s+|danh\\s+sách\\s+)?ý\\s+tưởng(?:\\s+đã\\s+đánh\\s+dấu)?(?:\\s+trong\\s+cuộc\\s+trao\\s+đổi)?${HANDOFF_SUFFIX_VI}[.!]?$`, "i"),
  new RegExp(`^\\/(?:plan-ideas|plan-marked-ideas)(?:\\s+(?<target_en>se|sl|system\\s+engineer|sprint\\s+leader))?[.!]?$`, "i")
];

const IDEA_SYNTHESIS_PHRASES = [
  /^(?:(?:please|hãy|vui\s+lòng|nhờ\s+bạn)\s+)?(?:tổng\s+hợp|tóm\s+tắt|gom(?:\s+nhóm)?|chốt|lưu|ghi\s+nhận|đánh\s+dấu)(?:\s+.*)?\s+(?:thành\s+)?(?:một\s+|các\s+)?ý\s+tưởng(?:\s+.*)?[.!]?$/i,
  /^(?:please\s+)?(?:summarize|synthesi[sz]e|consolidate|compile|capture|save|record|mark|turn)\b.*\b(?:as\s+(?:an?\s+)?|into\s+(?:an?\s+)?)?ideas?\b.*[.!]?$/i
];

const AGENT_IDEA_HEADING_RE = /(?:^|\r?\n)\s*(?:#{1,4}\s*(?:ý\s+tưởng|tổng\s+hợp\s+ý\s+tưởng|idea|idea\s+summary)\b|\*\*(?:ý\s+tưởng|tổng\s+hợp\s+ý\s+tưởng|idea|idea\s+summary)\s*[:：]|\[idea\])/i;

// Business purpose: detects a standalone owner request in conversation asking the agent to synthesize or summarize related exchanges into an idea.
// Technical description: scans non-fenced, non-quoted, non-interrogative lines that are not plan creation triggers against IDEA_SYNTHESIS_PHRASES and returns the first matching line or null.
export function detectIdeaSynthesisTrigger(text) {
  if (parseConversationPlanCreateTrigger(text)) return null;
  return firstMatchingLine(text, IDEA_SYNTHESIS_PHRASES);
}

// Business purpose: determines whether an agent response message should be persisted and streamed with is_idea set to true automatically or via explicit caller state.
// Technical description: preserves any explicit boolean flag, otherwise checks whether the originating owner prompt matched detectIdeaSynthesisTrigger or the agent reply text matches AGENT_IDEA_HEADING_RE.
export function isIdeaSummaryResponse({ ownerText = "", agentText = "", explicitIdea } = {}) {
  if (typeof explicitIdea === "boolean") return explicitIdea;
  if (detectIdeaSynthesisTrigger(ownerText) !== null) return true;
  return AGENT_IDEA_HEADING_RE.test(String(agentText ?? ""));
}

export function parseConversationPlanCreateTrigger(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let fenced = false;
  for (const rawLine of lines) {
    if (FENCE_RE.test(rawLine)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = rawLine.trim();
    if (!line || line.endsWith("?") || line.endsWith("？") || line.startsWith(">")) continue;
    for (const pattern of MARKED_IDEAS_CREATE_PHRASES) {
      const match = pattern.exec(line);
      if (match) {
        return {
          line,
          source_kind: "marked_ideas",
          source_path: null,
          delivery_target: normalizeDeliveryTarget(match.groups?.target_en ?? match.groups?.target_vi)
        };
      }
    }
    for (const pattern of CONVERSATION_CREATE_PHRASES) {
      const match = pattern.exec(line);
      if (match) {
        return {
          line,
          source_kind: "conversation",
          source_path: null,
          delivery_target: normalizeDeliveryTarget(match.groups?.target_en ?? match.groups?.target_vi)
        };
      }
    }
    for (const pattern of FILE_CREATE_PHRASES) {
      const match = pattern.exec(line);
      if (match) {
        const rawPath = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim().replace(/[.!]+$/, "");
        return {
          line,
          source_kind: "markdown_file",
          source_path: rawPath,
          delivery_target: normalizeDeliveryTarget(match.groups?.target_en ?? match.groups?.target_vi)
        };
      }
    }
  }
  return null;
}

// Returns the first standalone create trigger line, or null when the text stays normal chat.
export function detectPlanCreateTrigger(text) {
  return parseConversationPlanCreateTrigger(text)?.line ?? null;
}

// Returns the first standalone update trigger line, or null when none is present.
export function detectPlanUpdateTrigger(text) {
  return firstMatchingLine(text, UPDATE_PHRASES);
}

// Returns the first standalone approve trigger line, or null when none is present.
export function detectPlanApproveTrigger(text) {
  return firstMatchingLine(text, APPROVE_PHRASES);
}

// Business purpose: detects a standalone owner request in conversation to retry or continue handing off an already-created plan to Sprint Leader without regenerating the plan.
// Technical description: scans non-fenced, non-quoted, non-interrogative lines against RETRY_HANDOFF_PHRASES and returns the first matching line or null.
export function detectPlanHandoffRetryTrigger(text) {
  return firstMatchingLine(text, RETRY_HANDOFF_PHRASES);
}

// Tells Node whether one message needs planning routing instead of ordinary agent chat.
// Business purpose: a message routes to planning only for a standalone create or update
// trigger; an approve phrase on its own never counts, because approval keeps requiring
// the exact /approve command, so a mixed message stays a planning message that then fails
// the mixed-approval guard rather than silently approving.
// Technical description: the predicate composes the create and update line detectors.
export function isConversationPlanMessage(text) {
  const value = String(text ?? "");
  return detectPlanCreateTrigger(value) !== null || detectPlanUpdateTrigger(value) !== null;
}

// Rejects any message that mixes create/update intent with approve intent before approval routing.
export function assertNoMixedPlanningApproval(text) {
  const value = String(text ?? "");
  const approve = detectPlanApproveTrigger(value) ?? (/^\/approve\b/im.test(value) ? "/approve" : null);
  if (!approve) return;
  const mutation = detectPlanCreateTrigger(value) ?? detectPlanUpdateTrigger(value) ?? (/^\/plan\b/im.test(value) ? "/plan" : null);
  if (!mutation) return;
  throw Object.assign(new Error(`A message mixing "${mutation}" with "${approve}" never approves; send /approve <plan_id> alone.`), { code: "PLAN_APPROVAL_MIXED", statusCode: 409 });
}

// Scans lines with fence/quote/question exclusion and returns the first line matching any phrase.
function firstMatchingLine(text, patterns) {
  const lines = String(text ?? "").split(/\r?\n/);
  let fenced = false;
  for (const rawLine of lines) {
    if (FENCE_RE.test(rawLine)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = rawLine.trim();
    if (!line || line.endsWith("?") || line.endsWith("？") || line.startsWith(">")) continue;
    if (patterns.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}
