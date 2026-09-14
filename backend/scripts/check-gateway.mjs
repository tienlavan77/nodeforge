#!/usr/bin/env node
/**
 * check-gateway.mjs — chẩn đoán kết nối tới third-party gateway (DevQuote / Anthropic-compatible).
 *
 * Không đổi config, không gửi key ra ngoài. Chạy: node backend/scripts/check-gateway.mjs
 * Exit 0 nếu có ít nhất một combo (endpoint + auth header) trả 2xx, ngược lại exit 1.
 */
import dns from "node:dns/promises";

const PROBE_TIMEOUT_MS = 15000;

const env = process.env;

function mask(value) {
  if (!value) return "<missing>";
  if (value.length <= 12) return `${value.slice(0, 3)}…(len=${value.length})`;
  return `${value.slice(0, 6)}…${value.slice(-4)}(len=${value.length})`;
}

function line(label, value) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// ---- 1. Config hiện thấy -------------------------------------------------
section("1. Cấu hình gateway trên môi trường này");
const configuredBase = env.FORGE_GATEWAY_BASE_URL || env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL || "";
const apiKey = env.OPENAI_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
const model = env.NODE_AGENT_MODEL || env.DEVQUOTE_MODEL || "claude-haiku-4-5";

line("FORGE_GATEWAY_BASE_URL", env.FORGE_GATEWAY_BASE_URL || "<unset>");
line("OPENAI_BASE_URL", env.OPENAI_BASE_URL || "<unset>");
line("OPENAI_API_KEY", mask(env.OPENAI_API_KEY));
line("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL || "<unset>");
line("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY ? "(set)" : "<unset>");
line("ANTHROPIC_AUTH_TOKEN", mask(env.ANTHROPIC_AUTH_TOKEN));
line("NODE_AGENT_MODEL", env.NODE_AGENT_MODEL || "<unset>");
line("NODE_AGENT_TIMEOUT_MS", env.NODE_AGENT_TIMEOUT_MS || "300000 (default)");
line("HTTPS_PROXY", env.HTTPS_PROXY || env.https_proxy || "<unset>");

if (env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY) {
  console.log("  ! Cảnh báo: có cả ANTHROPIC_API_KEY và OPENAI_API_KEY. claude-sdk-gateway.js sẽ override ANTHROPIC_API_KEY=\"\" khi chạy qua SDK.");
}
if (!configuredBase) {
  console.log("  ! Không tìm thấy FORGE_GATEWAY_BASE_URL, OPENAI_BASE_URL hay ANTHROPIC_BASE_URL. Script không có endpoint để test.");
  report([{ check: "config", status: "FAIL", evidence: "missing base URL", suggestion: "Đặt OPENAI_BASE_URL=https://sv.devquote.shop trong .nodeforge/env hoặc environment của service." }]);
  process.exit(1);
}
if (!apiKey) {
  console.log("  ! Không tìm thấy API key (OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY).");
  report([{ check: "credential", status: "FAIL", evidence: "missing api key", suggestion: "Xuất API key vào đúng shell chạy service (xem pm2 env / docker exec / systemctl show --property=Environment)." }]);
  process.exit(1);
}

let gatewayHost;
try {
  gatewayHost = new URL(configuredBase).hostname;
} catch {
  report([{ check: "base_url", status: "FAIL", evidence: `không parse được: ${configuredBase}`, suggestion: "Base URL phải là https:// tuyệt đối." }]);
  process.exit(1);
}

// ---- 2. DNS + egress IP --------------------------------------------------
section("2. DNS / TLS / egress");
const results = [];

let ipList = [];
try {
  ipList = await dns.lookup(gatewayHost, { all: true });
  line("DNS", `${gatewayHost} -> ${ipList.map((i) => i.address).join(", ")}`);
  results.push({ check: "dns", status: "OK", evidence: ipList.map((i) => i.address).join(","), suggestion: "" });
} catch (error) {
  line("DNS", `FAIL (${error.code || error.message})`);
  results.push({ check: "dns", status: "FAIL", evidence: error.code || error.message, suggestion: "Kiểm tra /etc/resolv.conf và firewall UDP/TCP 53." });
}

try {
  const egress = await fetchWithTimeout("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const { ip } = await egress.json();
  line("Egress IP", ip + "  (gửi IP này cho DevQuote nếu gateway whitelist)");
} catch {
  line("Egress IP", "<không xác định được>");
}

// ---- 3. Probe endpoints + auth styles ------------------------------------
section("3. Probe endpoint (timeout " + PROBE_TIMEOUT_MS + "ms)");

// DevQuote expose /v1/messages (Anthropic-compatible) và /v1/responses (OpenAI responses).
// Base có thể là https://host, https://host/v1, hoặc .../v1/messages — chuẩn hoá lại (khớp devquote-adapter.normalizeUrl).
const rawBase = configuredBase.replace(/\/$/, "");
const v1Base = rawBase.endsWith("/v1/messages") || rawBase.endsWith("/v1/responses")
  ? rawBase.replace(/\/(messages|responses)$/, "")
  : rawBase.endsWith("/v1")
    ? rawBase
    : `${rawBase}/v1`;
const endpoints = [
  { name: "messages", url: `${v1Base}/messages`, kind: "anthropic" },
  { name: "responses", url: `${v1Base}/responses`, kind: "openai" },
];
line("Probe base", v1Base);

const authStyles = [
  { name: "x-api-key", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
  { name: "Bearer", headers: { authorization: `Bearer ${apiKey}` } },
];

function bodyFor(kind) {
  return kind === "anthropic"
    ? { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
    : { model, input: "ping" };
}

async function fetchWithTimeout(url, opts) {
  return fetch(url, opts);
}

let anySuccess = false;
const probeRows = [];

for (const ep of endpoints) {
  for (const auth of authStyles) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    let status = "ERR";
    let evidence = "";
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": "check-gateway", ...auth.headers },
        body: JSON.stringify(bodyFor(ep.kind)),
        signal: controller.signal,
      });
      status = String(res.status);
      const text = (await res.text()).slice(0, 200);
      evidence = `${status} ${res.ok ? "OK" : ""} ${text}`.trim();
      if (res.ok) {
        anySuccess = true;
        evidence += ` [auth=${auth.name}]`;
      }
    } catch (error) {
      const code = error.cause?.code || error.code || error.name;
      evidence = `${code} sau ${Date.now() - started}ms: ${error.message}`;
      status = code || "ERR";
    } finally {
      clearTimeout(timer);
    }
    line(`${ep.name.padEnd(9)}/${auth.name.padEnd(9)}`, evidence);
    probeRows.push({ ep, auth, status, evidence });
  }
}

// ---- 4. Interpretation ---------------------------------------------------
section("4. Kết luận & đề xuất");

function classify(status) {
  const s = Number(status);
  if (s >= 200 && s < 300) return "OK";
  if (s === 401 || s === 403) return "AUTH";
  if (s === 404) return "PATH";
  if (s === 429) return "QUOTA";
  if (status === "ERR" || status === "AbortError" || /TIMEOUT|ECONN|ENOTFOUND|EAI_AGAIN|certificate|UND_ERR/i.test(status)) return "NET";
  return "OTHER";
}

const byCategory = {};
for (const row of probeRows) {
  const cat = classify(row.status);
  (byCategory[cat] ||= []).push(row);
}

function suggest(cat, rows) {
  switch (cat) {
    case "AUTH":
      return "Sai/hết hạn key hoặc IP chưa được whitelist. Gửi egress IP cho DevQuote, kiểm tra lại key (khớp mask ở bước 1).";
    case "PATH":
      return `Endpoint không tồn tại: ${rows.map((r) => r.ep.name).join(", ")}. DevQuote chỉ expose ${hasMessages ? "/v1/messages" : "đường dẫn khác"} — cấu hình profile provider phải khớp (claude/devquote, KHÔNG dùng openai-sdk-gateway nếu chỉ có /v1/messages).`;
    case "QUOTA":
      return "Gateway trả 429: quota/rate limit. codex-adapter chỉ retry 2 lần — tăng quota hoặc giảm concurrency.";
    case "NET":
      return `Lỗi mạng/TLS: thử \`curl -v ${rows[0]?.ep.url || configuredBase}\`, \`openssl s_client -connect ${gatewayHost}:443\`, kiểm tra ufw/iptables/proxy.`;
    case "OTHER":
      return "Mã lạ, xem raw evidence ở trên và log service (grep 'Agent Gateway' backend/logs).";
    default:
      return "";
  }
}

const hasMessages = probeRows.some((r) => r.ep.name === "messages");
for (const [cat, rows] of Object.entries(byCategory)) {
  if (cat === "OK") {
    const ok = rows.map((r) => `${r.ep.name}+${r.auth.name}`).join(", ");
    console.log(`  [OK]   kết nối thành công qua: ${ok}`);
    results.push({ check: "connectivity", status: "OK", evidence: ok, suggestion: "" });
  } else {
    console.log(`  [${cat}] ${rows.map((r) => `${r.ep.name}/${r.auth.name}=${r.status}`).join(", ")}`);
    console.log(`         → ${suggest(cat, rows)}`);
    results.push({ check: `probe:${cat}`, status: cat, evidence: rows.map((r) => r.ep.name + "/" + r.auth.name).join(","), suggestion: suggest(cat, rows) });
  }
}

if (!anySuccess) {
  console.log("\n  >>> Không có combo endpoint+auth nào trả 2xx. Agent KHÔNG kết nối được gateway này từ máy nay.");
  report(results);
  process.exit(1);
}
console.log("\n  >>> Có ít nhất một combo hoạt động. Agent phải kết nối được nếu provider/credential_ref trong profile trỏ đúng key này.");
report(results);

function report(rows) {
  section("Báo cáo tóm tắt");
  for (const r of rows) {
    console.log(`  ${r.check.padEnd(22)} ${String(r.status).padEnd(8)} ${r.evidence}${r.suggestion ? " | " + r.suggestion : ""}`);
  }
}
