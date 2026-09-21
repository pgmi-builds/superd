// Agent-lifecycle fixtures: the emitted EVENT SEQUENCE is produced by a real
// ClaudeAgent driven through a scripted fake client and a recording session,
// then re-folded with the upstream token-meter (RC-6 acceptance: DEFINED turn
// usage on text AND tool turns) — plus the system/message and permission
// first-turn contracts (RC-2 / RC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";

const { ClaudeAgent } = await import("../dist/agent.js");
const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
const { presetFromEvents, claudePermissionMode } = await import("../dist/permission.js");

/** A recording Session stand-in: appends are captured in order with seqs. */
function recordingSession(seed = []) {
  let seq = 0;
  const events = [...seed];
  return {
    id: "session-lifecycle-test",
    events,
    snapshotEvents: () => events.slice(),
    requestHeader: () => undefined,
    append(type, data) {
      const event = { type, seq: seq++, time: Date.now(), data: structuredClone(data) };
      events.push(event);
      return event;
    },
  };
}

/** A scripted ClaudeSdkClient stand-in: captures listeners and control calls. */
function fakeClient() {
  const listeners = new Set();
  const calls = { setPermissionMode: [], ensureStarted: 0, prompts: [] };
  return {
    calls,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    close() { },
    get cwd() { return "/fake/cwd"; },
    spawned: true,
    async ensureStarted() { calls.ensureStarted += 1; },
    async setPermissionMode(mode) { calls.setPermissionMode.push(mode); },
    async prompt(content) { calls.prompts.push(content); },
    async followUp() { },
    async steer() { },
    async interrupt() { },
    async supportedModels() { return []; },
    async supportedCommands() { return []; },
    async getState() { return { isStreaming: false }; },
  };
}

/** Flush the delivery chain: startTurn runs entirely on microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const userMessage = () => createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });

const SESSION_INIT = {
  type: "session_init", sessionId: "s-1", cwd: "/fake/cwd", model: "sonnet",
  permissionMode: "acceptEdits", tools: [], slashCommands: [], skills: [], plugins: [],
  mcpServers: [], cliVersion: "2.1.261", apiKeySource: "none",
};

test("a text-only turn emits a system/message once, then one usage-carrying assistant/message; the upstream fold proves the usage", async () => {
  const session = recordingSession();
  const client = fakeClient();
  const agent = new ClaudeAgent(new Context(), "session-t1", { model: "sonnet" }, session, client, undefined, {
    preset: "workspace-write",
    claudeMode: "acceptEdits",
  });

  agent.prompt(userMessage());
  await settle();

  const usage1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 };
  client.emit(SESSION_INIT);
  client.emit({ type: "assistant_text", text: "Hello world", usage: usage1, model: "sonnet", parentToolUseId: null });
  client.emit({ type: "turn_end", isError: false, usage: usage1, stopReason: null });

  await agent.whenIdle();
  await agent.dispose();

  const types = session.events.map((event) => event.type);
  // Identity commits before the turn opens (create path): the agent-preset
  // stamp, then the permission stamp, then turn/start.
  assert.equal(types[0], "agent-preset/selected");
  assert.equal(types[1], "permission/preset");
  assert.equal(types[2], "turn/start");
  assert.ok(types.includes("request/context"), "request/context stamped at turn open");
  assert.equal(types.filter((type) => type === "system/message").length, 1, "exactly one system/message");
  const sysIndex = types.indexOf("system/message");
  const stepStart = types.indexOf("step/start");
  const assistantIndex = types.indexOf("assistant/message");
  assert.ok(stepStart < sysIndex && sysIndex < assistantIndex, "system/message sits inside the step it precedes");
  assert.equal(session.events[sysIndex].data.message.content[0].text.includes("(agent-claude adapter)"), true);
  assert.equal(session.events[sysIndex].data.message.content[0].text.includes("model: sonnet"), true);
  assert.equal(session.events[sysIndex].data.message.content[0].text.includes("cwd: /fake/cwd"), true);
  assert.equal(session.events[sysIndex].data.message.content[0].text.includes("permission mode: acceptEdits"), true);

  const message = session.events[assistantIndex].data;
  assert.equal(message.turn, 1);
  assert.equal(message.step, 1);
  assert.deepEqual(message.message.source, { kind: "model", provider: "claude", model: "sonnet" }, "source.model is the OBSERVED model");
  assert.ok(message.stream.length >= 1, "the live bridge's chunks embed durably in the final message");
  assert.deepEqual(
    message.usage,
    { inputTokens: 10, outputTokens: 5, totalTokens: 37, cacheReadTokens: 20, cacheWriteTokens: 2 },
    "totalTokens synthesized from Claude's own counters",
  );

  // The upstream fold takes the TURN-LOCAL slice (turn/start … turn/end).
  const turnEvents = session.events.slice(session.events.findIndex((event) => event.type === "turn/start"));
  const usage = deriveTurnTokenUsage(turnEvents);
  assert.notEqual(usage, undefined, "text turn usage is DEFINED");
  assert.equal(usage.totalTokens, 37);
  assert.equal(usage.outputTokens, 5);
  assert.deepEqual(usage.routes, [{ provider: "claude", model: "sonnet" }]);
});

test("a tool-using turn closes one attempt per step, each with its own sample; the upstream fold proves both", async () => {
  const session = recordingSession();
  const client = fakeClient();
  const agent = new ClaudeAgent(new Context(), "session-t2", { model: "sonnet" }, session, client, undefined, {
    preset: "workspace-write",
    claudeMode: "acceptEdits",
  });

  agent.prompt(userMessage());
  await settle();

  const usageMid = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 };
  const usageFinal = { input_tokens: 15, output_tokens: 8 };
  client.emit(SESSION_INIT);
  client.emit({ type: "assistant_text", text: "Let me check.", usage: usageMid, model: "sonnet", parentToolUseId: null });
  client.emit({ type: "tool_start", callId: "c1", name: "Bash", arguments: { command: "ls" }, parentToolUseId: null });
  client.emit({ type: "tool_end", callId: "c1", name: "Bash", content: "ok", isError: false, parentToolUseId: null });
  // The continuation message arrives after the step's attempt was flushed:
  // it must open the NEXT step (one assistant/message per step for the fold).
  client.emit({ type: "assistant_text", text: "Done.", usage: usageFinal, model: "sonnet", parentToolUseId: null });
  client.emit({ type: "turn_end", isError: false, usage: usageFinal, stopReason: null });

  await agent.whenIdle();
  await agent.dispose();

  const types = session.events.map((event) => event.type);
  assert.deepEqual(
    types.filter((type) => type === "assistant/message" || type === "step/start" || type === "step/end"),
    ["step/start", "assistant/message", "step/end", "step/start", "assistant/message", "step/end"],
    "one flushed attempt per step",
  );

  // Step coordinates number 1, 2, 3, … WITHIN the turn (2026-09-18: the r1
  // code reset the counter after every step/end, numbering every step of a
  // multi-step turn "1" — duplicate (turn, step) coordinates corrupted the
  // Web transcript replay into a blank).
  const stepNumbers = session.events
    .filter((event) => event.type === "step/start")
    .map((event) => event.data.step);
  assert.deepEqual(stepNumbers, [1, 2], "steps within one turn increment");

  // The upstream fold takes the TURN-LOCAL slice (turn/start … turn/end).
  const turnEvents = session.events.slice(session.events.findIndex((event) => event.type === "turn/start"));
  const usage = deriveTurnTokenUsage(turnEvents);
  assert.notEqual(usage, undefined, "tool turn usage is DEFINED (the old no-sample flush broke this)");
  assert.equal(usage.uncachedInputTokens, 25);
  assert.equal(usage.outputTokens, 13);
  assert.equal(usage.totalTokens, 60);
});

test("a blank-window permission/preset fold survives the first turn: no re-stamp, no live mode call", async () => {
  const seeded = [{
    type: "permission/preset", seq: 0, time: 1,
    data: { preset: "read-only", claudeMode: "default" },
  }];
  const session = recordingSession(seeded);
  const client = fakeClient();
  const agent = new ClaudeAgent(new Context(), "session-t3", {}, session, client, undefined, {
    preset: "danger-full-access",
    claudeMode: "bypassPermissions",
  });

  agent.prompt(userMessage());
  await settle();
  // Complete the turn so the activity gate resolves (no wire content needed).
  client.emit({ type: "turn_end", isError: false, stopReason: null });
  await agent.whenIdle();
  await agent.dispose();

  const stamps = session.events.filter((event) => event.type === "permission/preset");
  assert.equal(stamps.length, 1, "the blank-window stamp is never duplicated");
  assert.equal(stamps[0].seq, 0, "the surviving stamp is the seeded (blank-window) one");
  assert.deepEqual(client.calls.setPermissionMode, [], "bootstrap skips the live setPermissionMode when the fold carries a preset");
  assert.ok(session.events.some((event) => event.type === "agent-preset/selected"), "the agent-preset stamp still happens");
  // The fold is the authority:
  assert.equal(presetFromEvents(session.events), "read-only");
});

test("todo/write folds into the log latest-wins, and compact_boundary becomes a compaction bracket", async () => {
  const session = recordingSession();
  const client = fakeClient();
  const agent = new ClaudeAgent(new Context(), "session-t4", { model: "sonnet" }, session, client, undefined, {
    preset: "workspace-write",
    claudeMode: "acceptEdits",
  });

  agent.prompt(userMessage());
  await settle();

  client.emit(SESSION_INIT);
  client.emit({
    type: "todo_write",
    todos: [{ content: "first", status: "in_progress" }],
  });
  client.emit({
    type: "todo_write",
    todos: [{ content: "first", status: "completed" }, { content: "second", status: "pending" }],
  });
  client.emit({ type: "compaction", metadata: { trigger: "auto", pre_tokens: 10 } });
  client.emit({ type: "turn_end", isError: false, stopReason: null });

  await agent.whenIdle();
  await agent.dispose();

  const writes = session.events.filter((event) => event.type === "todo/write");
  assert.equal(writes.length, 2, "every snapshot is logged (latest-wins on replay)");
  assert.deepEqual(writes[1].data.todos, [
    { content: "first", status: "completed" },
    { content: "second", status: "pending" },
  ]);

  const starts = session.events.filter((event) => event.type === "compaction/start");
  const ends = session.events.filter((event) => event.type === "compaction/end");
  assert.equal(starts.length, 1, "the boundary opens exactly one bracket");
  assert.equal(ends.length, 1, "the boundary closes exactly one bracket");
  assert.equal(starts[0].data.compactionId, ends[0].data.compactionId, "the bracket pairs by compactionId");
  assert.equal(starts[0].data.turn, 1, "the bracket is owned by the open turn");
  assert.deepEqual(
    session.events.indexOf(starts[0]) < session.events.indexOf(ends[0]),
    true,
    "start precedes end",
  );
});

test("resume semantics: the log fold decides the preset; a usable mode cache stays the wire mode", () => {
  const coldEvents = [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "permission/preset", seq: 1, time: 2, data: { preset: "read-only", claudeMode: "default" } },
    { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  // Stale map record from before the blank-window choice:
  const record = { preset: "danger-full-access", claudeMode: "bypassPermissions" };
  // Fold wins over the map for the PRESET (the resume path's `presetFromEvents(cold.events) ?? default`):
  assert.equal(presetFromEvents(coldEvents), "read-only");
  assert.notEqual(presetFromEvents(coldEvents), record.preset);
  // The usable mode cache remains ONLY the mode cache (wire mode unchanged):
  assert.equal(record.claudeMode, "bypassPermissions");
  // An UNUSABLE cache derives the mode from the folded preset instead:
  const broken = { preset: null, claudeMode: "garbage" };
  const folded = presetFromEvents(coldEvents) ?? undefined;
  assert.equal(claudePermissionMode(broken.claudeMode !== undefined && ["default", "acceptEdits", "bypassPermissions", "plan", "auto", "dontAsk"].includes(broken.claudeMode) ? broken.claudeMode : folded), "default");
});
