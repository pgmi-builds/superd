import { test } from "node:test";
import assert from "node:assert/strict";

const { claudeSessionIdFromDsh } = await import("../dist/session-id.js");

test("create resolves the Claude session id from the DSH id before anything is spawned", () => {
  const dsh = "session-01a04826-6d1d-701f-adc3-b834dffc82c5";
  assert.equal(claudeSessionIdFromDsh(dsh), "01a04826-6d1d-701f-adc3-b834dffc82c5");
});

test("create fails closed when a DSH id carries no UUID and no mapping exists", () => {
  assert.equal(claudeSessionIdFromDsh("session-1"), undefined);
});

test("resume fails closed when the recorded Claude session is unknown", async () => {
  const { resumeGuard } = await import("../dist/index.js");
  assert.throws(() => resumeGuard({ dshSessionId: "session-1", claudeSessionId: undefined }),
    /no Claude session is recorded/);
  assert.doesNotThrow(() => resumeGuard({
    dshSessionId: "session-1", claudeSessionId: "55555555-5555-4555-8555-555555555555",
  }));
});

// --- pins added by the implementer ---

import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaudeAgent } = await import("../dist/agent.js");
const { ClaudeProvider, resumeGuard, makeClaudeCanUseTool } = await import("../dist/index.js");
const { upsertSession } = await import("../dist/session-map.js");
const { projectClaudeEvent, resetProjectionState } = await import("../dist/claude-events.js");
const { ClaudeSdkClient, setClaudeFactory, resetClaudeClientState } = await import("../dist/claude-client.js");
const { setModelCatalog, readModelCatalog } = await import("../dist/models.js");
test("resumeGuard rejects a null or empty recorded Claude session id", () => {
  assert.throws(() => resumeGuard({ dshSessionId: "session-1", claudeSessionId: null }), /no Claude session is recorded/);
  assert.throws(() => resumeGuard({ dshSessionId: "session-1", claudeSessionId: "" }), /no Claude session is recorded/);
});

/** Project a tool_result and read back the tool name the projection module remembers. */
function toolEndName(callId) {
  const e = projectClaudeEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: "x" }] } });
  return e.name;
}

/** Seed the module-level tool-name map through an assistant tool_use block. */
function seedTool(callId, name) {
  projectClaudeEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name, input: {} }] } });
}

test("resetProjectionState runs at BOTH agent construction and teardown (tool-name leak guard)", async () => {
  const ctx = new Context();
  const fakeClient = { on: () => () => { }, close: () => { } };
  const fakeSession = {
    id: "session-reset",
    snapshotEvents: () => [],
    requestHeader: () => undefined,
    append: () => ({ seq: 0, time: Date.now(), data: {} }),
  };

  seedTool("t1", "Bash");
  assert.equal(toolEndName("t1"), "bash", "sanity: the tool-name map is seeded (normalized)");

  const agent = new ClaudeAgent(ctx, "session-reset", {}, fakeSession, fakeClient);
  assert.equal(toolEndName("t1"), "tool", "construction must reset the projection state");

  seedTool("t1", "Bash");
  await agent.dispose();
  assert.equal(toolEndName("t1"), "tool", "teardown must reset the projection state");
});

/** A stub Context carrying only the services the provider's boot touches. */
function providerContext(home, { persistence = true } = {}) {
  const ctx = new Context();
  ctx.provide("dshHomePath", home);
  ctx.provide("agents", { setFactory() { } });
  if (persistence) {
    ctx.provide("sessionPersistence", {
      open: async () => { throw new Error("stub persistence: open() must not be reached"); },
      create: async () => { throw new Error("stub persistence: create() must not be reached"); },
    });
  }
  return ctx;
}

test("create fails closed when the DSH id carries no UUID (route B is not wired in V1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-provider-"));
  const ctx = providerContext(home);
  const provider = new ClaudeProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-1" }),
    /route B is not wired in V1/,
  );
});

test("create rejects a fork (fork is not wired in V1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-provider-"));
  const ctx = providerContext(home);
  const provider = new ClaudeProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-f47ac10b-58cc-4372-a567-0e02b2c3d479", meta: { parentSession: "session-parent" } }),
    /fork is not wired in V1/,
  );
});

test("create requires session persistence before anything is spawned", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-provider-"));
  const ctx = providerContext(home, { persistence: false });
  const provider = new ClaudeProvider(ctx);
  await assert.rejects(
    () => provider.createAgent(ctx, { sessionId: "session-f47ac10b-58cc-4372-a567-0e02b2c3d479" }),
    /cannot create a Claude session: session persistence is not configured/,
  );
});

test("resume fails closed when the DSH session has no recorded Claude session", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-provider-"));
  const ctx = providerContext(home);
  const provider = new ClaudeProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-unknown" }),
    /no Claude session is recorded for this Dash session id/,
  );
});

test("resume re-validates the recorded cwd and refuses a vanished directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-claude-provider-"));
  upsertSession(home, "session-gone", {
    claudeSessionId: "01a0a5cb-e919-7480-81ee-7dcf758aa0aa",
    claudeMode: "default",
    cwd: join(home, "no-such-directory"),
    createdAt: Date.now(),
    preset: null,
  });
  const ctx = providerContext(home);
  const provider = new ClaudeProvider(ctx);
  await assert.rejects(
    () => provider.resume(ctx, { resumeSessionId: "session-gone" }),
    /its recorded working directory no longer exists/,
  );
});

// --- integration pins (would have caught the dead-wiring defect) ---

/** A fake Claude agent client that captures its event listener. */
function fakeAgentClient({ supportedModels = async () => [] } = {}) {
  let listener = () => { };
  return {
    on(l) { listener = l; return () => { }; },
    close() { },
    supportedModels,
    setPermissionMode: async () => { },
    interrupt: async () => { },
    getState: async () => ({ isStreaming: false }),
    spawned: true,
    get listener() { return listener; },
  };
}

function fakeSession() {
  return {
    id: "session-x",
    snapshotEvents: () => [],
    requestHeader: () => undefined,
    append: () => ({ seq: 0, time: Date.now(), data: {} }),
  };
}

test("makeClaudeCanUseTool routes a tool permission through ctx.approval (allowed-once ⇒ allow, rejected ⇒ deny)", async () => {
  const seen = [];
  const approval = {
    request: async (req) => {
      seen.push(req);
      return req.toolName === "Bash" ? "allowed-once" : "rejected";
    },
  };
  const dispatcher = makeClaudeCanUseTool({ approval, questions: undefined, getAgent: () => undefined });
  const signal = new AbortController().signal;

  const allowed = await dispatcher("Bash", { cmd: "ls" }, { toolUseID: "t1", signal });
  assert.equal(allowed.behavior, "allow");
  assert.equal(seen[0].toolName, "Bash");
  assert.equal(seen[0].callId, "t1");

  const denied = await dispatcher("Read", { path: "/etc/shadow" }, { toolUseID: "t2", signal });
  assert.equal(denied.behavior, "deny");
});

test("AskUserQuestion and ExitPlanMode route through the user-questions seam, not the approval seam", async () => {
  const asked = [];
  const questions = {
    ask: async (req) => {
      asked.push(req);
      // Answer the plan-review question with "Approve".
      return { answers: req.questions.map((q) => ({ id: q.id, selected: ["Approve"], custom: "go" })) };
    },
  };
  const dispatcher = makeClaudeCanUseTool({ approval: undefined, questions, getAgent: () => undefined });
  const signal = new AbortController().signal;

  const answered = await dispatcher("AskUserQuestion", { questions: [{ question: "pick?" }] }, { toolUseID: "q1", signal });
  assert.equal(answered.behavior, "allow");
  assert.ok(answered.updatedInput.answers, "the answer map must be the updatedInput feedback channel");

  const plan = await dispatcher("ExitPlanMode", { plan: "do the thing" }, { toolUseID: "p1", signal });
  assert.equal(plan.behavior, "allow", "an approved plan must allow");
  assert.equal(asked.length, 2);
});

test("a missing seam fails closed (deny), never lets the CLI decide", async () => {
  const dispatcher = makeClaudeCanUseTool({ approval: undefined, questions: undefined, getAgent: () => undefined });
  const signal = new AbortController().signal;
  const tool = await dispatcher("Bash", { cmd: "rm -rf /" }, { toolUseID: "t1", signal });
  assert.equal(tool.behavior, "deny");
  const ask = await dispatcher("AskUserQuestion", {}, { toolUseID: "q1", signal });
  assert.equal(ask.behavior, "deny");
});

test("ExitPlanMode with malformed input fails closed instead of dereferencing null", async () => {
  const asked = [];
  const questions = {
    ask: async (req) => { asked.push(req); return { answers: [] }; },
  };
  const dispatcher = makeClaudeCanUseTool({ approval: undefined, questions, getAgent: () => undefined });
  const signal = new AbortController().signal;

  const cases = [
    ["null input", null],
    ["undefined input", undefined],
    ["missing plan", {}],
    ["non-string plan", { plan: 42 }],
    ["empty plan", { plan: "   " }],
  ];
  for (const [label, input] of cases) {
    const decision = await dispatcher("ExitPlanMode", input, { toolUseID: "p1", signal });
    assert.equal(decision.behavior, "deny", label);
    assert.match(decision.message, /denied/, label);
  }
  assert.deepEqual(asked, [], "malformed input must never reach the questions seam");
});

test("the client buildOptions carries canUseTool and allowDangerouslySkipPermissions to the SDK", async () => {
  resetClaudeClientState();
  const calls = [];
  const dispatcher = makeClaudeCanUseTool({ approval: undefined, questions: undefined, getAgent: () => undefined });
  setClaudeFactory((o) => {
    calls.push(o);
    return {
      interrupt: async () => { },
      setModel: async () => { },
      setPermissionMode: async () => { },
      close: () => { },
      async *[Symbol.asyncIterator]() { await new Promise(() => { }); },
    };
  });
  const client = new ClaudeSdkClient({
    cwd: "/w",
    claudeSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canUseTool: dispatcher,
    allowDangerouslySkipPermissions: true,
  });
  await client.prompt("hi");
  assert.equal(typeof calls[0].options.canUseTool, "function", "canUseTool must reach the SDK options");
  assert.equal(calls[0].options.allowDangerouslySkipPermissions, true);
  client.close();
});

test("the model catalog becomes non-empty after a session_init observation", async () => {
  setModelCatalog([]); // reset module state
  const ctx = new Context();
  const client = fakeAgentClient();
  const agent = new ClaudeAgent(ctx, "session-cat", {}, fakeSession(), client);
  client.listener({
    type: "session_init",
    sessionId: "sdk-1",
    cwd: "/w",
    model: "claude-sonnet-5",
    tools: [], slash_commands: [], skills: [], plugins: [], mcp_servers: [],
  });
  const catalog = readModelCatalog();
  assert.ok(
    catalog.models.some((m) => m.id === "claude-sonnet-5"),
    "the observed model must feed the catalog",
  );
  assert.equal(catalog.defaultModel, "claude-sonnet-5");
  await agent.dispose();
  setModelCatalog([]);
});

test("#registerDefaultModel pushes a claude-routed target through both paths when the selection is foreign", async () => {
  setModelCatalog([]); // force the boot fallback (CLAUDE_DEFAULT_MODEL) path
  const ctx = new Context();
  ctx.provide("dshHomePath", "/tmp/cc-home");
  ctx.provide("agents", { setFactory() { } });
  const saved = [];
  const replaced = [];
  ctx.provide("agentDefaultModel", {
    currentSelection: () => ({ provider: "deepseek", model: "flash" }),
    saveSelection: async (s) => { saved.push(s); },
  });
  ctx.provide("settings", {
    replace: async (ns, v) => { replaced.push([ns, v]); },
  });
  new ClaudeProvider(ctx);
  // Let the inject callback and its .then chain settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    replaced.some(([ns, v]) => ns === "agent-default-model" && v.provider === "claude" && v.model === "sonnet"),
    "settings.replace must carry the claude/sonnet target",
  );
  assert.ok(
    saved.some((s) => s.provider === "claude" && s.model === "sonnet"),
    "saveSelection must carry the claude/sonnet target",
  );
});

test("dispose clears the session-observed slash commands", async () => {
  const ctx = new Context();
  const client = fakeAgentClient();
  const agent = new ClaudeAgent(ctx, "session-cmd-clear", {}, fakeSession(), client);

  // The agent consumes PROJECTED wire events (`slashCommands`), exactly as the
  // real client delivers them after projectClaudeEvent.
  client.listener({
    type: "session_init",
    sessionId: "sdk-1",
    cwd: "/w",
    model: "claude-sonnet-5",
    tools: [],
    slashCommands: ["/mcp", "/review"],
    skills: [],
    plugins: [],
    mcpServers: [],
  });
  // TS `private` is compile-time only, so the field is observable here; it is
  // the only direct guard for "session data does not outlive the session".
  assert.equal(agent.observedSlashCommands.length, 2, "session_init populates the observed commands");

  await agent.dispose();
  assert.deepEqual(agent.observedSlashCommands, [], "dispose must clear session-observed data");
  setModelCatalog([]);
});
