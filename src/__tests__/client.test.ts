import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompositeClient, isTransientError } from "../client.js";
import type { GeminiLike } from "../types.js";

/** A GeminiLike whose generateContent fails `failTimes` then succeeds, recording models seen. */
function scriptedClient(opts: {
  label: string;
  failTimes?: number;
  error?: () => Error;
  models: string[];
  embedModels?: string[];
}): GeminiLike {
  let calls = 0;
  return {
    models: {
      async generateContent(req) {
        opts.models.push(req.model);
        calls += 1;
        if (opts.failTimes && calls <= opts.failTimes) {
          throw (opts.error ?? (() => new Error("503 UNAVAILABLE high demand")))();
        }
        return { text: `${opts.label}:${req.model}` };
      },
      async embedContent(req) {
        opts.embedModels?.push(req.model);
        return { embeddings: [{ values: [1, 2, 3] }] };
      },
    },
  };
}

const noSleep = async () => {};

test("isTransientError matches 503/UNAVAILABLE/overloaded/429, not plain errors", () => {
  assert.equal(isTransientError(new Error('503 {"status":"UNAVAILABLE"}')), true);
  assert.equal(isTransientError(new Error("model is overloaded")), true);
  assert.equal(isTransientError(new Error("high demand, try again later")), true);
  assert.equal(isTransientError(new Error("429 rate limited")), true);
  assert.equal(isTransientError(new Error("invalid api key")), false);
  assert.equal(isTransientError(new Error("400 bad request: schema")), false);
});

test("claude model routes to the claude provider", async () => {
  const cModels: string[] = [];
  const claude = scriptedClient({ label: "claude", models: cModels });
  const client = createCompositeClient({ claude, sleep: noSleep });

  const res = await client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" });

  assert.equal(res.text, "claude:claude-sonnet-4-6");
  assert.deepEqual(cModels, ["claude-sonnet-4-6"]);
});

test("transient claude errors are retried with backoff, then succeed", async () => {
  const cModels: string[] = [];
  const claude = scriptedClient({ label: "claude", failTimes: 2, models: cModels });
  let sleeps = 0;
  const client = createCompositeClient({ claude, retries: 3, sleep: async () => { sleeps += 1; } });

  const res = await client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" });

  assert.equal(res.text, "claude:claude-sonnet-4-6");
  assert.equal(cModels.length, 3); // 2 failures + 1 success
  assert.equal(sleeps, 2);
});

test("claude failing past retries falls back to gemini with the fallback model", async () => {
  const cModels: string[] = [];
  const gModels: string[] = [];
  const claude = scriptedClient({ label: "claude", failTimes: 99, models: cModels });
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({
    claude,
    gemini,
    geminiFallbackModel: "gemini-2.5-flash",
    retries: 3,
    sleep: noSleep,
  });

  const res = await client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" });

  assert.equal(res.text, "gemini:gemini-2.5-flash");
  assert.equal(cModels.length, 3); // exhausted retries
  assert.deepEqual(gModels, ["gemini-2.5-flash"]);
});

test("non-transient claude error falls back to gemini immediately (no retries)", async () => {
  const cModels: string[] = [];
  const gModels: string[] = [];
  const claude = scriptedClient({
    label: "claude",
    failTimes: 99,
    error: () => new Error("400 bad request"),
    models: cModels,
  });
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({ claude, gemini, geminiFallbackModel: "gemini-2.5-flash", sleep: noSleep });

  const res = await client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" });

  assert.equal(res.text, "gemini:gemini-2.5-flash");
  assert.equal(cModels.length, 1); // tried once, non-transient → no retry, straight to fallback
});

test("grok-* models route to the xAI provider", async () => {
  const xModels: string[] = [];
  const xai = scriptedClient({ label: "grok", models: xModels });
  const client = createCompositeClient({ xai, sleep: noSleep });

  const res = await client.models.generateContent({ model: "grok-4.6", contents: "x" });

  assert.equal(res.text, "grok:grok-4.6");
  assert.deepEqual(xModels, ["grok-4.6"]);
});

test("transient grok errors are retried then fall back to gemini", async () => {
  const xModels: string[] = [];
  const gModels: string[] = [];
  const xai = scriptedClient({ label: "grok", failTimes: 99, models: xModels });
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({
    xai,
    gemini,
    geminiFallbackModel: "gemini-2.5-flash",
    retries: 3,
    sleep: noSleep,
  });

  const res = await client.models.generateContent({ model: "grok-4.6", contents: "x" });

  assert.equal(res.text, "gemini:gemini-2.5-flash");
  assert.equal(xModels.length, 3);
  assert.deepEqual(gModels, ["gemini-2.5-flash"]);
});

test("gemini-* models route straight to gemini", async () => {
  const gModels: string[] = [];
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({ gemini, sleep: noSleep });

  const res = await client.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });

  assert.equal(res.text, "gemini:gemini-2.5-flash");
  assert.deepEqual(gModels, ["gemini-2.5-flash"]);
});

test("embedContent always routes to gemini", async () => {
  const embedModels: string[] = [];
  const claude = scriptedClient({ label: "claude", models: [] });
  const gemini = scriptedClient({ label: "gemini", models: [], embedModels });
  const client = createCompositeClient({ claude, gemini, sleep: noSleep });

  const res = await client.models.embedContent({ model: "gemini-embedding-001", contents: ["a"] });

  assert.deepEqual(res.embeddings, [{ values: [1, 2, 3] }]);
  assert.deepEqual(embedModels, ["gemini-embedding-001"]);
});

test("claude model with no claude configured uses gemini fallback", async () => {
  const gModels: string[] = [];
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({ gemini, geminiFallbackModel: "gemini-2.5-flash", sleep: noSleep });

  const res = await client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" });

  assert.equal(res.text, "gemini:gemini-2.5-flash");
  assert.deepEqual(gModels, ["gemini-2.5-flash"]);
});

test("no providers configured throws a clear error", async () => {
  const client = createCompositeClient({ sleep: noSleep });
  await assert.rejects(
    client.models.generateContent({ model: "claude-sonnet-4-6", contents: "x" }),
    /no .*provider|ANTHROPIC_API_KEY|GEMINI_API_KEY|XAI_API_KEY/i,
  );
});
