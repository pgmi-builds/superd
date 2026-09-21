// agent-claude/test/interaction.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { makeCanUseTool, answerAskUserQuestion, askPlanReview } = await import("../dist/interaction.js");

test("a tool permission maps onto ctx.approval and its four outcomes", async () => {
  const seen = [];
  const approval = { request: async (req) => { seen.push(req); return "allowed-once"; } };
  const canUseTool = makeCanUseTool({ approval, agent: { id: "a1" } });
  const allowed = await canUseTool("Bash", { command: "ls" }, { toolUseID: "c1", signal: new AbortController().signal });
  assert.equal(allowed.behavior, "allow");
  assert.equal(seen[0].toolName, "Bash");
  assert.equal(seen[0].callId, "c1");
});

test("rejected/cancelled/unavailable all fail closed as deny", async () => {
  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    const approval = { request: async () => outcome };
    const canUseTool = makeCanUseTool({ approval, agent: { id: "a1" } });
    const res = await canUseTool("Bash", {}, { toolUseID: "c1", signal: new AbortController().signal });
    assert.equal(res.behavior, "deny", `${outcome} must deny`);
    assert.match(res.message, /denied/);
  }
});

test("AskUserQuestion answers travel back as updatedInput.answers", async () => {
  const asked = [];
  const questions = { ask: async (req) => { asked.push(req); return { answers: [{ id: "q0", selected: ["Yes"], custom: "note" }] }; } };
  const res = await answerAskUserQuestion({ questions, agent: { id: "a1" } }, {
    questions: [{ question: "Proceed?", header: "Confirm", multiSelect: false, options: [{ label: "Yes", description: "go" }, { label: "No" }] }],
  }, new AbortController().signal);
  assert.equal(res.behavior, "allow");
  assert.deepEqual(asked[0].questions[0].options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(asked[0].questions[0].multiSelect, false);
  assert.equal("multi_select" in asked[0].questions[0], false);
  assert.deepEqual(res.updatedInput.answers, { "Proceed?": "Yes, note" });
});

test("plan review asks through the SAME seam with the plan-review intent", async () => {
  const asked = [];
  const questions = { ask: async (req) => { asked.push(req); return { answers: [{ id: "plan", selected: ["Approve"] }] }; } };
  const approved = await askPlanReview({ questions, agent: { id: "a1" } }, "# plan", new AbortController().signal);
  assert.equal(approved, true);
  assert.deepEqual(asked[0].questions[0].intent, { kind: "plan-review", approve: "Approve" });
  assert.equal(asked[0].questions[0].detail, "# plan");
});

// --- pins added by the implementer (self-review targets, not brief tests) ----

const signal = () => new AbortController().signal;

test("a rejected approval promise fails closed instead of propagating", async () => {
  const approval = { request: async () => { throw new Error("no open turn"); } };
  const canUseTool = makeCanUseTool({ approval, agent: { id: "a1" } });
  const res = await canUseTool("Bash", {}, { toolUseID: "c1", signal: signal() });
  assert.equal(res.behavior, "deny");
  assert.match(res.message, /denied/);
  assert.match(res.message, /no open turn/);
  // A rogue non-vocabulary outcome must never open the gate either.
  const rogue = await makeCanUseTool({ approval: { request: async () => "allow" }, agent: {} })("Bash", {}, { toolUseID: "c2", signal: signal() });
  assert.equal(rogue.behavior, "deny");
  assert.match(rogue.message, /denied/);
});

test("a missing or empty Claude question batch is denied, not crashed on", async () => {
  let asked = 0;
  const questions = { ask: async () => { asked += 1; return { answers: [] }; } };
  for (const input of [{}, { questions: [] }, { questions: "nope" }]) {
    const res = await answerAskUserQuestion({ questions, agent: {} }, input, signal());
    assert.equal(res.behavior, "deny");
    assert.match(res.message, /denied/);
  }
  assert.equal(asked, 0);
});

test("a rejected ask() fails closed as deny and as an unapproved plan", async () => {
  const questions = { ask: async () => { throw new Error("ASK_ABORTED"); } };
  const res = await answerAskUserQuestion({ questions, agent: {} }, { questions: [{ question: "Proceed?" }] }, signal());
  assert.equal(res.behavior, "deny");
  assert.match(res.message, /denied/);
  assert.match(res.message, /ASK_ABORTED/);
  assert.equal(await askPlanReview({ questions, agent: {} }, "# plan", signal()), false);
});

test("a question with no options is still asked, and the answers map is keyed by question text", async () => {
  const asked = [];
  const questions = {
    ask: async (req) => {
      asked.push(req);
      return { answers: [{ id: "q0", selected: ["First"] }, { id: "q1", selected: [], custom: "typed" }] };
    },
  };
  const res = await answerAskUserQuestion({ questions, agent: {} }, {
    questions: [
      { question: "Question A?", multiSelect: true, options: [{ label: "First", description: "d", preview: "p" }, { label: "Second" }] },
      { question: "Question B?" },
    ],
  }, signal());
  assert.equal(res.behavior, "allow");
  assert.equal(asked[0].questions[0].id, "q0");
  assert.equal(asked[0].questions[0].multiSelect, true);
  // The service contract's spelling is the only one emitted; see the module doc.
  assert.equal("multi_select" in asked[0].questions[0], false);
  assert.equal("preview" in asked[0].questions[0].options[0], false);
  assert.equal("options" in asked[0].questions[1], false);
  assert.deepEqual(Object.keys(res.updatedInput.answers), ["Question A?", "Question B?"]);
  assert.deepEqual(res.updatedInput.answers, { "Question A?": "First", "Question B?": "typed" });
});

test("the custom-answer suffix never leaves a stray or doubled comma", async () => {
  const encode = async (selected, custom) => {
    const questions = { ask: async () => ({ answers: [{ id: "q0", selected, ...(custom === undefined ? {} : { custom }) }] }) };
    const res = await answerAskUserQuestion({ questions, agent: {} }, { questions: [{ question: "Q?" }] }, signal());
    assert.equal(res.behavior, "allow");
    return res.updatedInput.answers["Q?"];
  };
  assert.equal(await encode(["A", "B"], undefined), "A, B");
  assert.equal(await encode(["A"], ""), "A");
  assert.equal(await encode(["A"], "  "), "A");
  assert.equal(await encode([], "note"), "note");
  assert.equal(await encode([], undefined), "");
});

test("a skipping plan, a malformed answer batch and a decline all return false", async () => {
  const declining = { ask: async () => ({ answers: [{ id: "plan", selected: ["Keep planning"] }] }) };
  assert.equal(await askPlanReview({ questions: declining, agent: {} }, "# plan", signal()), false);
  const malformed = { ask: async () => ({ answers: [{ id: "plan", selected: "Approve" }] }) };
  assert.equal(await askPlanReview({ questions: malformed, agent: {} }, "# plan", signal()), false);
  const empty = { ask: async () => ({ answers: [] }) };
  assert.equal(await askPlanReview({ questions: empty, agent: {} }, "# plan", signal()), false);
  // A batch that does not cover the asked questions 1:1 never approves.
  const extra = { ask: async () => ({ answers: [{ id: "other", selected: ["Approve"] }, { id: "more", selected: ["Approve"] }] }) };
  assert.equal(await askPlanReview({ questions: extra, agent: {} }, "# plan", signal()), false);
});

test("answers resolve by id only: a reordered own batch pairs correctly, a foreign batch fails closed", async () => {
  // Same-length but reordered: ids are the only proof of ownership, so this
  // still pairs each question with ITS answer (a positional read would not).
  const reordered = { ask: async () => ({ answers: [
    { id: "q1", selected: ["B"] },
    { id: "q0", selected: ["A"] },
  ] }) };
  const paired = await answerAskUserQuestion({ questions: reordered, agent: {} }, {
    questions: [{ question: "A?" }, { question: "B?" }],
  }, signal());
  assert.equal(paired.behavior, "allow");
  assert.deepEqual(paired.updatedInput.answers, { "A?": "A", "B?": "B" });

  // Same length, foreign ids: no positional fallback exists, so this denies
  // rather than silently feeding Claude somebody else's answer.
  const foreign = { ask: async () => ({ answers: [
    { id: "x1", selected: ["B"] },
    { id: "x0", selected: ["A"] },
  ] }) };
  const deniedRes = await answerAskUserQuestion({ questions: foreign, agent: {} }, {
    questions: [{ question: "A?" }, { question: "B?" }],
  }, signal());
  assert.equal(deniedRes.behavior, "deny");
  assert.match(deniedRes.message, /denied/);

  // One question, one same-length answer under a foreign id: also denied.
  const oneForeign = { ask: async () => ({ answers: [{ id: "q1", selected: ["Yes"] }] }) };
  const single = await answerAskUserQuestion({ questions: oneForeign, agent: {} }, { questions: [{ question: "Proceed?" }] }, signal());
  assert.equal(single.behavior, "deny");
  assert.match(single.message, /denied/);
  assert.equal(await askPlanReview({ questions: oneForeign, agent: {} }, "# plan", signal()), false);
});
