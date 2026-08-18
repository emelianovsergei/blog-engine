/**
 * Live xAI smoke test — validates the Grok adapter against the real API.
 *
 * Nothing in the unit suite ever talks to api.x.ai (all fakes), so this
 * script is the only place adapter behavior meets actual Grok:
 *
 *   1. discovery   GET /v1/language-models — which models/aliases this key
 *                  can reach; PASS iff grok-4.6 resolves ("find grok").
 *   2. plain text  small completion, asserts non-empty text.
 *   3. JSON mode   the production reviewSchema, asserts required fields.
 *   4. truncation  tiny max_tokens, asserts the finish_reason=length throw.
 *   5. param probe informational: does a non-grok-4.5/4.6 model reject or
 *                  ignore reasoning_effort? Exercises the adaptive retry.
 *
 * Requires XAI_API_KEY (never logged). Without it the script prints SKIP
 * and exits 0 so local runs and secretless CI stay green.
 *
 *   npm run smoke:xai
 */
import { createGrokClient } from "../src/xai.js";
import { reviewSchema } from "../src/review.js";

const API_KEY = process.env.XAI_API_KEY;
const MODELS_URL = "https://api.x.ai/v1/language-models";
const PRIMARY_MODEL = "grok-4.6";

interface SmokeResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

interface LanguageModel {
  id?: string;
  aliases?: string[];
}

async function discoverModels(): Promise<{ result: SmokeResult; models: LanguageModel[] }> {
  const name = "discovery (/v1/language-models)";
  const response = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    return {
      result: { name, status: "FAIL", detail: `HTTP ${response.status}` },
      models: [],
    };
  }
  const payload = (await response.json()) as { models?: LanguageModel[]; data?: LanguageModel[] };
  const models = payload.models ?? payload.data ?? [];
  const ids = models.map((m) => m.id ?? "?");
  const resolves = models.some(
    (m) => m.id === PRIMARY_MODEL || (m.aliases ?? []).includes(PRIMARY_MODEL),
  );
  console.log(`  models available to this key: ${ids.join(", ") || "(none)"}`);
  for (const m of models) {
    if (m.aliases?.length) console.log(`    ${m.id}: aliases ${m.aliases.join(", ")}`);
  }
  return {
    result: resolves
      ? { name, status: "PASS", detail: `${PRIMARY_MODEL} resolves; ${models.length} models` }
      : { name, status: "FAIL", detail: `${PRIMARY_MODEL} not among ids/aliases` },
    models,
  };
}

async function smokePlainText(): Promise<SmokeResult> {
  const name = "plain text";
  const client = await createGrokClient({ apiKey: API_KEY!, maxTokens: 1024 });
  const res = await client.models.generateContent({
    model: PRIMARY_MODEL,
    contents: 'Reply with exactly the word "pong".',
  });
  return res.text?.trim()
    ? { name, status: "PASS", detail: `got ${JSON.stringify(res.text.trim().slice(0, 40))}` }
    : { name, status: "FAIL", detail: "empty text" };
}

async function smokeJsonMode(): Promise<SmokeResult> {
  const name = "JSON mode (reviewSchema)";
  const client = await createGrokClient({ apiKey: API_KEY!, maxTokens: 4096 });
  const draft =
    "# Fixing a leaky faucet\n\nTurn off the water. Replace the washer. Turn the water back on.";
  const res = await client.models.generateContent({
    model: PRIMARY_MODEL,
    contents: `Review this blog draft:\n\n${draft}`,
    config: { responseMimeType: "application/json", responseSchema: reviewSchema },
  });
  const parsed = JSON.parse(res.text ?? "") as {
    scores?: Array<{ dimension?: string; score?: number; reasoning?: string }>;
    issues?: unknown[];
    summary?: string;
  };
  const scoresOk =
    Array.isArray(parsed.scores) &&
    parsed.scores.length > 0 &&
    parsed.scores.every(
      (s) => s.dimension !== undefined && s.score !== undefined && s.reasoning !== undefined,
    );
  if (!scoresOk || !Array.isArray(parsed.issues) || typeof parsed.summary !== "string") {
    return { name, status: "FAIL", detail: `shape mismatch: ${(res.text ?? "").slice(0, 120)}` };
  }
  return {
    name,
    status: "PASS",
    detail: `${parsed.scores!.length} scores, ${parsed.issues.length} issues`,
  };
}

async function smokeTruncation(): Promise<SmokeResult> {
  const name = "truncation (finish_reason=length)";
  const client = await createGrokClient({ apiKey: API_KEY!, maxTokens: 16 });
  try {
    await client.models.generateContent({
      model: PRIMARY_MODEL,
      contents: "Write a 500-word essay about HVAC maintenance.",
    });
    return { name, status: "FAIL", detail: "expected the truncation throw, got a response" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /finish_reason=length/.test(message)
      ? { name, status: "PASS", detail: "length throw fired" }
      : { name, status: "FAIL", detail: `unexpected error: ${message.slice(0, 120)}` };
  }
}

async function smokeParamProbe(models: LanguageModel[]): Promise<SmokeResult> {
  const name = "reasoning_effort probe (non-4.5/4.6)";
  const target = models
    .map((m) => m.id)
    .find((id): id is string => Boolean(id) && !/^grok-4\.[56]/.test(id!));
  if (!target) {
    return { name, status: "SKIP", detail: "no non-grok-4.5/4.6 model available to this key" };
  }
  // Record request bodies + response statuses (never headers) to report
  // empirically whether xAI rejects or ignores the param — the docs are silent.
  const trace: Array<{ sentParam: boolean; status: number }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
    const response = await fetch(url, init);
    trace.push({ sentParam: body.reasoning_effort !== undefined, status: response.status });
    return response;
  };
  const client = await createGrokClient({ apiKey: API_KEY!, maxTokens: 1024, fetchImpl });
  try {
    await client.models.generateContent({ model: target, contents: 'Reply "pong".' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, status: "FAIL", detail: `${target}: unrelated failure: ${message.slice(0, 120)}` };
  }
  const detail =
    trace.length === 2
      ? `${target} REJECTS reasoning_effort (HTTP ${trace[0]!.status}); adaptive retry recovered`
      : `${target} accepts/ignores reasoning_effort (HTTP ${trace[0]!.status})`;
  console.log(`  empirical: ${detail}`);
  return { name, status: "PASS", detail };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("SKIP: XAI_API_KEY not set — live smoke test not run.");
    return;
  }
  const results: SmokeResult[] = [];
  const { result: discovery, models } = await discoverModels();
  results.push(discovery);
  if (discovery.status === "PASS") {
    for (const step of [smokePlainText, smokeJsonMode, smokeTruncation]) {
      try {
        results.push(await step());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: step.name, status: "FAIL", detail: message.slice(0, 160) });
      }
    }
    results.push(await smokeParamProbe(models));
  }

  console.log("\nxAI smoke summary:");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)} ${r.name} — ${r.detail}`);
  }
  if (results.some((r) => r.status === "FAIL")) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
