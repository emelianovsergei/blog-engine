/**
 * Composite `GeminiLike` client: Grok or Claude primary (with retry), Gemini fallback.
 *
 * Provider is chosen by the per-call model-id prefix, so every existing call
 * site keeps passing its own model string:
 *   - "grok-*"    → Grok (transient-retry); on any failure, fall back to Gemini
 *                   using `geminiFallbackModel`. If no Grok client is configured,
 *                   go straight to the Gemini fallback.
 *   - "claude-*"  → Claude (transient-retry); same Gemini fallback.
 *   - "gemini-*"  → Gemini directly (same transient-retry).
 *   - embeddings  → always Gemini (neither Grok nor Claude has an embedding API).
 *
 * `@google/genai` 503 "high demand" outages, `@anthropic-ai/sdk` hiccups, and
 * xAI HTTP blips are absorbed: transient errors retry with exponential backoff,
 * and a dead primary degrades to the other provider rather than failing the run.
 */
import { createClaudeClient } from "./anthropic.js";
import { createGrokClient } from "./xai.js";
import type { GeminiLike } from "./types.js";

const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";
const DEFAULT_RETRIES = 3;

/** True for retryable upstream errors (rate limits, 5xx, model-overload signals). */
export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(429|500|502|503|504)\b/.test(message) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand|try again later/i.test(message)
  );
}

export interface CompositeClientOptions {
  /** Grok-backed GeminiLike (primary for "grok-*" models). */
  xai?: GeminiLike;
  /** Claude-backed GeminiLike (primary for "claude-*" models). */
  claude?: GeminiLike;
  /** Gemini-backed GeminiLike (fallback for text, sole provider for embeddings). */
  gemini?: GeminiLike;
  /** Gemini model used when falling back from Grok or Claude. */
  geminiFallbackModel?: string;
  /** Max attempts per provider for transient errors. Default 3. */
  retries?: number;
  /** Backoff sleep; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type GenReq = Parameters<GeminiLike["models"]["generateContent"]>[0];
type GenRes = Awaited<ReturnType<GeminiLike["models"]["generateContent"]>>;

async function withRetry(
  fn: () => Promise<GenRes>,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GenRes> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error)) throw error;
      if (attempt < retries - 1) await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function createCompositeClient(opts: CompositeClientOptions): GeminiLike {
  const { xai, claude, gemini } = opts;
  const fallbackModel = opts.geminiFallbackModel ?? DEFAULT_GEMINI_FALLBACK_MODEL;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;

  const geminiFallback = (req: GenReq): Promise<GenRes> => {
    if (!gemini) {
      throw new Error(
        "No model provider available (set XAI_API_KEY and/or ANTHROPIC_API_KEY and/or GEMINI_API_KEY)",
      );
    }
    return withRetry(() => gemini.models.generateContent({ ...req, model: fallbackModel }), retries, sleep);
  };

  return {
    models: {
      async generateContent(req) {
        if (req.model.startsWith("grok")) {
          if (xai) {
            try {
              return await withRetry(() => xai.models.generateContent(req), retries, sleep);
            } catch (error) {
              if (!gemini) throw error;
              return geminiFallback(req);
            }
          }
          return geminiFallback(req);
        }
        if (req.model.startsWith("claude")) {
          if (claude) {
            try {
              return await withRetry(() => claude.models.generateContent(req), retries, sleep);
            } catch (error) {
              if (!gemini) throw error;
              return geminiFallback(req);
            }
          }
          return geminiFallback(req);
        }
        // gemini-* (and anything else) → Gemini directly.
        if (!gemini) {
          throw new Error("No Gemini client configured for model " + req.model);
        }
        return withRetry(() => gemini.models.generateContent(req), retries, sleep);
      },

      async embedContent(req) {
        if (!gemini) {
          throw new Error("Embeddings require a Gemini client (set GEMINI_API_KEY)");
        }
        return gemini.models.embedContent(req);
      },
    },
  };
}

/**
 * Build the composite client from credentials. Grok is included when an xAI
 * key is supplied; Claude when an Anthropic key is supplied. Otherwise the
 * client degrades to Gemini-only (embeddings still require Gemini).
 */
export async function createModelClient(opts: {
  xaiApiKey?: string;
  anthropicApiKey?: string;
  geminiClient?: GeminiLike;
  geminiFallbackModel?: string;
  maxTokens?: number;
}): Promise<GeminiLike> {
  const xai = opts.xaiApiKey
    ? await createGrokClient({
        apiKey: opts.xaiApiKey,
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      })
    : undefined;
  const claude = opts.anthropicApiKey
    ? await createClaudeClient({
        apiKey: opts.anthropicApiKey,
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      })
    : undefined;
  return createCompositeClient({
    ...(xai ? { xai } : {}),
    ...(claude ? { claude } : {}),
    ...(opts.geminiClient ? { gemini: opts.geminiClient } : {}),
    ...(opts.geminiFallbackModel ? { geminiFallbackModel: opts.geminiFallbackModel } : {}),
  });
}
