import { test } from "node:test";
import assert from "node:assert/strict";
import { grokAdapter, XaiHttpError } from "../xai.js";
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

test("reasoning_effort is sent by default for any grok model", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai(
    () => ({ choices: [{ message: { content: "ok" } }] }),
    capture,
  );
  const adapter = grokAdapter({ client });

  await adapter.models.generateContent({ model: "grok-4-fast", contents: "the prompt" });

  assert.equal(capture.length, 1);
  assert.equal(capture[0]!.model, "grok-4-fast");
  assert.equal(capture[0]!.reasoning_effort, "low");
});

test("a 400 naming reasoning_effort strips the param and retries once", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.reasoning_effort !== undefined) {
      throw new XaiHttpError(400, "Argument not supported: reasoning_effort");
    }
    return { choices: [{ message: { content: "ok" } }] };
  }, capture);
  const adapter = grokAdapter({ client });

  const res = await adapter.models.generateContent({ model: "grok-3-fast", contents: "hi" });

  assert.equal(res.text, "ok");
  assert.equal(capture.length, 2);
  assert.equal(capture[0]!.reasoning_effort, "low");
  assert.equal(capture[1]!.reasoning_effort, undefined);
});

test("a rejected model is memoized: later calls omit the param without a probe", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.reasoning_effort !== undefined) {
      throw new XaiHttpError(400, "Argument not supported: reasoning_effort");
    }
    return { choices: [{ message: { content: "ok" } }] };
  }, capture);
  const adapter = grokAdapter({ client });

  await adapter.models.generateContent({ model: "grok-3-fast", contents: "first" });
  await adapter.models.generateContent({ model: "grok-3-fast", contents: "second" });

  assert.equal(capture.length, 3); // probe + stripped retry, then one clean call
  assert.equal(capture[2]!.reasoning_effort, undefined);
});

test("memoization is per model string", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.model === "grok-3-fast" && req.reasoning_effort !== undefined) {
      throw new XaiHttpError(400, "Argument not supported: reasoning_effort");
    }
    return { choices: [{ message: { content: "ok" } }] };
  }, capture);
  const adapter = grokAdapter({ client });

  await adapter.models.generateContent({ model: "grok-3-fast", contents: "a" });
  await adapter.models.generateContent({ model: "grok-4.6", contents: "b" });

  const last = capture.at(-1)!;
  assert.equal(last.model, "grok-4.6");
  assert.equal(last.reasoning_effort, "low");
});

test("a memoized model keeps response_format in JSON mode", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.reasoning_effort !== undefined) {
      throw new XaiHttpError(400, "Argument not supported: reasoning_effort");
    }
    return { choices: [{ message: { content: '{"ok":true}' } }] };
  }, capture);
  const adapter = grokAdapter({ client });
  await adapter.models.generateContent({ model: "grok-3-fast", contents: "warm the memo" });

  await adapter.models.generateContent({
    model: "grok-3-fast",
    contents: "json please",
    config: { responseMimeType: "application/json", responseSchema: { type: "object" } },
  });

  const last = capture.at(-1)!;
  assert.equal(last.reasoning_effort, undefined);
  assert.equal(last.response_format?.type, "json_schema");
});

test("an unrelated 400 is rethrown after a single call (Claude fail-over path)", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai(() => {
    throw new XaiHttpError(400, "invalid schema for response_format");
  }, capture);
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({ model: "grok-4.6", contents: "hi" }),
    /xAI HTTP 400: invalid schema/,
  );
  assert.equal(capture.length, 1);
});

test("when the stripped retry also fails, the second error surfaces", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.reasoning_effort !== undefined) {
      throw new XaiHttpError(400, "Argument not supported: reasoning_effort");
    }
    throw new XaiHttpError(400, "prompt too long");
  }, capture);
  const adapter = grokAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({ model: "grok-3-fast", contents: "hi" }),
    /xAI HTTP 400: prompt too long/,
  );
  assert.equal(capture.length, 2);
});

test("transient errors are rethrown unstripped even if the body mentions the param", async () => {
  for (const status of [429, 503]) {
    const capture: XaiChatRequest[] = [];
    const client = makeFakeXai(() => {
      throw new XaiHttpError(status, "overloaded; retry reasoning_effort request later");
    }, capture);
    const adapter = grokAdapter({ client });

    await assert.rejects(
      adapter.models.generateContent({ model: "grok-4.6", contents: "hi" }),
      new RegExp(`xAI HTTP ${status}`),
    );
    assert.equal(capture.length, 1);
  }
});

test("plain Error with the established message shape is still recognized", async () => {
  const capture: XaiChatRequest[] = [];
  const client = makeFakeXai((req) => {
    if (req.reasoning_effort !== undefined) {
      throw new Error("xAI HTTP 400: Argument not supported: reasoning_effort");
    }
    return { choices: [{ message: { content: "ok" } }] };
  }, capture);
  const adapter = grokAdapter({ client });

  const res = await adapter.models.generateContent({ model: "grok-3-fast", contents: "hi" });

  assert.equal(res.text, "ok");
  assert.equal(capture.length, 2);
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

test("createGrokClient surfaces XaiHttpError with full body and retries stripped", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const longTail = "x".repeat(300);
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.reasoning_effort !== undefined) {
      return new Response(`Argument not supported: reasoning_effort ${longTail}`, { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { createGrokClient } = await import("../xai.js");
  const adapter = await createGrokClient({ apiKey: "test-key", fetchImpl });
  const res = await adapter.models.generateContent({ model: "grok-3-fast", contents: "hi" });

  assert.equal(res.text, "hi");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.reasoning_effort, "low");
  assert.equal(bodies[1]!.reasoning_effort, undefined);

  // The error shape itself: message truncates the body at 200 chars, .body keeps it all.
  const err = new XaiHttpError(400, `detail ${longTail}`);
  assert.ok(err.message.startsWith("xAI HTTP 400: detail"));
  assert.ok(err.message.length <= "xAI HTTP 400: ".length + 200);
  assert.ok(err.body.endsWith(longTail));
});

test("generateGrokImage posts to the images endpoint and decodes b64_json", async () => {
  const { generateGrokImage } = await import("../xai.js");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const pixels = Buffer.from("fake-jpeg-bytes");
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ data: [{ b64_json: pixels.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const buf = await generateGrokImage({
    apiKey: "test-key",
    prompt: "an HVAC technician on a Sacramento rooftop",
    fetchImpl,
  });

  assert.deepEqual(buf, pixels);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.x.ai/v1/images/generations");
  assert.equal(calls[0]!.body.model, "grok-imagine-image-2.0");
  assert.equal(calls[0]!.body.response_format, "b64_json");
  assert.equal(calls[0]!.body.aspect_ratio, "16:9");
  assert.equal(calls[0]!.body.n, 1);
});

test("generateGrokImage honors model, aspect ratio, resolution and quality overrides", async () => {
  const { generateGrokImage } = await import("../xai.js");
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: [{ b64_json: "eA==" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await generateGrokImage({
    apiKey: "k",
    prompt: "p",
    model: "grok-imagine-image",
    aspectRatio: "1:1",
    resolution: "2k",
    quality: "low",
    fetchImpl,
  });

  assert.equal(bodies[0]!.model, "grok-imagine-image");
  assert.equal(bodies[0]!.aspect_ratio, "1:1");
  assert.equal(bodies[0]!.resolution, "2k");
  assert.equal(bodies[0]!.quality, "low");
});

test("generateGrokImage throws XaiHttpError on a failed request", async () => {
  const { generateGrokImage } = await import("../xai.js");
  const fetchImpl: typeof fetch = async () => new Response("model not available", { status: 404 });

  await assert.rejects(
    generateGrokImage({ apiKey: "k", prompt: "p", fetchImpl }),
    (error: unknown) =>
      error instanceof XaiHttpError && error.status === 404 && /model not available/.test(error.body),
  );
});

test("generateGrokImage throws when the response carries no image data", async () => {
  const { generateGrokImage } = await import("../xai.js");
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ url: "https://example.com/x.jpg" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    generateGrokImage({ apiKey: "k", prompt: "p", fetchImpl }),
    /no b64_json data/,
  );
});
