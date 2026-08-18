import { test } from "node:test";
import assert from "node:assert/strict";
import { grokAdapter } from "../xai.js";
import type { XaiChatRequest, XaiChatResponse, XaiLike } from "../xai.js";

function makeFakeXai(
  respond: (req: XaiChatRequest) => XaiChatResponse,
  capture?: XaiChatRequest[],
): XaiLike {
  return {
    async chatCompletions(req) {
      capture?.push(req);
      return respond(req);
    },
  };
}

test("plain-text generateContent returns the assistant message content", async () => {
  const client = makeFakeXai(() => ({
    choices: [{ message: { content: "Hello world" } }],
  }));
  const adapter = grokAdapter({ client });

  const res = await adapter.models.generateContent({
    model: "grok-4.6",
    contents: "Write a greeting.",
  });

  assert.equal(res.text, "Hello world");
});

test("plain-text call maps string contents to a user message with reasoning_effort low", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai(
    () => ({ choices: [{ message: { content: "ok" } }] }),
    capture,
  );
  const adapter = grokAdapter({ client, maxTokens: 4096 });

  await adapter.models.generateContent({ model: "grok-4.6", contents: "the prompt" });

  assert.equal(capture.length, 1);
  assert.equal(capture[0]!.model, "grok-4.6");
  assert.equal(capture[0]!.max_tokens, 4096);
  assert.equal(capture[0]!.reasoning_effort, "low");
  assert.deepEqual(capture[0]!.messages, [{ role: "user", content: "the prompt" }]);
  assert.equal(capture[0]!.response_format, undefined);
});

test("reasoning_effort is omitted for models outside grok-4.5/4.6", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai(
    () => ({ choices: [{ message: { content: "ok" } }] }),
    capture,
  );
  const adapter = grokAdapter({ client });

  await adapter.models.generateContent({ model: "grok-4-fast", contents: "the prompt" });

  assert.equal(capture.length, 1);
  assert.equal(capture[0]!.model, "grok-4-fast");
  assert.equal(capture[0]!.reasoning_effort, undefined);
});

test("JSON-mode call sends json_schema and returns the message content", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai(
    () => ({ choices: [{ message: { content: '{"candidates":[{"topic":"x"}]}' } }] }),
    capture,
  );
  const adapter = grokAdapter({ client });
  const schema = { type: "object", properties: { candidates: { type: "array" } }, required: ["candidates"] };

  const res = await adapter.models.generateContent({
    model: "grok-4.6",
    contents: "generate candidates",
    config: { responseMimeType: "application/json", responseSchema: schema },
  });

  assert.deepEqual(JSON.parse(res.text!), { candidates: [{ topic: "x" }] });
  const req = capture[0]!;
  assert.deepEqual(req.response_format, {
    type: "json_schema",
    json_schema: { name: "emit_result", strict: false, schema },
  });
  assert.equal(req.reasoning_effort, "low");
});

test("plain-text call throws when finish_reason is length", async () => {
  const client = makeFakeXai(() => ({
    choices: [{ message: { content: "half a sent" }, finish_reason: "length" }],
  }));
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({ model: "grok-4.6", contents: "write a post" }),
    /truncated|finish_reason=length/i,
  );
});

test("JSON-mode call throws a retryable error when finish_reason is length", async () => {
  const client = makeFakeXai(() => ({
    choices: [{ message: { content: '{"candidates":[' }, finish_reason: "length" }],
  }));
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({
      model: "grok-4.6",
      contents: "x",
      config: { responseMimeType: "application/json", responseSchema: { type: "object" } },
    }),
    /truncated|finish_reason=length|try again later/i,
  );
});

test("JSON-mode call throws a retryable error when content is not valid JSON", async () => {
  const client = makeFakeXai(() => ({
    choices: [{ message: { content: "not-json" }, finish_reason: "stop" }],
  }));
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({
      model: "grok-4.6",
      contents: "x",
      config: { responseMimeType: "application/json", responseSchema: { type: "object" } },
    }),
    /not valid JSON|try again later/i,
  );
});

test("JSON-mode call throws when the assistant content is empty", async () => {
  const client = makeFakeXai(() => ({ choices: [{ message: { content: "" } }] }));
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({
      model: "grok-4.6",
      contents: "x",
      config: { responseMimeType: "application/json", responseSchema: { type: "object" } },
    }),
    /empty|no content/i,
  );
});

test("createGrokClient posts to chat completions with the bearer token", async () => {
  const { createGrokClient } = await import("../xai.js");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = await createGrokClient({ apiKey: "test-key", fetchImpl });
  const res = await adapter.models.generateContent({ model: "grok-4.6", contents: "hi" });

  assert.equal(res.text, "hi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.x.ai/v1/chat/completions");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  const body = JSON.parse(String(calls[0]!.init.body)) as { reasoning_effort: string };
  assert.equal(body.reasoning_effort, "low");
});

test("embedContent is unsupported on the Grok adapter", async () => {
  const client = makeFakeXai(() => ({ choices: [] }));
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.embedContent({ model: "x", contents: ["a"] }),
    /not support|Gemini/i,
  );
});
