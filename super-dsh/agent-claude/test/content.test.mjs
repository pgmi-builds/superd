import { test } from "node:test";
import assert from "node:assert/strict";

const { toClaudeContent } = await import("../dist/content.js");

test("text and inline images become Anthropic text/image blocks", () => {
  const { content, skipped } = toClaudeContent([
    { type: "text", text: "look at this" },
    { type: "image", mediaType: "image/png", data: "AAAB" },
  ], () => undefined);
  assert.deepEqual(content, [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
  ]);
  assert.deepEqual(skipped, []);
});

test("an attachment-backed image is resolved through the injected reader", () => {
  const { content } = toClaudeContent([
    { type: "image", attachmentId: "att-1" },
  ], (id) => (id === "att-1" ? { mediaType: "image/jpeg", data: "ZZZ" } : undefined));
  assert.deepEqual(content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } },
  ]);
});

test("an unresolvable block is skipped and REPORTED, never silently dropped", () => {
  const { content, skipped } = toClaudeContent([
    { type: "text", text: "keep" },
    { type: "file", attachmentId: "missing" },
    { type: "image" },
  ], () => undefined);
  assert.deepEqual(content, [{ type: "text", text: "keep" }]);
  assert.equal(skipped.length, 2, "every dropped block must be reported for tracing");
});

// --- edge pins added by the implementer (design-point coverage) ---

test("an empty block list is an empty result, not a throw", () => {
  assert.deepEqual(toClaudeContent([], () => undefined), { content: [], skipped: [] });
});

test("null / undefined / non-object entries are reported, never fatal", () => {
  const { content, skipped } = toClaudeContent(
    [null, undefined, 42, "text", { type: "text", text: "survivor" }],
    () => undefined,
  );
  assert.deepEqual(content, [{ type: "text", text: "survivor" }]);
  assert.equal(skipped.length, 4, "each malformed entry must be reported");
  for (const reason of skipped) assert.match(reason, /index \d/);
});

test("text is byte-exact and consecutive text blocks stay separate blocks", () => {
  const raw = "  padded\t\nsecond line  ";
  const { content } = toClaudeContent([
    { type: "text", text: raw },
    { type: "text", text: "second block" },
    { type: "text", text: "" },
  ], () => undefined);
  assert.deepEqual(content, [
    { type: "text", text: raw },
    { type: "text", text: "second block" },
  ]);
  assert.equal(content[0].text, raw, "no trimming or normalization");
  assert.equal(content.length, 2, "text blocks must not be concatenated");
});

test("an empty text block is reported (Anthropic rejects empty text blocks)", () => {
  const { content, skipped } = toClaudeContent([{ type: "text", text: "" }], () => undefined);
  assert.deepEqual(content, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /empty text/);
});

test("a file block is reported, never silently treated as an image", () => {
  const { content, skipped } = toClaudeContent([
    { type: "file", mediaType: "image/png", data: "AAAB", attachmentId: "att-file" },
    { type: "file", mediaType: "application/pdf", data: "JVBE" },
    { type: "file" },
  ], (id) => (id === "att-file" ? { mediaType: "image/png", data: "AAAB" } : undefined));
  assert.deepEqual(content, [], "no file block may become an image block");
  assert.equal(skipped.length, 3, "every file block must be reported");
  for (const reason of skipped) assert.match(reason, /file block at index \d/);
});

test("a missing mediaType is reported, never emitted as media_type: undefined", () => {
  const { content, skipped } = toClaudeContent([
    { type: "image", data: "AAAB" },
    { type: "image", attachmentId: "att-1" },
  ], () => ({ mediaType: "", data: "ZZZ" }));
  assert.deepEqual(content, []);
  assert.equal(skipped.length, 2);
  for (const reason of skipped) assert.match(reason, /mediaType/);
});

test("a non-image media type is reported rather than sent as an image source", () => {
  const { content, skipped } = toClaudeContent([
    { type: "image", mediaType: "application/pdf", data: "JVBE" },
  ], () => undefined);
  assert.deepEqual(content, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /not an image media type/);
});

test("an unknown block type is reported with the offending type", () => {
  const { content, skipped } = toClaudeContent([
    { type: "video", mediaType: "video/mp4", data: "AAAA" },
  ], () => undefined);
  assert.deepEqual(content, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /unknown block type "video"/);
});

test("an attachmentId the reader cannot resolve is reported by id", () => {
  const { content, skipped } = toClaudeContent([
    { type: "image", attachmentId: "att-404" },
  ], () => undefined);
  assert.deepEqual(content, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /att-404/);
});

test("a throwing reader is contained into a reported skip, never a crash", () => {
  const { content, skipped } = toClaudeContent([
    { type: "image", attachmentId: "att-boom" },
    { type: "text", text: "after" },
  ], () => { throw new Error("store offline"); });
  assert.deepEqual(content, [{ type: "text", text: "after" }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /att-boom/);
  assert.match(skipped[0], /store offline/);
});

test("inline data wins over the reader and is used byte-exact", () => {
  let reads = 0;
  const { content } = toClaudeContent([
    { type: "image", mediaType: "image/webp", data: "INLINE", attachmentId: "att-1" },
  ], () => { reads += 1; return { mediaType: "image/png", data: "FROM-STORE" }; });
  assert.deepEqual(content, [
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "INLINE" } },
  ]);
  assert.equal(reads, 0, "a fully inline block must not hit the store");
});
