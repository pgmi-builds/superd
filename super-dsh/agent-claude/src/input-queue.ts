/**
 * Push-based AsyncIterable backing the SDK's streaming-input mode.
 *
 * `Query` control methods (interrupt / setModel / setPermissionMode /
 * supportedModels) are only available in streaming input mode, so the client
 * always hands `query()` one of these and keeps pushing into it.
 *
 * Ordering: a queued item always wins over `close()`. The consumer drains the
 * FIFO first and only observes `done` on the next pull after the queue is
 * empty, so `close()` never discards work that was pushed before it.
 *
 * A single consumer is supported. `push()` resolves the parked waiter directly
 * (it does not poll), which is what makes a message pushed mid-turn wake a
 * consumer that is already awaiting `next()`.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeInputBlock } from "./content.js";

/**
 * The content a queued user turn carries: plain text or Anthropic input blocks.
 *
 * The SDK's `MessageParam.content` already admits `string | ContentBlock[]`, so
 * the queue keeps both forms — T9.6 widens the client's prompt surface to this
 * union and hands the block array through AS-IS, never re-joined into a string
 * (which would collapse the transcoder's one-block-per-input-block shape).
 */
export type ClaudeInputContent = string | readonly ClaudeInputBlock[];

/** The SDK correlation fields of one queued user turn. */
export type ClaudeMessageEnvelope = Omit<SDKUserMessage, "type" | "message">;

/**
 * Bridge the widened content union to the SDK's MessageParam content.
 *
 * A plain string keeps the historical normalization into ONE text block (the
 * SDK's own transport shape, and what the client's shape pin asserts); a block
 * array is handed through AS-IS, so the transcoder's one-block-per-input-block
 * shape is never collapsed. The transcoder emits Anthropic text/image blocks;
 * the SDK narrows an image source's `media_type` to its four raster literals,
 * so one boundary assertion spans the two spellings (the transcoder gates the
 * media type).
 */
function sdkMessageContent(content: ClaudeInputContent): SDKUserMessage["message"]["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content as SDKUserMessage["message"]["content"];
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiter: (() => void) | undefined;
  private done = false;

  get closed(): boolean {
    return this.done;
  }

  push(message: SDKUserMessage): void {
    if (this.done) throw new Error("agent-claude: input queue is closed");
    this.pending.push(message);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /**
   * Push one user turn whose `content` is the widened prompt surface (plain
   * text or transcoded Anthropic blocks). The envelope carries the SDK
   * correlation fields (session_id / priority / parent_tool_use_id).
   */
  pushContent(content: ClaudeInputContent, envelope: ClaudeMessageEnvelope): void {
    this.push({
      type: "user",
      message: { role: "user", content: sdkMessageContent(content) },
      ...envelope,
    });
  }

  close(): void {
    this.done = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolvePromise) => {
        this.waiter = resolvePromise;
      });
    }
  }
}
