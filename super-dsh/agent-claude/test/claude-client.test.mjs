// agent-claude/test/claude-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/claude-client.js");
const {
  ClaudeSdkClient,
  setClaudeFactory,
  setClaudeExecutableResolver,
  claudeClientRefCount,
  resetClaudeClientState,
} = mod;

// ---------------------------------------------------------------------------
// Fakes + helpers
// ---------------------------------------------------------------------------

function initMessage() {
  return {
    type: "system", subtype: "init", session_id: "sdk-1", cwd: "/w", model: "opus",
    tools: [], slash_commands: [], skills: [], plugins: [], mcp_servers: [],
    claude_code_version: "2.1.261", apiKeySource: "none", output_style: "default",
  };
}

/**
 * A structural ClaudeQueryLike fake. `hang` keeps the stream open forever
 * (the streaming input keeps the CLI alive); `throwError` simulates a fatal
 * stream failure; with both unset the iterator returns, simulating a stream
 * that ends cleanly. `record` receives tagged tuples in arrival order: control
 * calls (`["interrupt"]`, `["setModel", m]`, `["setPermissionMode", m]`,
 * `["close"]`) and — when `prompt` is supplied — every message the fake drains
 * from the streaming-input iterable as `["push", message]`.
 */
function fakeQuery(record, { hang = true, throwError = false, prompt } = {}) {
  return {
    interrupt: async () => { record.push(["interrupt"]); },
    setModel: async (m) => { record.push(["setModel", m]); },
    setPermissionMode: async (m) => { record.push(["setPermissionMode", m]); },
    close: () => { record.push(["close"]); },
    async *[Symbol.asyncIterator]() {
      yield initMessage();
      if (throwError) throw new Error("boom");
      if (prompt) {
        for await (const message of prompt) {
          record.push(["push", message]);
        }
      }
      if (hang) await new Promise(() => { });
    },
  };
}

/** Reset module-level state and install deterministic resolvers for a test. */
function setup() {
  resetClaudeClientState();
  setClaudeExecutableResolver(() => "/home/u1/.local/bin/claude");
}

/** Poll `fn` until it is truthy or the deadline passes. */
async function until(fn, ms = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("condition not met in time");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("construction is zero-IO: no query is created until the first prompt", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(client.spawned, false);
  assert.equal(calls.length, 0, "the factory must not run at construction");
  await client.prompt("hi");
  assert.equal(client.spawned, true);
  assert.equal(calls.length, 1);
  await client.prompt("again");
  assert.equal(calls.length, 1, "the same query is reused across turns");
  client.close();
});

test("the query options pin the host binary, the app home, the session id and declare NO dialogs", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "22222222-2222-4222-8222-222222222222" });
  await client.prompt("hi");
  const options = calls[0].options;
  assert.equal(options.cwd, "/w");
  assert.equal(options.sessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(options.pathToClaudeCodeExecutable, "/home/u1/.local/bin/claude");
  assert.equal("CLAUDE_CONFIG_DIR" in options.env, false, "no home injection — the CLI keeps its native home");
  assert.equal(options.persistSession, true);
  assert.equal("supportedDialogKinds" in options, false, "V1 declares no dialog kinds");
  assert.equal("onUserDialog" in options, false, "V1 wires no user dialog");
  assert.ok(calls[0].prompt[Symbol.asyncIterator], "prompt must be an async iterable (streaming input mode)");
  client.close();
});

test("options.env is a full spread of process.env without CLAUDE_CONFIG_DIR injected", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "55555555-5555-4555-8555-555555555555" });
  await client.prompt("hi");
  const env = calls[0].options.env;
  assert.equal(env.PATH, process.env.PATH, "inherited PATH must survive the env spread");
  assert.equal(env.HOME, process.env.HOME, "inherited HOME must survive the env spread");
  assert.equal("CLAUDE_CONFIG_DIR" in env, false, "no home injection — the CLI keeps its native home");
  client.close();
});

test("resume passes resume instead of sessionId", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", resumeSessionId: "33333333-3333-4333-8333-333333333333" });
  await client.prompt("hi");
  assert.equal(calls[0].options.resume, "33333333-3333-4333-8333-333333333333");
  assert.equal("sessionId" in calls[0].options, false);
  client.close();
});

test("steer/followUp/interrupt/setModel/setPermissionMode reach the query and the refcount tracks instances", async () => {
  setup();
  const calls = [];
  setClaudeFactory(() => fakeQuery(calls));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "44444444-4444-4444-8444-444444444444" });
  assert.equal(claudeClientRefCount(), 1);
  await client.prompt("hi");
  await client.steer("more");
  await client.interrupt();
  await client.setModel("sonnet");
  await client.setPermissionMode("plan");
  client.close();
  assert.deepEqual(calls, [["interrupt"], ["setModel", "sonnet"], ["setPermissionMode", "plan"], ["close"]]);
  assert.equal(claudeClientRefCount(), 0);
});

test("pathToClaudeCodeExecutable defaults to the host binary and honors CLAUDE_EXECUTABLE", async () => {
  resetClaudeClientState();
  const saved = process.env.CLAUDE_EXECUTABLE;

  const defaultCalls = [];
  setClaudeFactory((o) => { defaultCalls.push(o); return fakeQuery([]); });
  delete process.env.CLAUDE_EXECUTABLE;
  try {
    const c1 = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    await c1.prompt("hi");
    assert.equal(defaultCalls[0].options.pathToClaudeCodeExecutable, "/home/u1/.local/bin/claude");
    c1.close();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_EXECUTABLE;
    else process.env.CLAUDE_EXECUTABLE = saved;
  }

  const envCalls = [];
  setClaudeFactory((o) => { envCalls.push(o); return fakeQuery([]); });
  process.env.CLAUDE_EXECUTABLE = "/custom/bin/claude";
  try {
    const c2 = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    await c2.prompt("hi");
    assert.equal(envCalls[0].options.pathToClaudeCodeExecutable, "/custom/bin/claude");
    c2.close();
  } finally {
    delete process.env.CLAUDE_EXECUTABLE;
    if (saved !== undefined) process.env.CLAUDE_EXECUTABLE = saved;
  }
});

test("control calls made before the first prompt are buffered and replayed in order", async () => {
  setup();
  const calls = [];
  setClaudeFactory(() => fakeQuery(calls));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "66666666-6666-4666-8666-666666666666" });
  await client.setModel("opus");
  await client.setPermissionMode("plan");
  await client.interrupt();
  assert.equal(client.spawned, false, "buffering control calls must not spawn the CLI");
  await client.prompt("hi");
  assert.deepEqual(calls, [["setModel", "opus"], ["setPermissionMode", "plan"], ["interrupt"]]);
  client.close();
  assert.deepEqual(calls, [["setModel", "opus"], ["setPermissionMode", "plan"], ["interrupt"], ["close"]]);
});

test("close is idempotent and safe before start; the refcount decrements exactly once", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery(calls); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "77777777-7777-4777-8777-777777777777" });
  assert.equal(claudeClientRefCount(), 1);
  client.close();
  client.close();
  assert.equal(claudeClientRefCount(), 0);
  assert.equal(client.spawned, false);
  assert.equal(calls.length, 0, "close before start must not construct a query");
});

test("prompt/steer/followUp after close throw a clear closed error (not the queue's)", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery(calls); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "88888888-8888-4888-8888-888888888888" });
  await client.prompt("hi");
  client.close();
  await assert.rejects(() => client.prompt("again"), /client is closed/);
  await assert.rejects(() => client.steer("more"), /client is closed/);
  await assert.rejects(() => client.followUp("more"), /client is closed/);
  await assert.rejects(() => client.setModel("x"), /client is closed/);
});

test("the reader loop projects messages, fills threadId, and emits agent_end on termination", async () => {
  setup();
  const events = [];
  setClaudeFactory(() => fakeQuery([], { hang: false }));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "99999999-9999-4999-8999-999999999999" });
  client.on((e) => events.push(e));
  await client.prompt("hi");
  await until(() => client.threadId === "sdk-1" && events.some((e) => e.type === "agent_end"));
  assert.deepEqual(events.map((e) => e.type), ["session_init", "agent_end"]);
  client.close();
});

test("a throwing query stream emits agent_end isError without an unhandled rejection", async () => {
  setup();
  const events = [];
  setClaudeFactory(() => fakeQuery([], { throwError: true }));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  client.on((e) => events.push(e));
  await client.prompt("hi");
  await until(() => events.some((e) => e.type === "agent_end" && e.isError === true));
  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.isError, true);
  assert.match(end.error, /boom/);
  client.close();
});

test("concurrent first prompts construct exactly one query", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  await Promise.all([client.prompt("a"), client.prompt("b")]);
  assert.equal(calls.length, 1, "only one query may be constructed under a race");
  client.close();
});

test("providing both claudeSessionId and resumeSessionId throws", () => {
  setup();
  assert.throws(
    () => new ClaudeSdkClient({
      cwd: "/w",
      claudeSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      resumeSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }),
    /mutually exclusive/,
  );
});

test("steer pushes priority now; prompt/followUp push without priority; the message shape is pinned", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => fakeQuery(calls, { prompt: o.prompt }));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "11112222-3333-4444-5555-666677778888" });
  await client.prompt("hello");
  await client.followUp("mid");
  await client.steer("now!");
  await until(() => calls.filter((c) => c[0] === "push").length === 3);
  client.close();

  const pushes = calls.filter((c) => c[0] === "push").map((c) => c[1]);
  assert.equal(pushes.length, 3);
  const [p1, p2, p3] = pushes;

  // prompt and followUp are plain queued turns; steer carries priority "now".
  assert.equal(p1.priority, undefined, "prompt must push without priority");
  assert.equal(p2.priority, undefined, "followUp must push without priority");
  assert.equal(p3.priority, "now", "steer must push with priority now");

  // Every push is a proper Anthropic content-block shape, not a bare string.
  for (const msg of pushes) {
    assert.ok(Array.isArray(msg.message.content), "message.content must be an array of blocks");
    assert.equal(msg.message.content.length, 1);
    assert.equal(msg.message.content[0].type, "text");
    assert.equal(typeof msg.message.content[0].text, "string");
  }
  assert.equal(p1.message.content[0].text, "hello");
  assert.equal(p2.message.content[0].text, "mid");
  assert.equal(p3.message.content[0].text, "now!");

  // Create client: pushed messages carry the preset session_id and a null parent.
  assert.equal(p1.session_id, "11112222-3333-4444-5555-666677778888");
  assert.equal(p3.session_id, "11112222-3333-4444-5555-666677778888");
  assert.equal(p1.parent_tool_use_id, null);
  assert.equal(p3.parent_tool_use_id, null);
});

test("resume client pushes carry no session_id (the SDK knows the resumed session)", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => fakeQuery(calls, { prompt: o.prompt }));
  const client = new ClaudeSdkClient({ cwd: "/w", resumeSessionId: "33333333-3333-4333-8333-333333333333" });
  await client.prompt("resume me");
  await until(() => calls.some((c) => c[0] === "push"));
  client.close();

  const push = calls.find((c) => c[0] === "push")[1];
  assert.equal("session_id" in push, false, "resume must not tag pushed messages with session_id");
  assert.equal(push.priority, undefined);
  assert.equal(push.parent_tool_use_id, null);
  assert.ok(Array.isArray(push.message.content));
  assert.equal(push.message.content[0].type, "text");
  assert.equal(push.message.content[0].text, "resume me");
});

// T9.6 widening: prompt/followUp/steer accept a string OR an array of
// transcoded Anthropic blocks; the block array rides through unchanged so the
// transcoder's one-block-per-input-block shape reaches the SDK intact.
test("prompt/followUp/steer accept a block array and push it unchanged", async () => {
  setup();
  const calls = [];
  setClaudeFactory((o) => fakeQuery(calls, { prompt: o.prompt }));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "11112222-3333-4444-5555-666677778888" });
  const blocks = [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
  ];
  await client.prompt(blocks);
  await client.followUp(blocks);
  await client.steer(blocks);
  await until(() => calls.filter((c) => c[0] === "push").length === 3);
  client.close();

  const pushes = calls.filter((c) => c[0] === "push").map((c) => c[1]);
  for (const push of pushes) {
    assert.deepEqual(push.message.content, blocks, "the block array must reach the SDK unchanged");
  }
  assert.equal(pushes[2].priority, "now", "steer still carries priority now on the block path");
  assert.equal(pushes[0].priority, undefined);
});
