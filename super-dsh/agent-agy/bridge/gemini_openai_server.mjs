#!/usr/bin/env node
/**
 * gemini_openai_server.mjs — SPIKE: minimal Gemini-protocol front → OpenAI
 * chat/completions back. Enough surface for the google-antigravity SDK's
 * generateContent path: text messages, system instruction, SSE streaming,
 * usage passthrough. Tools / multimodal are NOT translated (spike scope).
 *
 * Usage: node gemini_openai_server.mjs <listenPort> <openaiBaseUrl> <openaiKey> <openaiModel>
 */
import http from "node:http";

const [port, oaBase, oaKey, oaModel] = process.argv.slice(2);
const UP = `${oaBase.replace(/\/$/, "")}/chat/completions`;

function g2o(req) {
  const messages = [];
  const sys = req.systemInstruction ?? req.system_instruction;
  const sysText = sys ? partsText(sys.parts ?? sys.parts === undefined ? sys.parts ?? [] : []) : "";
  if (sysText) messages.push({ role: "system", content: sysText });
  for (const c of req.contents ?? []) {
    const t = partsText(c.parts ?? []);
    if (t) messages.push({ role: c.role === "model" ? "assistant" : "user", content: t });
  }
  return { model: oaModel, messages, stream: req.__stream === true };
}
function partsText(parts) {
  return (parts ?? []).map((p) => (typeof p === "string" ? p : p.text ?? "")).join("");
}
function o2g(oa, model) {
  return {
    candidates: [{
      content: { role: "model", parts: [{ text: oa.choices?.[0]?.message?.content ?? "" }] },
      finishReason: oa.choices?.[0]?.finish_reason === "length" ? "MAX_TOKENS" : "STOP",
    }],
    usageMetadata: oa.usage
      ? { promptTokenCount: oa.usage.prompt_tokens, candidatesTokenCount: oa.usage.completion_tokens, totalTokenCount: oa.usage.total_tokens }
      : undefined,
    modelVersion: model,
  };
}
async function callUpstream(body) {
  const r = await fetch(UP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${oaKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ models: [{ name: `models/${oaModel}`, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }] }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let raw = "";
  for await (const c of req) raw += c;
  let g; try { g = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  const streaming = url.pathname.includes("streamGenerateContent");
  const body = g2o({ ...g, __stream: streaming });
  try {
    if (!streaming) {
      const oa = await (await callUpstream(body)).json();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(o2g(oa, oa.model)));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const up = await callUpstream(body);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          const oa = JSON.parse(payload);
          const delta = oa.choices?.[0]?.delta?.content ?? "";
          const ev = {
            candidates: [{ content: { role: "model", parts: [{ text: delta }] } }],
          };
          if (oa.usage) ev.usageMetadata = { promptTokenCount: oa.usage.prompt_tokens, candidatesTokenCount: oa.usage.completion_tokens, totalTokenCount: oa.usage.total_tokens };
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      }
      res.end();
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: 502, message: String(e.message ?? e) } }));
  }
});
server.listen(Number(port), "127.0.0.1", () => console.log(`gemini-openai spike on ${port} -> ${oaModel}`));
