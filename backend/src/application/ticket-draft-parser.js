// Parses a governance ticket draft from sprint-leader text output.
export function extractTicketJson(text) {
  const value = String(text ?? "");
  const candidates = [];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced?.trim()) candidates.push(fenced.trim());
  const start = value.search(/[{[]/);
  if (start >= 0) candidates.push(value.slice(start));
  for (const candidate of candidates) {
    const parsed = parseLeadingJson(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

// Parses the leading JSON object from sprint-leader output.
function parseLeadingJson(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      // eslint-disable-next-line no-silent-catch -- JSON probe: incomplete prefix takes the undefined path by design.
      try { const parsed = JSON.parse(trimmed.slice(0, index + 1)); return parsed && !Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; }
    }
  }
  return undefined;
}
