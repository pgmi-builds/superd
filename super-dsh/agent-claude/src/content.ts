/**
 * DSH content blocks -> Anthropic message content blocks.
 *
 * The paste/prompt UI is DSH's own; the adapter owns the transcoding into
 * Claude's wire shape (spec ruling R14). A block whose payload cannot be
 * resolved is SKIPPED AND REPORTED: an unattachable image must never silently
 * vanish, and an unusable placeholder must never be sent to the runtime.
 *
 * The module is deliberately PURE — no SDK import and no I/O. It produces plain
 * JSON blocks and the caller injects whatever attachment reader it owns, so the
 * projection can be pinned by a unit test without a store, a CLI, or a session.
 *
 * ## Skip policy (every skip is loud)
 *
 * - a non-object entry, a missing/empty/non-string text, or an empty text block
 *   (the Anthropic API rejects empty text blocks, so normalizing one away is a
 *   reported drop, not a silent trim);
 * - an unknown block `type`;
 * - an `image`/`file` with neither inline `data` nor a resolvable
 *   `attachmentId`;
 * - an `attachmentId` the injected reader cannot resolve (or one that throws —
 *   the reader's failure is contained here and becomes a reported skip);
 * - a missing/empty `mediaType`, or a media type that is not `image/*`: the
 *   output must never carry `media_type: undefined` or a non-image source;
 * - ANY `file` block. DSH's `file` block is a verbatim attachment reference —
 *   the harness contract is that files never reach a provider natively and are
 *   projected to deterministic handle text instead, so this adapter must not
 *   launder one into an image block. It is reported instead.
 */

/** One Anthropic user-message content block (the shapes the SDK accepts). */
export type ClaudeInputBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** One DSH user content block, as this projection consumes it. */
export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "file"; mediaType?: string; data?: string; attachmentId?: string };

/** An image payload resolved for one block. */
export interface ResolvedAttachment {
  mediaType: string;
  data: string;
}

/** Whether a media type may ride an Anthropic base64 image source. */
function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

/** A non-empty string field, or undefined when absent/blank/unusable. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Human-readable detail for a contained reader failure. */
function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "unknown error" : message;
}

/**
 * Transcode DSH user content blocks into Anthropic input blocks.
 *
 * @param blocks - DSH user content blocks in message order. Entries are read
 *   defensively: a null/undefined/non-object member is reported, not fatal.
 * @param readAttachment - synchronous resolver for a durable attachment id.
 *   Returning `undefined` means "not resolvable" and becomes a reported skip;
 *   throwing is contained into a reported skip as well. A block carrying inline
 *   `data` never consults it.
 * @returns the attachable blocks in input order plus one actionable reason per
 *   block that could not be attached.
 */
export function toClaudeContent(
  blocks: readonly DshContentBlock[],
  readAttachment: (id: string) => ResolvedAttachment | undefined,
): { content: ClaudeInputBlock[]; skipped: string[] } {
  const content: ClaudeInputBlock[] = [];
  const skipped: string[] = [];
  const source: readonly unknown[] = Array.isArray(blocks) ? blocks : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    if (entry === null || entry === undefined || typeof entry !== "object") {
      skipped.push(`block at index ${index}: not a content block object`);
      continue;
    }
    const block = entry as DshContentBlock & { type?: unknown; text?: unknown };

    if (block.type === "text") {
      const text = block.text;
      if (typeof text !== "string") {
        skipped.push(`text block at index ${index}: missing text`);
        continue;
      }
      if (text === "") {
        skipped.push(`text block at index ${index}: empty text`);
        continue;
      }
      // Byte-exact, and one output block per input block: consecutive text
      // blocks are legal on the wire, and merging them would change the shape.
      content.push({ type: "text", text });
      continue;
    }

    if (block.type !== "image" && block.type !== "file") {
      skipped.push(`block at index ${index}: unknown block type ${JSON.stringify(block.type)}`);
      continue;
    }
    if (block.type === "file") {
      // DSH's `file` block is a verbatim attachment reference. The harness
      // contract is that files never reach a provider natively (they are
      // projected to deterministic handle text), so a file block is NEVER
      // emitted as an image block here — even when its payload looks like a
      // raster image. Reported instead, and never resolved through the image
      // reader.
      const fileMediaType = stringField(block.mediaType);
      skipped.push(
        `file block at index ${index}: verbatim file references cannot be attached to Claude` +
        (fileMediaType === undefined ? "" : ` (mediaType "${fileMediaType}")`),
      );
      continue;
    }

    let mediaType = stringField(block.mediaType);
    let data = stringField(block.data);
    const attachmentId = stringField(block.attachmentId);

    if (data === undefined && attachmentId !== undefined) {
      let resolved: ResolvedAttachment | undefined;
      try {
        resolved = readAttachment(attachmentId);
      } catch (error) {
        skipped.push(
          `${block.type} block at index ${index}: reading attachment "${attachmentId}" failed (${errorDetail(error)})`,
        );
        continue;
      }
      if (resolved !== undefined && resolved !== null && typeof resolved === "object") {
        if (mediaType === undefined) mediaType = stringField(resolved.mediaType);
        if (data === undefined) data = stringField(resolved.data);
      }
    }

    if (data === undefined) {
      skipped.push(
        `${block.type} block at index ${index}: no inline data` +
        (attachmentId === undefined
          ? " and no attachmentId"
          : ` and attachment "${attachmentId}" could not be resolved`),
      );
      continue;
    }
    if (mediaType === undefined) {
      skipped.push(`${block.type} block at index ${index}: missing mediaType`);
      continue;
    }
    if (!isImageMediaType(mediaType)) {
      skipped.push(
        `${block.type} block at index ${index}: media type "${mediaType}" is not an image media type`,
      );
      continue;
    }
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  return { content, skipped };
}
