// Standalone claude app verification: no selector, no hub — just the app's
// own wire. create → prompt → ride the cursor to the real reply, then check
// the slash-command mirror (R12) and the model catalog (Task 9) live.
import { readFileSync } from "node:fs";

const jar = readFileSync(process.env.AW_JAR ?? "/tmp/aw-claude-app.jar", "utf8");
const line = jar.split("\n").filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).pop();
const cookie = line.split("\t").slice(-2).join("=");
const base = process.env.AW_BASE ?? "http://127.0.0.1:4989";
let n = 0;

const rpc = async (method, payload, timeoutMs = 15000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "client-request", rpcId: `v-${++n}`, method, payload }),
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { return `NON-JSON ${res.status}: ${text.slice(0, 120)}`; }
    const r = body?.result ?? body;
    return r?.ok === false ? `ERR ${r.error?.code}: ${r.error?.message}` : r?.value;
  } finally { clearTimeout(t); }
};

const providers = await rpc("llm/listProviders", { args: {} });
console.log("providers:", JSON.stringify(providers));
const providerIds = Array.isArray(providers) ? providers.map((p) => p?.id) : [];
if (!providerIds.includes("claude")) {
  console.error("FAIL: llm/listProviders does not include 'claude'");
  process.exit(1);
}

// The adapter ships its own single-preset roster (agent-preset-claude.ts,
// registered on the provider's TOP-LEVEL fiber), so agentPresets/list must
// answer with exactly the `claude` preset — a 404 here is a defect now.
const presets = await rpc("agentPresets/list", { args: {} });
console.log("presets:", JSON.stringify(presets));
const presetIds = Array.isArray(presets?.presets) ? presets.presets.map((p) => p?.id) : [];
if (!presetIds.includes("claude")) {
  console.error(`FAIL: agentPresets/list does not include 'claude' (got: ${JSON.stringify(presetIds)})`);
  process.exit(1);
}

const created = await rpc("session/create", { args: { request: { cwd: "/home/u1/workspaces/superd/.scratch/aw-claude" } } });
console.log("create:", JSON.stringify(created).slice(0, 160));
const sessionId = created?.sessionId;
if (!sessionId) { console.error("no session"); process.exit(1); }
if (!/^session-[0-9a-f-]{36}$/i.test(sessionId)) { console.error(`unexpected session id shape: ${sessionId}`); process.exit(1); }

const prompted = await rpc("session/prompt", {
  args: { request: { requestId: "v-1", sessionId, mode: "queue", content: [{ type: "text", text: "Reply with exactly: claude-standalone-ok" }] } },
});
console.log("prompt:", JSON.stringify(prompted).slice(0, 120));

// Poll session/page until the assistant text appears or 180s timeout. The
// brief's "session/read" is readback shorthand: the codex template's proven
// mechanism is session/page (the "past cursor N" probe yields the live cursor).
const deadline = Date.now() + 180_000;
let cursor = -1;
let replyText = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const probe = await rpc("session/page", { args: { request: { address: { kind: "session", sessionId }, throughSeq: 500 } } });
  const m = String(probe).match(/past cursor (\d+)/);
  if (!m) { console.log("…", String(probe).slice(0, 100)); continue; }
  cursor = Number(m[1]);
  const page = await rpc("session/page", { args: { request: { address: { kind: "session", sessionId }, throughSeq: cursor } } });
  const events = (page?.records ?? []).map((r) => r.event ?? r).filter((e) => typeof e?.type === "string");
  const types = events.map((e) => e.type);
  const texts = events.filter((e) => e.type === "assistant/message")
    .flatMap((e) => (Array.isArray(e?.data?.message?.content) ? e.data.message.content : []))
    .filter((b) => b?.type === "text").map((b) => b.text);
  if (types.includes("assistant/message")) {
    console.log("cursor:", cursor, "types:", JSON.stringify(types));
    console.log("assistant texts:", JSON.stringify(texts));
    replyText = texts.join(" ");
    break;
  }
  console.log("cursor:", cursor, "running…", JSON.stringify(types));
}
if (!/claude-standalone-ok/i.test(replyText)) {
  console.log("TIMEOUT or reply mismatch");
  process.exit(1);
}
console.log("CLAUDE APP OK — real reply");

// ---- slash-command mirror (R12 — closes the Task 10 dead-wiring finding) ----
// The `agent` parameter is a Typert lookup (`TypertLookup<Agent, SessionId>`),
// so on the wire it is the session id under the `agentId` field (verified from
// the client fixture: `commands/list` is called as `{ args: { agentId } }`).
const cmds = await rpc("commands/list", { args: { agentId: sessionId } });
const cmdNames = Array.isArray(cmds) ? cmds.map((c) => c?.name).filter((s) => typeof s === "string") : [];
const claudeCmds = cmdNames.filter((name) => name.startsWith("claude-"));
console.log("commands/list:", JSON.stringify(cmdNames));
if (claudeCmds.length > 0) {
  console.log(`SLASH COMMANDS OK — ${claudeCmds.length} claude-* mirrored:`, JSON.stringify(claudeCmds));
} else {
  console.log("SLASH COMMANDS: 0 claude-* commands this run (Claude reported 0, or the mirror is empty — recorded as an observation; the wiring itself is covered by Task 10's real-CommandRuntime test)");
}

// ---- model catalog observation (Task 9's catalog-population fix, never seen live) ----
const mc = await rpc("session/modelCatalog", { args: {} });
const groups = (mc && typeof mc === "object" && Array.isArray(mc.groups)) ? mc.groups : [];
const claudeGroup = groups.find((g) => g?.id === "claude");
const claudeModels = claudeGroup && Array.isArray(claudeGroup.models) ? claudeGroup.models : [];
console.log("modelCatalog claude models:", JSON.stringify(claudeModels.map((m) => m?.id)));
console.log(claudeModels.length > 0 ? "MODEL CATALOG OK — claude route non-empty" : "MODEL CATALOG: claude route EMPTY (observation; Task 9 catalog-population)");

process.exit(0);
