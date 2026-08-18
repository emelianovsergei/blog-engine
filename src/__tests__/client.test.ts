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

test("isTransientError treats fetch failures as retryable but not timeouts", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(isTransientError(timeout), false);
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(isTransientError(abort), false);
  assert.equal(isTransientError(new Error("TypeError: fetch failed")), true);
});

test("composite preserves prototype text getters when attaching the served model", async () => {
  class FakeGeminiRes {
    candidates = [{ content: { parts: [{ text: "hello" }] } }];
    get text() {
      return "hello";
    }
  }
  const gemini: GeminiLike = {
    models: {
      async generateContent() {
        return new FakeGeminiRes();
      },
      async embedContent() {
        return { embeddings: [] };
      },
    },
  };
  const client = createCompositeClient({ gemini, sleep: noSleep });
  const direct = await client.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });
  assert.equal(direct.text, "hello");
  assert.equal(direct.model, "gemini-2.5-flash");

  const fallback = await client.models.generateContent({ model: "grok-4.6", contents: "x" });
  assert.equal(fallback.text, "hello");
  assert.equal(fallback.model, "gemini-2.5-flash");
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

test("grok with no xAI client falls back to Claude when configured", async () => {
  const cModels: string[] = [];
  const claude = scriptedClient({ label: "claude", models: cModels });
  const client = createCompositeClient({
    claude,
    claudeFallbackModel: "claude-sonnet-5",
    sleep: noSleep,
  });

  const res = await client.models.generateContent({ model: "grok-4.6", contents: "x" });

  assert.equal(res.text, "claude:claude-sonnet-5");
  assert.equal(res.model, "claude-sonnet-5");
  assert.deepEqual(cModels, ["claude-sonnet-5"]);
});

test("grok failure falls back to Claude before Gemini", async () => {
  const xModels: string[] = [];
  const cModels: string[] = [];
  const gModels: string[] = [];
  const xai = scriptedClient({ label: "grok", failTimes: 99, models: xModels });
  const claude = scriptedClient({ label: "claude", models: cModels });
  const gemini = scriptedClient({ label: "gemini", models: gModels });
  const client = createCompositeClient({
    xai,
    claude,
    gemini,
    claudeFallbackModel: "claude-sonnet-5",
    geminiFallbackModel: "gemini-2.5-flash",
    retries: 3,
    sleep: noSleep,
  });

  const res = await client.models.generateContent({ model: "grok-4.6", contents: "x" });

  assert.equal(res.text, "claude:claude-sonnet-5");
  assert.equal(res.model, "claude-sonnet-5");
  assert.equal(xModels.length, 3);
  assert.deepEqual(cModels, ["claude-sonnet-5"]);
  assert.deepEqual(gModels, []);
});

test("grok fallback warns with requested and served model", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const gemini = scriptedClient({ label: "gemini", models: [] });
    const client = createCompositeClient({
      gemini,
      geminiFallbackModel: "gemini-2.5-flash",
      sleep: noSleep,
    });
    await client.models.generateContent({ model: "grok-4.6", contents: "x" });
  } finally {
    console.warn = original;
  }
  assert.match(warnings.join("\n"), /grok-4.6.*gemini-2.5-flash/i);
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
