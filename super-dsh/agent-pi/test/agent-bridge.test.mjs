// src/agent.ts — PiAgent delta coverage over the codex port: same-event
// usage, session/title mirroring, the compaction bracket, abort/failure turn
// closing, and tool-call/result pairing. Drives the agent through a fake
// client and a recording fake session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";

const { PiAgent } = await import("../dist/agent.js");

/** Recording fake DSH session (the surface PiAgent touches). */
function fakeSession(requestHeaderConfig) {
  const events = [];
  let seq = 0;
  const session = {
    id: "s-test",
    header: {},
    append(type, data, _opts) {
      const event = { type, data, seq: ++seq, time: Date.now() };
      events.push(event);
      return event;
    },
    snapshotEvents() {
      return [...events];
    },
    requestHeader() {
      return requestHeaderConfig === undefined ? undefined : { config: requestHeaderConfig };
    },
  };
  return { session, events };
}

/** Fake client exposing the PiAgent surface with scripted wire events. */
function fakeClient() {
  const listeners = new Set();
  const failures = [];
  const calls = { setModel: [] };
  return {
    listeners,
    failures,
    calls,
    session: undefined,
    emit(event) {
      for (const fn of [...listeners]) fn(event);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onFailure(fn) {
      failures.push(fn);
      return () => { };
    },
    getState() {
      return { isStreaming: false };
    },
    async ensureStarted() { },
    async prompt() {
      return { type: "response", command: "prompt", success: true };
    },
    async followUp() {
      return { type: "response", command: "follow_up", success: true };
    },
    async steer() {
      return { type: "response", command: "steer", success: true };
    },
    async setModel(provider, modelId) {
      calls.setModel.push([provider, modelId]);
      return { type: "response", command: "set_model", success: true };
    },
    async abort() {
      return { type: "response", command: "abort", success: true };
    },
    async compact() {
      return { type: "response", command: "compact", success: true };
    },
    close() { },
  };
}

function makeAgent(runtimeInfo, options = { provider: "pi", model: undefined }, requestHeaderConfig = undefined) {
  const loopCtx = new Context();
  const { session, events } = fakeSession(requestHeaderConfig);
  const client = fakeClient();
  const agent = new PiAgent(loopCtx, "s-test", options, session, client, undefined, runtimeInfo);
  return { agent, client, events };
}

const types = (events) => events.map((e) => e.type);

test("a full prompt turn synthesizes turn/step/user/assistant/tool events with same-event usage", async () => {
  const { agent, client, events } = makeAgent();

  await agent.followup({
    id: "m1",
    content: [{ type: "text", text: "list files" }],
    source: { kind: "user" },
  });
  // wait for the cold-start chain (microtasks)
  await new Promise((r) => setTimeout(r, 10));

  client.emit({ type: "agent_start" });
  client.emit({ type: "turn_start" });
  client.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "here" }],
      model: "kimi-k3",
      provider: "kimi-plan",
      usage: { input: 12, output: 4, cacheRead: 2, reasoning: 1 },
      stopReason: "stop",
    },
  });
  client.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  client.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "out" }] }, isError: false });
  client.emit({ type: "turn_end" });
  client.emit({ type: "agent_end" });

  assert.deepEqual(types(events), [
    "agent-preset/selected",
    "turn/start",
    "user/message",
    "step/start",
    "assistant/message",
    "tool/call",
    "tool/result",
    "step/end",
    "turn/end",
  ]);

  const assistant = events.find((e) => e.type === "assistant/message");
  // usage rides the SAME assistant/message (pi reports it per message)
  assert.deepEqual(assistant.data.usage, { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 });
  assert.equal(assistant.data.message.source.model, "kimi-k3");

  const call = events.find((e) => e.type === "tool/call");
  assert.equal(call.data.name, "bash");
  assert.equal(call.data.arguments, JSON.stringify({ command: "ls" }));
  const result = events.find((e) => e.type === "tool/result");
  assert.equal(result.data.message.content[0].toolCallId, call.data.callId);
  assert.equal(events.find((e) => e.type === "turn/end").data.reason.kind, "completed");
});

test("session titles mirror as provider-sourced session/title events, deduped", async () => {
  const { client, events } = makeAgent();
  client.emit({ type: "session_title", name: "fix-thing" });
  client.emit({ type: "session_title", name: "fix-thing" });
  client.emit({ type: "session_title", name: undefined });

  const titles = events.filter((e) => e.type === "session/title");
  assert.equal(titles.length, 1);
  assert.deepEqual(titles[0].data, {
    title: "fix-thing",
    messageSeqs: [],
    source: { kind: "provider", provider: "pi" },
  });
});

test("compaction brackets open and close with a shared compactionId", async () => {
  const { client, events } = makeAgent();
  client.emit({ type: "compaction_start", reason: "manual" });
  client.emit({ type: "compaction_end", aborted: false });

  const start = events.find((e) => e.type === "compaction/start");
  const end = events.find((e) => e.type === "compaction/end");
  assert.ok(start);
  assert.equal(typeof start.data.compactionId, "string");
  assert.equal(end.data.compactionId, start.data.compactionId);

  // a second bracket gets a fresh id
  client.emit({ type: "compaction_start", reason: "threshold" });
  client.emit({ type: "compaction_end", aborted: true });
  const starts = events.filter((e) => e.type === "compaction/start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[1].data.compactionId, starts[0].data.compactionId);
});

test("cancel closes the open turn as aborted; client failure closes it as error", async () => {
  const { agent, client, events } = makeAgent();
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  client.emit({ type: "agent_start" });
  client.emit({ type: "agent_end" });
  // nothing open — no-op cancel
  agent.cancel({ kind: "user" });
  const before = events.length;

  await agent.followup({ id: "m2", content: [{ type: "text", text: "go again" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  client.emit({ type: "agent_start" });
  agent.cancel({ kind: "user" });
  client.emit({ type: "agent_end" });
  assert.equal(events.length > before, true);
  assert.equal(events.at(-1).type, "turn/end");
  assert.equal(events.at(-1).data.reason.kind, "aborted");
});

test("error stopReason becomes a failed turn (quota wording wins)", async () => {
  const { agent, client, events } = makeAgent();
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  client.emit({ type: "agent_start" });
  client.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "usage limit reached",
    },
  });
  client.emit({ type: "agent_end" });
  const turnEnd = events.filter((e) => e.type === "turn/end").at(-1);
  assert.equal(turnEnd.data.reason.kind, "error");
  assert.equal(turnEnd.data.reason.error.code, "QUOTA");
});

test("model selection threads the real slug pair to client.setModel (options fallback)", async () => {
  const { agent, client } = makeAgent(undefined, { provider: "deepseek", model: "deepseek-v4-pro" });
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(client.calls.setModel, [["deepseek", "deepseek-v4-pro"]]);
});

test("legacy composite stored selection (umbrella pi route) resolves to the real pair", async () => {
  const { agent, client } = makeAgent(
    undefined,
    { provider: "pi", model: undefined },
    { provider: "pi", model: "deepseek/deepseek-v4-pro" },
  );
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(client.calls.setModel, [["deepseek", "deepseek-v4-pro"]]);
});

test("a real-slug selection whose bare id contains slashes is not re-split", async () => {
  const { agent, client } = makeAgent(
    undefined,
    { provider: "pi", model: undefined },
    { provider: "openrouter", model: "deepseek/deepseek-chat" },
  );
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(client.calls.setModel, [["openrouter", "deepseek/deepseek-chat"]]);
});

test("request/context carries the runtime route for the full options pair", async () => {
  const runtimeInfo = {
    systemPrompt: () => "sys",
    routeContext: (preferred) =>
      preferred?.provider && preferred?.model
        ? { provider: preferred.provider, model: preferred.model, contextWindow: 128000 }
        : undefined,
  };
  const { agent, client, events } = makeAgent(runtimeInfo, { provider: "deepseek", model: "v4-pro" });
  await agent.followup({ id: "m1", content: [{ type: "text", text: "go" }], source: { kind: "user" } });
  await new Promise((r) => setTimeout(r, 10));
  client.emit({ type: "agent_start" });
  const context = events.find((e) => e.type === "request/context");
  assert.deepEqual(context.data, { provider: "deepseek", model: "v4-pro", contextWindow: 128000 });
});
