import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAdapter } from "../anthropic.js";
import type { AnthropicCreateRequest, AnthropicLike, AnthropicMessage } from "../anthropic.js";

function makeFakeAnthropic(
  respond: (req: AnthropicCreateRequest) => AnthropicMessage,
  capture?: AnthropicCreateRequest[],
): AnthropicLike {
  return {
    messages: {
      async create(req) {
        capture?.push(req);
        return respond(req);
      },
    },
  };
}

test("plain-text generateContent returns concatenated text blocks", async () => {
  const client = makeFakeAnthropic(() => ({
    content: [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ],
  }));
  const adapter = claudeAdapter({ client });

  const res = await adapter.models.generateContent({
    model: "claude-sonnet-4-6",
    contents: "Write a greeting.",
  });

  assert.equal(res.text, "Hello world");
});

test("plain-text call maps string contents to a single user message with max_tokens", async () => {
  const capture: AnthropicCreateRequest[] = [];
  const client = makeFakeAnthropic(() => ({ content: [{ type: "text", text: "ok" }] }), capture);
  const adapter = claudeAdapter({ client, maxTokens: 4096 });

  await adapter.models.generateContent({ model: "claude-sonnet-4-6", contents: "the prompt" });

  assert.equal(capture.length, 1);
  assert.equal(capture[0]!.model, "claude-sonnet-4-6");
  assert.equal(capture[0]!.max_tokens, 4096);
  assert.deepEqual(capture[0]!.messages, [{ role: "user", content: "the prompt" }]);
  assert.equal(capture[0]!.tools, undefined);
});

test("JSON-mode call forces a tool and returns the tool input as JSON text", async () => {
  const capture: AnthropicCreateRequest[] = [];
  const client = makeFakeAnthropic(
    () => ({ content: [{ type: "tool_use", name: "emit_result", input: { candidates: [{ topic: "x" }] } }] }),
    capture,
  );
  const adapter = claudeAdapter({ client });
  const schema = { type: "object", properties: { candidates: { type: "array" } }, required: ["candidates"] };

  const res = await adapter.models.generateContent({
    model: "claude-sonnet-4-6",
    contents: "generate candidates",
    config: { responseMimeType: "application/json", responseSchema: schema },
  });

  // The returned text must parse back into the tool input object.
  assert.deepEqual(JSON.parse(res.text!), { candidates: [{ topic: "x" }] });
  // The request must force exactly the emit tool with the passed schema.
  const req = capture[0]!;
  assert.equal(req.tools?.length, 1);
  assert.equal(req.tools![0]!.name, "emit_result");
  assert.deepEqual(req.tools![0]!.input_schema, schema);
  assert.deepEqual(req.tool_choice, { type: "tool", name: "emit_result" });
});

test("JSON-mode call throws when no tool_use block comes back", async () => {
  const client = makeFakeAnthropic(() => ({ content: [{ type: "text", text: "I refuse" }] }));
  const adapter = claudeAdapter({ client });

  await assert.rejects(
    adapter.models.generateContent({
      model: "claude-sonnet-4-6",
      contents: "x",
      config: { responseMimeType: "application/json", responseSchema: { type: "object" } },
    }),
    /tool_use/,
  );
});

test("embedContent is unsupported on the Claude adapter", async () => {
  const client = makeFakeAnthropic(() => ({ content: [] }));
  const adapter = claudeAdapter({ client });

  await assert.rejects(
    adapter.models.embedContent({ model: "x", contents: ["a"] }),
    /not support/i,
  );
});
