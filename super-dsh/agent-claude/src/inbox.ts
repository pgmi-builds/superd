/**
 * Minimal in-memory inbox for the Claude agent shim (mirrors
 * `agent-codex/src/inbox.ts`).
 *
 * The 0.1.5 `dsh-agent` contract exposes the inbox as an interface (`Inbox` in
 * `runtime-types`); the durable projection-backed implementation lives inside
 * the (disabled) `dsh-agent-loop`. Claude owns its own transcript and the
 * adapter delivers messages directly to the Claude client, so this inbox is
 * never queued into — it exists to satisfy the `Agent` interface's `inbox`
 * surface with correct (empty) semantics. TS-`private` members (never `#`):
 * Cordis tracing proxies break on hard-private receivers.
 */
import type { Inbox as InboxContract, InboxTarget } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { MessageId } from "@deepseek-ai/dsh-llm";

export class Inbox implements InboxContract {
  private nextTurnList: UserMessage[] = [];
  private nextStepList: UserMessage[] = [];

  get nextTurn(): readonly UserMessage[] {
    return this.nextTurnList;
  }

  get nextStep(): readonly UserMessage[] {
    return this.nextStepList;
  }

  clear(): void {
    this.nextTurnList = [];
    this.nextStepList = [];
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.list(target).push(message);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.list(target).unshift(message);
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const list = this.find(messageId);
    if (list === undefined) return false;
    const index = list.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    list.splice(index, 1, newMessage);
    return true;
  }

  remove(messageId: MessageId): boolean {
    const list = this.find(messageId);
    if (list === undefined) return false;
    const index = list.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.list(target).splice(start, deleteCount, ...inserted);
  }

  private list(target: InboxTarget): UserMessage[] {
    return target === "next-turn" ? this.nextTurnList : this.nextStepList;
  }

  private find(messageId: MessageId): UserMessage[] | undefined {
    if (this.nextTurnList.some((message) => message.id === messageId)) return this.nextTurnList;
    if (this.nextStepList.some((message) => message.id === messageId)) return this.nextStepList;
    return undefined;
  }
}
