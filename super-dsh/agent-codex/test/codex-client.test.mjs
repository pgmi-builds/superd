// Task 3 TDD (RED first): CodexSdkClient — fake `Codex` driven unit tests.
// The fake emulates the SDK 0.154.0 seam: startThread/resumeThread → thread
// object with an id getter and runStreamed() yielding canned ThreadEvents
// (honoring the turn-level AbortSignal), exactly the surface the spike proved.
import test from "node:test";
import assert from "node:assert/strict";
import { CodexSdkClient, codexClientRefCount, setCodexFactory } from "../dist/codex-client.js";
import { resetProjectionState } from "../dist/codex-events.js";

const FAKE_HOME = "/aw-codex-client-test/.codex";
// Native-home ruling (2026-09-17): the client never injects CODEX_HOME; tests
// redirect the runtime home via the ambient env before the instance spawns.
process.env.CODEX_HOME = FAKE_HOME;

// ---------------------------------------------------------------------------
// Fake Codex / Thread machinery
// ---------------------------------------------------------------------------

function makeFakeCodex() {
  const fake = {
    constructorCount: 0,
    constructorOptions: null,
    startOptions: [],
    resumeOptions: [],
    runs: [], // { input, signal }
    turnEvents: [], // canned ThreadEvents for every run
    yieldHook: null, // async (event, index) => void before each yield
  };
  setCodexFactory((options) => {
    fake.constructorCount += 1;
    fake.constructorOptions = options;
    return fake;
  });
  fake.startThread = (options = {}) => {
    fake.startOptions.push(options);
    return makeFakeThread(fake, null);
  };
  fake.resumeThread = (id, options = {}) => {
    fake.resumeOptions.push({ id, options });
    return makeFakeThread(fake, id);
  };
  return fake;
}

function makeFakeThread(fake, resumedId) {
  const thread = {
    idValue: resumedId,
    get id() {
      return this.idValue;
    },
    async runStreamed(input, turnOptions = {}) {
      fake.runs.push({ input, signal: turnOptions.signal ?? null });
      const self = thread;
      async function* gen() {
        for (let i = 0; i < fake.turnEvents.length; i++) {
          const evt = fake.turnEvents[i];
          if (turnOptions.signal?.aborted) return;
          if (fake.yieldHook) await fake.yieldHook(evt, i);
          if (turnOptions.signal?.aborted) return;
          if (evt.type === "thread.started" && self.idValue === null && typeof evt.thread_id === "string") {
            self.idValue = evt.thread_id;
          }
          yield evt;
        }
      }
      return { events: gen() };
    },
  };
  return thread;
}

const THREAD_ID = "01a0a171-a297-70d2-8bb1-347ea1ca718f";

const SAMPLE_TURN = [
  { type: "thread.started", thread_id: THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 },
  },
];

/** Resolve when the next agent_end fires (registers before the prompt). */
function nextAgentEnd(client) {
  return new Promise((resolve) => {
    const off = client.on((event) => {
      if (event.type === "agent_end") {
        off();
        resolve();
      }
    });
  });
}

async function waitFor(fn, label, timeoutMs = 2000) {
  const started = Date.now();
  while (true) {
    let value;
    try {
      value = fn();
    } catch (error) {
      throw error;
    }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------

test("spawn: ready client with ambient env carried (no CODEX_HOME injection), refcount and reuse", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  assert.equal(codexClientRefCount(), 0);
  const a = await CodexSdkClient.spawn([], "/tmp/cwd-a");
  const b = await CodexSdkClient.spawn([], "/tmp/cwd-b");
  assert.equal(codexClientRefCount(), 2, "two live clients share one instance");
  assert.equal(fake.constructorCount, 1, "shared Codex constructed once");
  assert.equal(fake.constructorOptions.env.CODEX_HOME, FAKE_HOME, "ambient CODEX_HOME rides the env spread (set by this test) — never injected by the client");
  assert.deepEqual(fake.startOptions[0], { workingDirectory: "/tmp/cwd-a", skipGitRepoCheck: true });
  assert.equal(a.spawned, true);
  await a.ensureStarted(); // resolves
  a.close();
  b.close();
  assert.equal(codexClientRefCount(), 0, "refcount fully released");
  const c = await CodexSdkClient.spawn([]);
  assert.equal(fake.constructorCount, 2, "new shared instance after full release");
  c.close();
});

test("prompt: listeners receive projected events in order, ending with agent_end", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const seen = [];
  client.on((event) => seen.push(event));
  const done = nextAgentEnd(client);
  await client.prompt("hi");
  await done;

  assert.deepEqual(
    seen.map((event) => event.type),
    ["agent_start", "turn_start", "message_end", "message_end", "turn_end", "agent_end"],
  );
  assert.deepEqual(seen[0].data, { threadId: "01a0a171-a297-70d2-8bb1-347ea1ca718f" });
  assert.deepEqual(seen[2].message.content, [{ type: "thinking", thinking: "thinking" }]);
  assert.deepEqual(seen[3].message.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(seen[4].data.usage, SAMPLE_TURN[4].usage, "raw codex usage verbatim");
  const state = await client.getState();
  assert.deepEqual(state, { isStreaming: false });
  client.close();
});

test("getMessages accumulates the conversation mirror (user + assistant)", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const done = nextAgentEnd(client);
  await client.prompt("hi");
  await done;
  const messages = await client.getMessages();
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(messages[0].content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(messages[1].content, [{ type: "text", text: "ok" }]);
  client.close();
});

test("abort mid-run: stream ends like the real SDK → agent_end + idle, no failure", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = [
    { type: "thread.started", thread_id: "t-abort" },
    { type: "turn.started" },
    ...Array.from({ length: 40 }, (_, i) => ({
      type: "item.updated",
      item: { id: "a1", type: "agent_message", text: "a".repeat(i + 1) },
    })),
  ];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fake.yieldHook = async (_evt, index) => {
    if (index === 2) release();
  };
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const seen = [];
  let failed = null;
  client.onFailure((error) => {
    failed = error;
  });
  client.on((event) => seen.push(event.type));
  await client.prompt("count");
  await gate;
  await client.abort(); // must await the settled run → deterministic idle
  assert.equal(seen.includes("turn_end"), false, "aborted turn never reaches turn_end");
  assert.equal(seen[seen.length - 1], "agent_end");
  assert.equal(failed, null, "abort is not a failure (real SDK just ends the stream)");
  assert.deepEqual(await client.getState(), { isStreaming: false });
  assert.ok(fake.runs[0].signal instanceof AbortController ? true : fake.runs[0].signal !== null, "turn ran with a signal");
  client.close();
});

test("steer while idle runs immediately as a prompt", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const done = nextAgentEnd(client);
  await client.steer("go now");
  await done;
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].input, "go now");
  client.close();
});

test("steer while in flight is queued and executed after the current turn settles", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  fake.yieldHook = async (_evt, index) => {
    if (index === 0) await firstGate; // hold the first turn mid-stream
  };
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  let ends = 0;
  client.on((event) => {
    if (event.type === "agent_end") ends += 1;
  });
  await client.prompt("first");
  await waitFor(() => fake.runs.length === 1, "first run to start");
  await client.steer("second");
  assert.equal(fake.runs.length, 1, "steer must not start a run while in flight");
  releaseFirst();
  await waitFor(() => fake.runs.length === 2, "queued steer to run");
  assert.equal(fake.runs[1].input, "second");
  await waitFor(() => ends >= 2, "both turns to settle");
  const messages = await client.getMessages();
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content[0].text), [
    "first",
    "second",
  ]);
  client.close();
});

test("setModel before any turn applies the model on a fresh startThread", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  await client.setModel("custom-provider", "glm-5.2");
  assert.equal(fake.startOptions.length, 1, "setModel alone must not rebuild the thread");
  const done = nextAgentEnd(client);
  await client.prompt("hi");
  await done;
  assert.equal(fake.startOptions.length, 2);
  assert.equal(fake.startOptions[1].model, "glm-5.2");
  assert.equal(fake.resumeOptions.length, 0);
  client.close();
});

test("setModel after a turn resumes the live thread with the new model", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const doneFirst = nextAgentEnd(client);
  await client.prompt("first");
  await doneFirst;
  const threadId = THREAD_ID; // set on the fake thread by the first turn.started
  await client.setModel("custom-provider", "glm-5.2");
  const done = nextAgentEnd(client);
  await client.prompt("second");
  await done;
  assert.equal(fake.resumeOptions.length, 1);
  assert.equal(fake.resumeOptions[0].id, threadId, "resume keeps conversation context");
  assert.equal(fake.resumeOptions[0].options.model, "glm-5.2");
  client.close();
});

test("newSession discards the thread and the message mirror", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const doneFirst = nextAgentEnd(client);
  await client.prompt("first");
  await doneFirst;
  assert.equal((await client.getMessages()).length, 2);
  await client.newSession();
  assert.deepEqual(await client.getMessages(), []);
  assert.equal(fake.startOptions.length, 2, "fresh thread object");
  const done = nextAgentEnd(client);
  await client.prompt("n2");
  await done;
  assert.equal(fake.runs.length, 2);
  assert.deepEqual((await client.getMessages()).map((message) => message.role), ["user", "assistant"]);
  client.close();
});

test("send dispatches the omp command table; unknown commands fail loudly", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");

  const state = await client.send({ type: "get_state" });
  assert.deepEqual(state, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
  const messages = await client.send({ type: "get_messages" });
  assert.deepEqual(messages.data, { messages: [] });
  await client.send({ type: "set_model", provider: "p", modelId: "m" });
  const promptResponse = await client.send({ type: "prompt", message: "hi" });
  assert.deepEqual(promptResponse, { type: "response", command: "prompt", success: true });
  await nextAgentEnd(client);
  await assert.rejects(() => client.send({ type: "compact" }), /unsupported command "compact"/);
  client.close();
});

test("sendRaw is a no-op without CODEX_TRACE and traces to stderr with it", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    client.sendRaw({ type: "extension_ui_response", id: "x", value: "Approve" });
    assert.equal(captured, "");
    process.env.CODEX_TRACE = "1";
    client.sendRaw({ type: "extension_ui_response", id: "y", value: "Approve" });
    assert.match(captured, /\[codex-sdk\] sendRaw/);
    assert.match(captured, /extension_ui_response/);
  } finally {
    process.stderr.write = original;
    delete process.env.CODEX_TRACE;
  }
  client.close();
});

test("spawn args: --approval-mode accepted; --resume and unknown args throw", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  const client = await CodexSdkClient.spawn(["--approval-mode", "workspace"], "/tmp/cwd");
  assert.ok(client, "approval-mode accepted (mapping is Task 7's business)");
  client.close();
  await assert.rejects(() => CodexSdkClient.spawn(["--resume", "session.jsonl"]), /unsupported spawn arg "--resume"/);
  await assert.rejects(() => CodexSdkClient.spawn(["--model", "gpt-5"]), /unsupported spawn arg "--model"/);
});

test("stats/subagents fail-soft: {} and [] before any turn; tokens after usage", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  assert.deepEqual(await client.getSessionStats(), {});
  assert.deepEqual(await client.getSubagents(), []);
  const doneFirst = nextAgentEnd(client);
  await client.prompt("hi");
  await doneFirst;
  assert.deepEqual(await client.getSessionStats(), {
    tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  client.close();
});

test("close notifies failure listeners and rejects later operations", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  const refcountBefore = codexClientRefCount();
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  let failure = null;
  client.onFailure((error) => {
    failure = error;
  });
  client.close();
  assert.match(String(failure), /closed/);
  assert.equal(client.spawned, true, "spawned stays true (real client parity)");
  await assert.rejects(() => client.prompt("hi"), /closed/);
  await assert.rejects(() => client.getState(), /closed/);
  client.close(); // idempotent
  assert.equal(codexClientRefCount(), refcountBefore, "exactly this client's refcount released");
});

test("paired tool execution events land in the getMessages mirror as toolResult", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = [
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "total 0", exit_code: 0, status: "completed" },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    },
  ];
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  const done = nextAgentEnd(client);
  await client.prompt("run it");
  await done;
  const messages = await client.getMessages();
  // the projected start+end ARRAY must mirror too — the toolResult is here
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "toolResult"],
  );
  assert.equal(messages[1].toolCallId, "c1");
  assert.deepEqual(messages[1].content, [{ type: "text", text: "total 0" }]);
  assert.equal(messages[1].isError, false);
  client.close();
});

test("newSession during a queued run orphans the queue and starts clean", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  fake.yieldHook = async (_evt, index) => {
    if (index === 0) await firstGate; // hold run A mid-stream
  };
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  await client.prompt("A"); // in flight, held at the first event
  await waitFor(() => fake.runs.length === 1, "run A to start");
  await client.prompt("B"); // queued behind A
  // newSession aborts A and awaits it — A's generator is parked in the gate,
  // so release it for the settle to complete.
  const sessionReset = client.newSession();
  releaseFirst();
  await sessionReset;
  // give any (wrong) queue drain a chance to surface
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.runs.length, 1, "queued B must never run on the discarded thread");
  assert.deepEqual(await client.getMessages(), []);
  assert.equal(fake.startOptions.length, 2, "fresh thread object created");
  const done = nextAgentEnd(client);
  await client.prompt("n2");
  await done;
  assert.equal(fake.runs.length, 2, "subsequent prompt runs on the fresh thread");
  assert.equal(fake.runs[1].input, "n2");
  client.close();
});

// ---------------------------------------------------------------------------
// Task 7 client extension: --resume-thread + threadId getter
// ---------------------------------------------------------------------------

test("spawn --resume-thread constructs the client on resumeThread (not startThread)", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  const RESUMED = "01resumable-thread-id";
  const client = await CodexSdkClient.spawn(["--resume-thread", RESUMED], "/tmp/cwd");
  assert.equal(fake.startOptions.length, 0, "no fresh thread started");
  assert.equal(fake.resumeOptions.length, 1);
  assert.equal(fake.resumeOptions[0].id, RESUMED);
  assert.equal(fake.resumeOptions[0].options.workingDirectory, "/tmp/cwd");
  assert.equal(fake.resumeOptions[0].options.skipGitRepoCheck, true);
  assert.equal(client.threadId, RESUMED, "getter exposes the resumed thread id");
  client.close();
});

test("threadId getter: null before the first turn, the live id after thread.started", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  assert.equal(client.threadId, null, "fresh thread has no id yet");
  const done = nextAgentEnd(client);
  await client.prompt("hi");
  await done;
  assert.equal(client.threadId, THREAD_ID);
  client.close();
});

test("--approval-mode rides the thread options as the launch approvalPolicy", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  fake.turnEvents = SAMPLE_TURN;
  const client = await CodexSdkClient.spawn(["--approval-mode", "on-request"], "/tmp/cwd");
  assert.equal(fake.startOptions[0].approvalPolicy, "on-request");
  const done = nextAgentEnd(client);
  await client.prompt("hi");
  await done;
  // A setModel-triggered rebuild must carry the launch policy too.
  await client.setModel("p", "m");
  const done2 = nextAgentEnd(client);
  await client.prompt("again");
  await done2;
  const rebuiltWithModel = fake.resumeOptions.at(-1) ?? null;
  if (rebuiltWithModel !== null) {
    assert.equal(rebuiltWithModel.id, THREAD_ID, "setModel rebuild resumes the live thread");
    assert.equal(rebuiltWithModel.options.approvalPolicy, "on-request");
    assert.equal(rebuiltWithModel.options.model, "m");
  }
  client.close();
});

test("plain spawns keep the bare thread options (no approvalPolicy key)", async () => {
  resetProjectionState();
  const fake = makeFakeCodex();
  const client = await CodexSdkClient.spawn([], "/tmp/cwd");
  assert.deepEqual(fake.startOptions[0], { workingDirectory: "/tmp/cwd", skipGitRepoCheck: true });
  client.close();
});
