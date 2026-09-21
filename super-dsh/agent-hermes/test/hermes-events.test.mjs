// Task 2 TDD (RED first): Hermes gateway event → omp wire vocabulary projection.
//
// Fixture input = the Task 1 live capture (test/fixtures/gateway-events.sample.json,
// schema agent-hermes/spike-events@1, meta.turn_captured true). The replay
// helper mirrors the Task 3 client contract for the read-only ProjectionCtx:
// the CLIENT owns {turnOpen, openAssistant} state transitions —
//   message.start (non-null)    → turnOpen = true,  openAssistant = true
//   message.complete (non-null) → turnOpen = false, openAssistant = false
//   error (non-null)            → turnOpen = false
// Hand-built chains cover tool frames (conditional emission — none exist in
// the fixture), failure payloads, interrupted status, reasoning fold, and
// malformed/unknown inputs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectGatewayEvent } from "../dist/hermes-events.js";

const FIXTURE = JSON.parse(
  readFileSync(join(new URL(".", import.meta.url).pathname, "fixtures", "gateway-events.sample.json"), "utf8"),
);

/** Replay the fixture's event frames through the projector with client-owned ctx. */
function replayFixture() {
  const frames = [...Object.values(FIXTURE.preamble), ...Object.values(FIXTURE.turn)]
    .sort((a, b) => a.index - b.index)
    .filter((rec) => rec.frame.method === "event");
  const ctx = { turnOpen: false, openAssistant: false };
  const wire = [];
  for (const rec of frames) {
    const { type, payload } = rec.frame.params;
    const out = projectGatewayEvent(type, payload, ctx);
    if (out !== null) wire.push(...(Array.isArray(out) ? out : [out]));
    // Task 3 client contract: ctx transitions AFTER projecting the frame.
    if (type === "message.start" && out !== null) {
      ctx.turnOpen = true;
      ctx.openAssistant = true;
    } else if (type === "message.complete" && out !== null) {
      ctx.turnOpen = false;
      ctx.openAssistant = false;
    } else if (type === "error" && out !== null) {
      ctx.turnOpen = false;
    }
  }
  return { frames, ctx, wire };
}

test("fixture: live turn projects onto the omp wire vocabulary", () => {
  const { wire } = replayFixture();
  // The captured turn flattens to 9 wire events: the 7-event bracket plus the
  // two `session.title` frames the gateway emitted mid-turn (projected as
  // session_title for the agent's session/title mirror).
  assert.equal(wire.length, 9);
  const [agentStart, turnStart, messageStart, title1, title2, messageUpdate, messageEnd, turnEnd, agentEnd] = wire;
  // session.title frames project (pi wire parity) — the agent mirrors them.
  assert.deepEqual(title1, { type: "session_title", name: "Reply with exactly: ok" });
  assert.deepEqual(title2, { type: "session_title", name: "Reply with exactly ok" });


  // turn-open bracket: message.start (no payload, turn not yet open)
  //   → agent_start + turn_start + message_start(assistant, [])
  assert.deepEqual(agentStart, { type: "agent_start" });
  assert.deepEqual(turnStart, { type: "turn_start" });
  assert.deepEqual(messageStart, { type: "message_start", message: { role: "assistant", content: [] } });

  // message.delta {text:"ok"} → message_update(text_delta) at contentIndex 0
  assert.deepEqual(messageUpdate, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
  });

  // message.complete success → message_end(text) + turn_end(usage) + agent_end.
  // usage rides BOTH message_end.usage (brief table) and turn_end.data.usage
  // (the agent.ts seam — Task 7 port reads it there, codex parity).
  const usage = FIXTURE.turn["11"].frame.params.payload.usage; // the message.complete frame (index 13)
  assert.deepEqual(messageEnd, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    usage,
  });
  assert.deepEqual(turnEnd, { type: "turn_end", data: { usage, status: "complete" } });
  assert.deepEqual(agentEnd, { type: "agent_end" });
});

test("fixture: ignorable frames project to null (session.info, thinking deltas, poller noise)", () => {
  const { frames } = replayFixture();
  const ctx = { turnOpen: true, openAssistant: true };
  const ignorable = frames.filter((rec) => {
    const t = rec.frame.params.type;
    return (
      t !== "message.start" && t !== "message.delta" && t !== "message.complete" &&
      t !== "session.title" // projects as session_title since the 2026-09-17 parity fix
    );
  });
  // gateway.ready (session-less), session.info (running true AND false — the
  // settled pair is the CLIENT's boundary signal, never wire), sessions.changed
  // (sid:"" poller), thinking.delta (incl. empty-string frames).
  // (session.title and todo.updated now project — dedicated tests cover them.)
  assert.ok(ignorable.length >= 10);
  for (const rec of ignorable) {
    const { type, payload } = rec.frame.params;
    assert.equal(projectGatewayEvent(type, payload, ctx), null, `expected null for ${type}`);
  }
});

test("message.complete folds reasoning into a trailing thinking block", () => {
  const usage = { input: 10, output: 5, total: 15, calls: 1 };
  const out = projectGatewayEvent(
    "message.complete",
    { text: "answer", reasoning: "chain of thought", usage, status: "complete" },
    { turnOpen: true, openAssistant: true },
  );
  const [messageEnd, turnEnd, agentEnd] = out;
  assert.deepEqual(messageEnd.message.content, [
    { type: "text", text: "answer" },
    { type: "thinking", thinking: "chain of thought" },
  ]);
  assert.equal(messageEnd.usage, usage); // verbatim hermes usage object
  assert.deepEqual(turnEnd, { type: "turn_end", data: { usage, status: "complete" } });
  assert.deepEqual(agentEnd, { type: "agent_end" });
});

test("message.complete status error → stopReason error triple (partial text preserved)", () => {
  const out = projectGatewayEvent(
    "message.complete",
    { status: "error", error: "provider 500", recoverable: false, partial: "half an answer" },
    { turnOpen: true, openAssistant: true },
  );
  const [messageEnd, turnEnd, agentEnd] = out;
  assert.deepEqual(messageEnd, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "half an answer" }],
      stopReason: "error",
      errorMessage: "provider 500",
    },
  });
  assert.deepEqual(turnEnd, { type: "turn_end", data: { status: "error" } });
  assert.deepEqual(agentEnd, { type: "agent_end" });
});

test("message.complete status interrupted → plain message_end + terminal pair", () => {
  const out = projectGatewayEvent(
    "message.complete",
    { text: "partial", status: "interrupted" },
    { turnOpen: true, openAssistant: true },
  );
  const [messageEnd, turnEnd, agentEnd] = out;
  assert.deepEqual(messageEnd.message, { role: "assistant", content: [{ type: "text", text: "partial" }] });
  assert.equal(messageEnd.message.stopReason, undefined);
  assert.deepEqual(turnEnd, { type: "turn_end", data: { status: "interrupted" } });
  assert.deepEqual(agentEnd, { type: "agent_end" });
});

test("thinking.delta (incl. empty text) and reasoning.delta emit no wire", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  assert.equal(projectGatewayEvent("thinking.delta", { text: "( •_•)>⌐■-■ analyzing..." }, ctx), null);
  assert.equal(projectGatewayEvent("thinking.delta", { text: "" }, ctx), null);
  assert.equal(projectGatewayEvent("thinking.delta", undefined, ctx), null);
  assert.equal(projectGatewayEvent("reasoning.delta", { text: "because", verbose: true }, ctx), null);
  assert.equal(projectGatewayEvent("reasoning.delta", { text: "" }, ctx), null);
});

test("tool.start → tool_execution_start (id field is tool_id; args/args_text optional)", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  // full shape (Task 1 §3④): args object present
  assert.deepEqual(
    projectGatewayEvent("tool.start", { tool_id: "t1", name: "read_file", context: "read_file /x", args: { path: "/x" } }, ctx),
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: { path: "/x" }, argumentsJson: '{"path":"/x"}' },
  );
  // args omitted (gateway omits when empty) → {} / "{}"
  assert.deepEqual(
    projectGatewayEvent("tool.start", { tool_id: "t2", name: "terminal", context: "terminal npm t" }, ctx),
    { type: "tool_execution_start", toolCallId: "t2", toolName: "terminal", args: {}, argumentsJson: "{}" },
  );
  // verbose args_text wins as the raw JSON string (codex mcp parity)
  assert.deepEqual(
    projectGatewayEvent("tool.start", { tool_id: "t3", name: "web_search", args: { q: 1 }, args_text: '{"q": 1}' }, ctx),
    { type: "tool_execution_start", toolCallId: "t3", toolName: "web_search", args: { q: 1 }, argumentsJson: '{"q": 1}' },
  );
});

test("tool.complete → tool_execution_end (result rendered, duration carried, isError false)", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  // parsed-JSON object result → pretty JSON text block
  const object = projectGatewayEvent(
    "tool.complete",
    { tool_id: "t1", name: "read_file", args: { path: "/x" }, result: { ok: true, content: "hi" }, duration_s: 1.5 },
    ctx,
  );
  assert.deepEqual(object, {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read_file",
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, content: "hi" }, null, 2) }], isError: false },
    isError: false,
    duration_s: 1.5,
  });
  // raw-string result (json.loads failed) → verbatim text block
  const raw = projectGatewayEvent(
    "tool.complete",
    { tool_id: "t2", name: "terminal", args: { cmd: "ls" }, result: "total 0\n" },
    ctx,
  );
  assert.deepEqual(raw.result.content, [{ type: "text", text: "total 0\n" }]);
  assert.equal(raw.isError, false);
  // result absent → summary fallback
  const summary = projectGatewayEvent(
    "tool.complete",
    { tool_id: "t3", name: "web_search", args: {}, summary: "3 results" },
    ctx,
  );
  assert.deepEqual(summary.result.content, [{ type: "text", text: "3 results" }]);
  assert.equal(summary.duration_s, undefined);
});

test("conditional tool emission: mid-turn tool frames sit between message_start and the terminal triple", () => {
  // Synthesized chain per Task 1 §3④ shapes (no tool frames exist in the live
  // fixture — their absence there is by design, so the pair is built by hand).
  const ctx = { turnOpen: true, openAssistant: true };
  const wire = [
    projectGatewayEvent("message.start", undefined, { turnOpen: false, openAssistant: false }),
    projectGatewayEvent("message.delta", { text: "let me check " }, ctx),
    projectGatewayEvent("tool.start", { tool_id: "t1", name: "read_file", context: "read_file /x", args: { path: "/x" } }, ctx),
    projectGatewayEvent("message.delta", { text: "done" }, ctx),
    projectGatewayEvent("tool.complete", { tool_id: "t1", name: "read_file", args: { path: "/x" }, result: "ok", duration_s: 0.2 }, ctx),
    projectGatewayEvent("message.complete", { text: "checked", usage: { input: 1, output: 1, total: 2, calls: 1 }, status: "complete" }, ctx),
  ].flat();
  assert.deepEqual(wire.map((e) => e.type), [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "tool_execution_start",
    "message_update",
    "tool_execution_end",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
});

test("error gateway event → agent_end only while a turn is open", () => {
  const open = projectGatewayEvent("error", { message: "agent init failed" }, { turnOpen: true, openAssistant: true });
  assert.deepEqual(open, { type: "agent_end", data: { error: { message: "agent init failed" } } });
  // no open turn → nothing to close
  assert.equal(projectGatewayEvent("error", { message: "late error" }, { turnOpen: false, openAssistant: false }), null);
});

test("message.delta without an open assistant window heals with a message_start", () => {
  const out = projectGatewayEvent("message.delta", { text: "orphan" }, { turnOpen: true, openAssistant: false });
  assert.deepEqual(out, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphan" } },
  ]);
  // duplicate message.start while the turn is open → bare message_start
  assert.deepEqual(
    projectGatewayEvent("message.start", undefined, { turnOpen: true, openAssistant: true }),
    { type: "message_start", message: { role: "assistant", content: [] } },
  );
});

test("unknown / log-only gateway events → null", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  const unknown = [
    "session.info",   // running true/false — client-side settle signal, never wire
    "session.usage",
    "status.update",
    "approval.request", // request-response surface, never projected (Task 3/7)
    "sessions.changed",
    "gateway.ready",
    "message.interim",
    "mystery.event",
    // session.title and todo.updated project since the 2026-09-17 parity fix
    // (session_title / todo_updated) — covered by the dedicated tests below.
  ];
  for (const type of unknown) {
    assert.equal(projectGatewayEvent(type, { some: "payload" }, ctx), null, `expected null for ${type}`);
  }
});

// ---- 2026-09-17 parity: session.title + todo.updated projections ----

test("session.title → session_title (pi wire parity); empty/missing titles stay null", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  assert.deepEqual(
    projectGatewayEvent("session.title", { session_id: "20260917_052347_799f19", title: "Reply with exactly: ok" }, ctx),
    { type: "session_title", name: "Reply with exactly: ok" },
  );
  // empty-string title, missing title, malformed payload → null
  assert.equal(projectGatewayEvent("session.title", { session_id: "s", title: "" }, ctx), null);
  assert.equal(projectGatewayEvent("session.title", { session_id: "s" }, ctx), null);
  assert.equal(projectGatewayEvent("session.title", null, ctx), null);
  assert.equal(projectGatewayEvent("session.title", "nope", ctx), null);
});

test("todo.updated → todo_updated with DSH-shaped items (whole-list snapshot)", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  const out = projectGatewayEvent(
    "todo.updated",
    {
      todos: [
        { id: "1", content: "  read the plan ", status: "in_progress" },
        { id: "2", content: "write tests", status: "pending" },
        { id: "3", content: "done item", status: "completed" },
        // gateway `cancelled` has no DSH status → dropped
        { id: "4", content: "cancelled item", status: "cancelled" },
        // duplicate content (post-trim) → dropped (todo/write invariant)
        { id: "5", content: "write tests", status: "pending" },
        // blank content → dropped
        { id: "6", content: "   ", status: "pending" },
        // malformed entries → dropped
        null,
        42,
        { content: "no status", status: "yes" },
      ],
      revision: 3,
    },
    ctx,
  );
  assert.deepEqual(out, {
    type: "todo_updated",
    todos: [
      { content: "read the plan", status: "in_progress" },
      { content: "write tests", status: "pending" },
      { content: "done item", status: "completed" },
    ],
  });
  // A well-formed EMPTY list passes through — a real clear (gateway revision ≥ 1).
  assert.deepEqual(projectGatewayEvent("todo.updated", { todos: [], revision: 1 }, ctx), {
    type: "todo_updated",
    todos: [],
  });
  // malformed payloads → null
  assert.equal(projectGatewayEvent("todo.updated", null, ctx), null);
  assert.equal(projectGatewayEvent("todo.updated", { todos: "nope" }, ctx), null);
  assert.equal(projectGatewayEvent("todo.updated", 42, ctx), null);
});


test("malformed inputs → null or fail-soft, never throws", () => {
  const ctx = { turnOpen: true, openAssistant: true };
  // non-record payloads on payload-requiring events → null
  assert.equal(projectGatewayEvent("message.complete", null, ctx), null);
  assert.equal(projectGatewayEvent("message.complete", 42, ctx), null);
  assert.equal(projectGatewayEvent("message.delta", "text", ctx), null);
  assert.equal(projectGatewayEvent("tool.start", null, ctx), null);
  assert.equal(projectGatewayEvent("tool.complete", null, ctx), null);
  assert.equal(projectGatewayEvent("error", null, ctx), null);
  // non-string type → null
  assert.equal(projectGatewayEvent(undefined, {}, ctx), null);
  // empty-record message.complete still yields the well-formed terminal triple
  const out = projectGatewayEvent("message.complete", {}, ctx);
  assert.ok(Array.isArray(out) && out.length === 3);
  assert.equal(out[0].type, "message_end");
  assert.deepEqual(out[0].message.content, [{ type: "text", text: "" }]);
  assert.equal(out[1].type, "turn_end"); // no usage, no status → bare
  assert.equal(out[2].type, "agent_end");
  // everything above must not have thrown
  assert.ok(true);
});
