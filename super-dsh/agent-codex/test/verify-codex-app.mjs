// Standalone codex app verification: no selector, no hub — just the app's
// own wire. create → prompt → ride the cursor to the real reply.
import { readFileSync } from "node:fs";

const jar = readFileSync(process.env.AW_JAR ?? "/tmp/aw-codex-app.jar", "utf8");
const line = jar.split("\n").filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).pop();
const cookie = line.split("\t").slice(-2).join("=");
const base = process.env.AW_BASE ?? "http://192.168.31.130:4989";
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

console.log("providers:", JSON.stringify(await rpc("llm/listProviders", { args: {} })));
console.log("presets:", JSON.stringify(await rpc("agentPresets/list", { args: {} })).slice(0, 160));

const created = await rpc("session/create", { args: { request: { cwd: "/home/u1/workspaces/superd/.scratch/aw-codex" } } });
console.log("create:", JSON.stringify(created).slice(0, 160));
const sessionId = created?.sessionId;
if (!sessionId) { console.error("no session"); process.exit(1); }

const prompted = await rpc("session/prompt", {
  args: { request: { requestId: "v-1", sessionId, mode: "queue", content: [{ type: "text", text: "Reply with exactly: standalone-ok" }] } },
});
console.log("prompt:", JSON.stringify(prompted).slice(0, 120));

const deadline = Date.now() + 180_000;
let cursor = -1;
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
    console.log(/standalone-ok/i.test(texts.join(" ")) ? "STANDALONE APP OK — real reply" : "reply mismatch");
    process.exit(0);
  }
  console.log("cursor:", cursor, "running…", JSON.stringify(types));
}
console.log("TIMEOUT");
process.exit(1);
