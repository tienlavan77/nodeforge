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

// Recognized standalone English/Vietnamese imperative create-plan phrases.
const CREATE_PHRASES = [
  /^(?:please\s+)?(?:create|generate|draft|make)\s+(?:an?\s+|the\s+)?(?:new\s+)?architecture\s+plan\b[.!]?$/i,
  /^(?:please\s+)?(?:create|generate|draft|make)\s+(?:an?\s+|the\s+)?(?:new\s+)?plan\s+from\s+(?:this|the)\s+conversation\b[.!]?$/i,
  /^(?:please\s+)?tạo\s+(?:kế\s+hoạch\s+)?kiến\s+trúc\b[.!]?$/i,
  /^(?:please\s+)?tạo\s+kế\s+hoạch\s+từ\s+cuộc\s+trao\s+đổi\b[.!]?$/i
];
// Recognized standalone imperative update-plan phrases that carry no JSON of their own.
// Approved sections 3.2.7-3.2.10 additionally require additive slash aliases so an owner
// can issue the update in command form inside the same conversation without changing any
// legacy command contract: `/plan-update`, `/update-plan` and `/revise-plan` on their own
// line are the only new accepted spellings. They never take arguments, so `/plan <file.md>`,
// `/approve <plan_id>` and `/plan-continue <CLARIFY-id>` keep exact prior behavior, and the
// shared line scanner still excludes quoted, fenced and interrogative occurrences.
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
const FENCE_RE = /^[ \t]*(```|~~~)/;

// Returns the first standalone create trigger line, or null when the text stays normal chat.
export function detectPlanCreateTrigger(text) {
  return firstMatchingLine(text, CREATE_PHRASES);
}

// Returns the first standalone update trigger line, or null when none is present.
export function detectPlanUpdateTrigger(text) {
  return firstMatchingLine(text, UPDATE_PHRASES);
}

// Returns the first standalone approve trigger line, or null when none is present.
export function detectPlanApproveTrigger(text) {
  return firstMatchingLine(text, APPROVE_PHRASES);
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
