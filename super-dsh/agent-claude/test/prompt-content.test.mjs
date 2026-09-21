import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";

const { ClaudeAgent } = await import("../dist/agent.js");
const {
  ClaudeSdkClient,
  setClaudeFactory,
  resetClaudeClientState,
} = await import("../dist/claude-client.js");
const { projectClaudeEvent } = await import("../dist/claude-events.js");

/** Known image bytes; the wire assertion below compares against their base64. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

/** The DSH shape of an attached image: a durable ref, never inline bytes. */
const IMAGE_REF = {
  attachmentId: "att-1",
  mediaType: "image/png",
  bytes: PNG_BYTES.byteLength,
  width: 1,
  height: 1,
};

/**
 * Session stub with the minimal surface the prompt path touches, recording
 * every appended event so a failed turn is observable.
 */
function recordingSession(id) {
  const appended = [];
  const session = {
    id,
    snapshotEvents: () => [],
    requestHeader: () => undefined,
    append: (type, data) => {
      const event = { seq: appended.length, time: Date.now(), type, data };
      appended.push(event);
      return event;
    },
  };
  return { session, appended };
}

/** The `turn/end` appended for the first turn, if any. */
function turnEnd(appended) {
  return appended.find((event) => event.type === "turn/end");
}

/**
 * A REAL ClaudeSdkClient over a fake SDK query. The fake factory drains the
 * streaming-input iterable and records every pushed SDKUserMessage, so the
 * assertion sees exactly the message content that would reach the CLI.
 */
function setupRealClient(pushed) {
  resetClaudeClientState();
  setClaudeFactory((o) => {
    void (async () => {
      for await (const message of o.prompt) pushed.push(message);
    })();
    return {
      interrupt: async () => { },
      setModel: async () => { },
      setPermissionMode: async () => { },
      close: () => { },
      async *[Symbol.asyncIterator]() { await new Promise(() => { }); },
    };
  });
  return new ClaudeSdkClient({
    cwd: "/w",
    claudeSessionId: "11112222-3333-4444-5555-666677778888",
  });
}

/** Capture the adapter's always-on stderr notices for one test body. */
function startStderrCapture() {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  return { lines, restore: () => { process.stderr.write = original; } };
}

async function waitFor(predicate, label) {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * Drive one prompt through a real client and return what was pushed plus the
 * adapter's stderr notices. The agent is disposed before returning.
 */
async function drivePrompt({ ctx, message, sessionId }) {
  const pushed = [];
  const client = setupRealClient(pushed);
  const { session, appended } = recordingSession(sessionId);
  const agent = new ClaudeAgent(ctx, sessionId, {}, session, client);
  const capture = startStderrCapture();
  try {
    agent.prompt(message);
    await waitFor(() => pushed.length > 0, `a pushed prompt (${sessionId})`);
  } finally {
    capture.restore();
    await agent.dispose();
  }
  return {
    content: pushed[0].message.content,
    notices: capture.lines.filter((line) => line.startsWith("agent-claude:")),
    appended,
  };
}

/**
 * Drive one prompt that must produce no push at all, and return the notices
 * plus the recorded session events once the turn has closed.
 */
async function driveEmptyPrompt({ ctx, message, sessionId }) {
  const pushed = [];
  const client = setupRealClient(pushed);
  const { session, appended } = recordingSession(sessionId);
  const agent = new ClaudeAgent(ctx, sessionId, {}, session, client);
  const capture = startStderrCapture();
  try {
    agent.prompt(message);
    await waitFor(() => turnEnd(appended) !== undefined, `a closed turn (${sessionId})`);
    // Grace period: a buggy empty push would land here after the turn closed.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    capture.restore();
    await agent.dispose();
  }
  return {
    pushed,
    appended,
    notices: capture.lines.filter((line) => line.startsWith("agent-claude:")),
  };
}

test("an attached image actually reaches the client as an Anthropic base64 image block", async () => {
  const readRefs = [];
  const ctx = new Context();
  ctx.provide("attachments", {
    readImage: async (ref) => {
      readRefs.push(ref);
      return { ref, data: PNG_BYTES };
    },
  });

  const { content, notices } = await drivePrompt({
    ctx,
    sessionId: "session-image-delivered",
    message: {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", attachment: IMAGE_REF },
      ],
    },
  });

  assert.equal(readRefs.length, 1, "the durable ref must be handed to ctx.attachments.readImage");
  assert.equal(readRefs[0].attachmentId, "att-1");
  assert.equal(readRefs[0].mediaType, "image/png");
  assert.deepEqual(content, [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
  ], "the pushed message content must carry the image with the bytes' exact base64");
  assert.deepEqual(notices, [], "a delivered image must not produce a drop notice");
});

test("a readImage failure is reported loudly and the text still ships", async () => {
  const ctx = new Context();
  ctx.provide("attachments", {
    readImage: async () => { throw new Error("store offline"); },
  });

  const { content, notices } = await drivePrompt({
    ctx,
    sessionId: "session-image-read-failed",
    message: {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", attachment: IMAGE_REF },
      ],
    },
  });

  assert.deepEqual(content, [{ type: "text", text: "look at this" }], "the text must still reach the CLI");
  assert.equal(notices.length, 1, "the failed attachment must be reported exactly once");
  assert.match(notices[0], /1 content block\(s\) not attached to the Claude request/);
  assert.match(notices[0], /att-1/);
  assert.match(notices[0], /store offline/, "the store failure detail must survive into the notice");
});

test("a context with no attachment service reports the image instead of crashing", async () => {
  const { content, notices } = await drivePrompt({
    ctx: new Context(),
    sessionId: "session-image-no-store",
    message: {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", attachment: IMAGE_REF },
      ],
    },
  });

  assert.deepEqual(content, [{ type: "text", text: "look at this" }]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /att-1/);
  assert.match(notices[0], /no attachment service/);
});

test("a malformed image reference is reported, not guessed", async () => {
  const ctx = new Context();
  ctx.provide("attachments", { readImage: async (ref) => ({ ref, data: PNG_BYTES }) });

  const { content, notices } = await drivePrompt({
    ctx,
    sessionId: "session-image-malformed",
    message: {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", attachment: { mediaType: "image/png" } },
      ],
    },
  });

  assert.deepEqual(content, [{ type: "text", text: "look at this" }]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /no attachmentId/);
});

test("consecutive text blocks stay separate blocks and produce no notice", async () => {
  const { content, notices } = await drivePrompt({
    ctx: new Context(),
    sessionId: "session-text-blocks",
    message: {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  });

  assert.deepEqual(content, [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ], "the block shape must survive to the wire, never a newline re-join");
  assert.deepEqual(notices, []);
});

test("a mid-turn steer delivers its image block too, with priority now", async () => {
  const pushed = [];
  const ctx = new Context();
  ctx.provide("attachments", { readImage: async (ref) => ({ ref, data: PNG_BYTES }) });
  const client = setupRealClient(pushed);
  const agent = new ClaudeAgent(ctx, "session-image-steer", {}, recordingSession("session-image-steer").session, client);
  const capture = startStderrCapture();
  try {
    agent.prompt({ id: "m1", role: "user", content: [{ type: "text", text: "first" }] });
    await waitFor(() => pushed.length === 1, "the opening prompt");
    agent.steer({
      id: "m2",
      role: "user",
      content: [
        { type: "text", text: "and this:" },
        { type: "image", attachment: IMAGE_REF },
      ],
    });
    await waitFor(() => pushed.length === 2, "the steered prompt");
  } finally {
    capture.restore();
    await agent.dispose();
  }

  assert.deepEqual(pushed[1].message.content, [
    { type: "text", text: "and this:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
  ], "the busy/steer path must deliver the image as well");
  assert.equal(pushed[1].priority, "now");
  assert.deepEqual(capture.lines.filter((line) => line.startsWith("agent-claude:")), []);
});

test("an all-unresolvable message pushes nothing and fails the turn loudly", async () => {
  const ctx = new Context();
  ctx.provide("attachments", { readImage: async () => { throw new Error("store offline"); } });

  const { pushed, appended, notices } = await driveEmptyPrompt({
    ctx,
    sessionId: "session-empty-unresolvable",
    message: {
      id: "m1",
      role: "user",
      content: [{ type: "image", attachment: IMAGE_REF }],
    },
  });

  assert.deepEqual(pushed, [], "an empty prompt must never be pushed as an empty text block");
  assert.equal(notices.length, 1, "the skip notice must fire before the turn fails");
  assert.match(notices[0], /att-1/);
  assert.match(notices[0], /store offline/);
  const end = turnEnd(appended);
  assert.equal(end.data.reason.kind, "error", "the turn must end as an error, not a blank success");
  assert.match(end.data.reason.error.message, /no attachable content/);
});

test("a message with no mapped content is reported and fails the turn, never silently pushed", async () => {
  const cases = [
    { label: "reasoning-only", content: [{ type: "reasoning", text: "internal thinking" }] },
    { label: "empty content", content: [] },
  ];
  for (const [index, testCase] of cases.entries()) {
    const { pushed, appended, notices } = await driveEmptyPrompt({
      ctx: new Context(),
      sessionId: `session-empty-filtered-${index}`,
      message: { id: "m1", role: "user", content: testCase.content },
    });

    assert.deepEqual(pushed, [], `${testCase.label}: nothing may be pushed`);
    assert.equal(notices.length, 1, `${testCase.label}: the silent-loss path must produce a notice`);
    assert.match(notices[0], /no attachable content/, testCase.label);
    const end = turnEnd(appended);
    assert.equal(end.data.reason.kind, "error", `${testCase.label}: the turn must fail`);
    assert.match(end.data.reason.error.message, /no attachable content/, testCase.label);
  }
});

test("a steer arriving during cold start cannot overtake the opening prompt", async () => {
  const pushed = [];
  const ctx = new Context();
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  ctx.provide("attachments", {
    readImage: async (ref) => {
      reads += 1;
      if (reads === 1) await firstRead;
      return { ref, data: PNG_BYTES };
    },
  });
  const client = setupRealClient(pushed);
  const { session, appended } = recordingSession("session-order");
  const agent = new ClaudeAgent(ctx, "session-order", {}, session, client);
  const capture = startStderrCapture();
  try {
    agent.prompt({
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "opening" },
        { type: "image", attachment: IMAGE_REF },
      ],
    });
    // The opening prompt is now inside the delivery chain, blocked on its
    // prefetch. A steer accepted here (turnOpen is already true) must queue
    // BEHIND it even though its own prefetch would resolve instantly.
    await waitFor(() => reads === 1, "the opening prefetch");
    agent.steer({ id: "m2", role: "user", content: [{ type: "text", text: "steer" }] });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(pushed.length, 0, "the steer must not overtake the blocked opening prompt");

    releaseFirstRead();
    await waitFor(() => pushed.length === 2, "both pushes");
  } finally {
    capture.restore();
    await agent.dispose();
  }

  assert.deepEqual(pushed[0].message.content, [
    { type: "text", text: "opening" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
  ], "the opening prompt must be pushed first");
  assert.deepEqual(pushed[1].message.content, [{ type: "text", text: "steer" }]);
  assert.equal(pushed[1].priority, "now");
  assert.equal(appended.filter((event) => event.type === "turn/start").length, 1);
});

/**
 * A duck-typed client that records every push and exposes the wire listener the
 * agent subscribes to, so a test can run a complete turn without a real CLI.
 * `emit` projects the raw SDK message exactly as `ClaudeSdkClient` does.
 */
function fakeTurnClient() {
  let listener = () => { };
  const pushes = [];
  return {
    pushes,
    on(next) { listener = next; return () => { }; },
    close() { },
    ensureStarted: async () => { },
    setPermissionMode: async () => { },
    supportedModels: async () => [],
    getState: async () => ({ isStreaming: false }),
    spawned: true,
    prompt: async (content) => { pushes.push({ kind: "prompt", content }); },
    followUp: async (content) => { pushes.push({ kind: "followUp", content }); },
    steer: async (content) => { pushes.push({ kind: "steer", content }); },
    emit(event) {
      const wire = projectClaudeEvent(event);
      if (wire === null) return;
      for (const projected of (Array.isArray(wire) ? wire : [wire])) listener(projected);
    },
  };
}


test("a steer with an unresolvable image is dropped without aborting the in-flight turn", async () => {
  const ctx = new Context();
  ctx.provide("attachments", {
    readImage: async () => { throw new Error("store offline"); },
  });
  const client = fakeTurnClient();
  const { session, appended } = recordingSession("session-steer-drop");
  const agent = new ClaudeAgent(ctx, "session-steer-drop", {}, session, client);
  const capture = startStderrCapture();
  try {
    agent.prompt({ id: "m1", role: "user", content: [{ type: "text", text: "opening" }] });
    await waitFor(() => client.pushes.length === 1, "the opening prompt");

    // The turn is in flight; this steer's only block is an image that cannot be read.
    agent.steer({
      id: "m2",
      role: "user",
      content: [{ type: "image", attachment: IMAGE_REF }],
    });
    await waitFor(
      () => capture.lines.some((line) => line.startsWith("agent-claude:")),
      "the steer's skip notice",
    );

    // The original turn now proceeds to completion: assistant reply, then result.
    client.emit({
      type: "assistant",
      session_id: "sdk-1",
      parent_tool_use_id: null,
      uuid: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    });
    client.emit({
      type: "result", subtype: "success", session_id: "sdk-1", is_error: false, num_turns: 1,
      duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], result: "done",
    });
    await waitFor(() => turnEnd(appended) !== undefined, "the turn to close");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    capture.restore();
    await agent.dispose();
  }

  assert.deepEqual(client.pushes.map((push) => push.kind), ["prompt"],
    "the dropped steer must not reach the client");
  const notices = capture.lines.filter((line) => line.startsWith("agent-claude:"));
  assert.equal(notices.length, 1, "the steer's skip must be reported exactly once");
  assert.match(notices[0], /att-1/);
  assert.match(notices[0], /store offline/);
  const end = turnEnd(appended);
  assert.equal(end.data.reason.kind, "completed",
    "the turn the user is watching must complete, not abort");
  const assistant = appended.find((event) => event.type === "assistant/message");
  assert.equal(assistant.data.message.content[0].text, "reply", "the reply must still be observed");
});
