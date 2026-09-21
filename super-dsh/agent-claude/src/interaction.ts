/**
 * The interaction bridge (plan Task 8): Claude Code's three human-interaction
 * callbacks mapped onto DSH's two native human-interaction seams.
 *
 * Claude Code routes every human decision through exactly three SDK callbacks —
 * `canUseTool` (tool permission), the `AskUserQuestion` tool, and
 * `ExitPlanMode` (plan approval) — while DSH exposes exactly two native
 * interaction waterfalls and **no generic extension-UI seam**. So all three
 * Claude callbacks must be expressed through those two:
 *
 * - tool permission → `ctx.approval.request()`, whose closed outcome union is
 *   `"allowed-once" | "rejected" | "cancelled" | "unavailable"`;
 * - `AskUserQuestion` → `ctx.userQuestions.ask()`, returning the same
 *   `{ answers: [{ id, selected, custom? }] }` batch shape;
 * - plan approval → **the same** `ask()` seam, distinguished by an
 *   `intent: { kind: "plan-review", approve }` on the question.
 *
 * **Fail-closed is the contract.** `"allowed-once"` is the only outcome that
 * grants anything: every other outcome, every thrown/rejected promise, and
 * every malformed response becomes `{ behavior: "deny", message }` (or `false`
 * for {@link askPlanReview}) — never `allow`, never a silent pass.
 *
 * The module is **pure and type-only**: it imports nothing at all (not the
 * Claude SDK, not Cordis) and touches no storage, settings, or session log.
 * {@link ApprovalLike} / {@link UserQuestionsLike} are the minimal structural
 * types of the DSH seams, so the real `ctx.approval` / `ctx.userQuestions` are
 * structurally compatible and are injected later (Task 9). Persisting a
 * selected permission mode is explicitly **not** this module's concern.
 */

/** The closed DSH approval-outcome union — `"allowed-once"` is the only grant. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** The minimal request shape of `ctx.approval.request`, structurally typed. */
export interface ApprovalRequestLike {
  /** The agent the question is asked on behalf of (DSH routes and audits by it). */
  agent: unknown;
  /** The tool the question is about. */
  toolName: string;
  /** The exact tool call being decided, when the asker has one. */
  callId?: string;
  /** The asker's human-readable explanation of why it is asking. */
  reason?: string;
  /** Aborting withdraws the question (DSH settles it `"cancelled"`). */
  signal?: AbortSignal;
}

/** The slice of `ctx.approval` this bridge calls. */
export interface ApprovalLike {
  /** Ask the composed answerers for one decision; only `"allowed-once"` grants. */
  request(req: {
    agent: unknown;
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome>;
}

/** One selectable answer offered to the user. */
export interface AskQuestionOption {
  /** User-facing label, echoed verbatim in the answer's `selected`. */
  label: string;
  /** Optional extra context rendered by capable UIs. */
  description?: string;
}

/**
 * A caller-declared presentation intent. An intent changes presentation only,
 * never the protocol: the answer encoding is identical either way.
 */
export interface AskQuestionIntent {
  /** A plan submitted for review; `detail` carries the plan markdown. */
  kind: "plan-review";
  /** The option label that approves the plan; every other option declines it. */
  approve: string;
}

/** One question in a user-questions request (the minimal DSH ask item shape). */
export interface AskQuestion {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string;
  /** The question to display. */
  question: string;
  /** Optional supporting detail rendered with the question. */
  detail?: string;
  /** Optional short heading/group label. */
  header?: string;
  /** Optional choices the UI can render as a menu. */
  options?: AskQuestionOption[];
  /**
   * Whether more than one option may be selected. camelCase is the DSH
   * **service contract** spelling: `ctx.userQuestions.ask()`'s own item type is
   * `multiSelect?: boolean` (`packages/interaction/user-questions/src/types.ts`),
   * and the client composer gates on `question.multiSelect === true`. The
   * snake_case `multi_select` belongs to DSH's *model-facing* `ask_user_question`
   * tool schema, which `tool-ask-user/src/index.ts` translates into `multiSelect`
   * before calling the service — so this bridge emits the service's spelling and
   * nothing else (a `multi_select` key here is read by no one).
   */
  multiSelect?: boolean;
  /** Optional presentation intent for capable UIs. */
  intent?: AskQuestionIntent;
}

/** Answer to one question, keyed by the question's own {@link AskQuestion.id}. */
export interface AskAnswerItem {
  /** The answered question id. */
  id: string;
  /** Selected option labels. May accompany custom text. */
  selected: string[];
  /** Optional free-text "Other" answer. */
  custom?: string;
}

/** The human's answer to a whole question batch. */
export interface AskAnswer {
  /** Structured answers, one per asked question in batch order. */
  answers: AskAnswerItem[];
}

/** The slice of `ctx.userQuestions` this bridge calls. */
export interface UserQuestionsLike {
  /** Ask the answerer waterfall and wait for the human's answer. */
  ask(req: {
    questions: AskQuestion[];
    agent?: unknown;
    signal?: AbortSignal;
  }): Promise<AskAnswer>;
}

/**
 * The Claude-facing permission verdict: the subset of the SDK's
 * `PermissionResult` this bridge produces. There is deliberately no third arm.
 */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Narrow an untrusted value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable text for an unknown thrown value (the deny message's trace). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `canUseTool` denial: the word `denied` keeps every refusal visible. */
function toolCallDenied(reason: string): PermissionDecision {
  return { behavior: "deny", message: `Claude Code tool call denied (${reason})` };
}

/** The denial reason for an approval outcome or a rogue value. */
function outcomeReason(outcome: unknown): string {
  return typeof outcome === "string" ? outcome : "unrecognized approval outcome";
}

/**
 * Map Claude Code's `canUseTool` callback onto `ctx.approval.request()`.
 *
 * The returned callback is the SDK's fail-closed permission gate:
 *
 * - `"allowed-once"` → `{ behavior: "allow" }` (the input is never rewritten —
 *   the tool call proceeds with the arguments Claude already supplied);
 * - `"rejected"` / `"cancelled"` / `"unavailable"` / anything else → deny;
 * - a rejected `approval.request` promise (an idle turn, a failed audit append,
 *   a missing answerer that throws instead of normalizing) → deny.
 *
 * The approval request carries `toolName` and `callId` (from
 * `options.toolUseID`) so the DSH UI attaches the prompt to the tool call it
 * already streamed; the arguments are deliberately *not* duplicated here,
 * which is why `input` is unused.
 *
 * @param deps - the approval seam and the agent asking.
 * @returns a `CanUseTool`-compatible callback.
 */
export function makeCanUseTool(deps: { approval: ApprovalLike; agent: unknown }) {
  return async (
    toolName: string,
    _input: Record<string, unknown>,
    options: { toolUseID: string; signal: AbortSignal; decisionReason?: string },
  ): Promise<PermissionDecision> => {
    let outcome: unknown;
    try {
      outcome = await deps.approval.request({
        agent: deps.agent,
        toolName,
        callId: options?.toolUseID,
        ...(options?.decisionReason !== undefined ? { reason: options.decisionReason } : {}),
        signal: options?.signal,
      });
    } catch (error) {
      return toolCallDenied(`the approval request failed: ${errorText(error)}`);
    }
    // Exact-match grant: a rogue or missing value must never open the gate.
    if (outcome === "allowed-once") return { behavior: "allow" };
    return toolCallDenied(outcomeReason(outcome));
  };
}

/** True when one untrusted answer entry is a well-formed {@link AskAnswerItem}. */
function isAnswerItem(value: unknown): value is AskAnswerItem {
  return isRecord(value)
    && typeof value.id === "string"
    && Array.isArray(value.selected)
    && value.selected.every((label) => typeof label === "string")
    && (value.custom === undefined || typeof value.custom === "string");
}

/**
 * Resolve the answer entry for one converted question by **id only**.
 *
 * The DSH service echoes the id it was given, so an id match is the one proof
 * that an answer belongs to this question. There is deliberately **no**
 * positional fallback: a response of the right length but with foreign or
 * mismatched ids (a reordered batch, a foreign answerer, a test double) would
 * otherwise pair `answers[i]` with `questions[i]` and silently feed Claude
 * somebody else's answer. Such a response fails closed instead, as does a
 * missing/empty/non-array `answers` or any entry that is not a well-formed
 * {@link AskAnswerItem}.
 *
 * @param answer - the untrusted response from `ask()`.
 * @param question - the question being resolved.
 * @returns the matching answer entry, or undefined when the response cannot
 *   answer this question.
 */
function resolveAnswer(answer: unknown, question: AskQuestion): AskAnswerItem | undefined {
  if (!isRecord(answer) || !Array.isArray(answer.answers)) return undefined;
  if (!answer.answers.every(isAnswerItem)) return undefined;
  return answer.answers.find((item) => item.id === question.id);
}

/**
 * Encode one question's answer the way Claude's `answers` map wants it:
 * multi-select labels joined by `", "`, then the custom "Other" text appended
 * as one more comma-separated segment. Neither an absent/blank `custom` nor an
 * empty `selected` may leave a stray or doubled `", "`.
 */
function encodeAnswer(selected: readonly string[], custom: string | undefined): string {
  const segments: string[] = [];
  if (selected.length > 0) segments.push(selected.join(", "));
  const extra = typeof custom === "string" ? custom.trim() : "";
  if (extra !== "") segments.push(extra);
  return segments.join(", ");
}

/** Claude's `AskUserQuestionInput` question list, narrowed to a usable array. */
function claudeQuestions(input: unknown): unknown[] {
  return isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
}

/** Convert one Claude question into the DSH ask item, or undefined when unusable. */
function toAskQuestion(raw: unknown, index: number): AskQuestion | undefined {
  if (!isRecord(raw) || typeof raw.question !== "string" || raw.question === "") return undefined;
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option): AskQuestionOption[] => {
      if (!isRecord(option) || typeof option.label !== "string") return [];
      return [{
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      }];
    })
    : [];
  const multiSelect = typeof raw.multiSelect === "boolean" ? raw.multiSelect : undefined;
  return {
    id: `q${index}`,
    question: raw.question,
    ...(typeof raw.header === "string" ? { header: raw.header } : {}),
    ...(options.length > 0 ? { options } : {}),
    // The service contract's own spelling — the only one the seam reads.
    ...(multiSelect !== undefined ? { multiSelect } : {}),
  };
}

/**
 * Map Claude Code's `AskUserQuestion` tool call onto `ctx.userQuestions.ask()`
 * and translate the human's answer back into Claude's `updatedInput.answers`.
 *
 * The batch is converted per question: a fresh DSH id (`q${i}`), the question
 * text, the header when present, the option labels/descriptions (Claude's
 * UI-only `preview` is dropped — DSH has no field for it), and the multi-select
 * flag. The answer comes back keyed by the **question text** (Claude's `answers`
 * is `{ [questionText]: string }`), each value being the selected labels joined
 * by `", "` with any custom "Other" text appended as one more segment.
 *
 * Fail-closed: a missing/empty/malformed question batch, a rejected `ask()`
 * promise, a malformed answer batch, and any unanswered question all produce
 * `{ behavior: "deny", message }`. A question *without* options is legitimate
 * (DSH renders it as a free-text answer) and is asked with no option menu.
 *
 * @param deps - the user-questions seam and the agent asking.
 * @param input - Claude's `AskUserQuestionInput` (its `questions` array is input).
 * @param signal - the tool call's cancellation lifetime.
 * @returns an allow carrying `updatedInput` with the `answers` map, or a denial.
 */
export async function answerAskUserQuestion(
  deps: { questions: UserQuestionsLike; agent: unknown },
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const raw = claudeQuestions(input);
  if (raw.length === 0) {
    // Nothing to ask is malformed input (the seam itself rejects it as
    // EMPTY_QUESTIONS); fabricating an empty answer set would hand Claude a
    // result no human produced.
    return { behavior: "deny", message: "Claude Code AskUserQuestion denied (no questions to ask)" };
  }
  const questions: AskQuestion[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const question = toAskQuestion(raw[index], index);
    if (question === undefined) {
      return {
        behavior: "deny",
        message: `Claude Code AskUserQuestion denied (question ${index} is malformed)`,
      };
    }
    questions.push(question);
  }

  let answer: unknown;
  try {
    answer = await deps.questions.ask({
      questions,
      agent: deps.agent,
      signal,
    });
  } catch (error) {
    return {
      behavior: "deny",
      message: `Claude Code AskUserQuestion denied (the user-question request failed: ${errorText(error)})`,
    };
  }

  const answers: Record<string, string> = {};
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index] as AskQuestion;
    const item = resolveAnswer(answer, question);
    if (item === undefined) {
      return {
        behavior: "deny",
        message: `Claude Code AskUserQuestion denied (no answer for question ${question.id})`,
      };
    }
    answers[question.question] = encodeAnswer(item.selected, item.custom);
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

/** The DSH question id the plan review asks under (and answers by). */
const PLAN_QUESTION_ID = "plan";
/** The option label that approves the plan. */
const PLAN_APPROVE_LABEL = "Approve";
/** The option label that declines the plan. */
const PLAN_DECLINE_LABEL = "Keep planning";

/**
 * Map Claude Code's `ExitPlanMode` callback onto the **same**
 * `ctx.userQuestions.ask()` seam, tagged for plan-review presentation.
 *
 * The question carries `detail = plan`, the binary Approve/Keep-planning option
 * pair, and `intent: { kind: "plan-review", approve: "Approve" }` — the intent's
 * `approve` names one of the question's own options, as `ask()` requires. Only
 * an answer whose `selected` contains `"Approve"` approves; every other answer,
 * a rejected `ask()` promise, a missing/malformed answer, and any thrown error
 * return `false` (fail-closed: declining keeps the plan unapproved).
 *
 * @param deps - the user-questions seam and the agent asking.
 * @param plan - the plan markdown under review.
 * @param signal - the call's cancellation lifetime.
 * @returns true only when the human approved.
 */
export async function askPlanReview(
  deps: { questions: UserQuestionsLike; agent: unknown },
  plan: string,
  signal: AbortSignal,
): Promise<boolean> {
  const question: AskQuestion = {
    id: PLAN_QUESTION_ID,
    question: "Approve this plan?",
    detail: plan,
    options: [{ label: PLAN_APPROVE_LABEL }, { label: PLAN_DECLINE_LABEL }],
    intent: { kind: "plan-review", approve: PLAN_APPROVE_LABEL },
  };
  try {
    const answer = await deps.questions.ask({
      questions: [question],
      agent: deps.agent,
      signal,
    });
    const item = resolveAnswer(answer, question);
    return item !== undefined && item.selected.includes(PLAN_APPROVE_LABEL);
  } catch {
    return false;
  }
}
