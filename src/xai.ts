/**
 * xAI Grok adapter that satisfies the structural `GeminiLike` interface,
 * so it drops into every existing call site (candidates, review, rewrite)
 * and the consumer generators without touching their code.
 *
 * Text generation maps to Chat Completions. JSON-mode requests — those
 * passing `config.responseMimeType: "application/json"` + `config.responseSchema`
 * — are satisfied with `response_format.json_schema`. Embeddings are not an
 * xAI capability and are routed to Gemini by the composite client (see
 * client.ts); calling `embedContent` here throws.
 */
import type { GeminiLike } from "./types.js";

export interface XaiChatRequest {
  model: string;
  max_tokens: number;
  reasoning_effort?: "low" | "high";
  messages: Array<{ role: string; content: string }>;
  response_format?: {
    type: string;
    json_schema?: { name: string; strict: boolean; schema: unknown };
  };
}

export interface XaiChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

/** Minimal structural view of the xAI chat client we use. */
export interface XaiLike {
  chatCompletions(req: XaiChatRequest): Promise<XaiChatResponse>;
}

/**
 * HTTP failure from the xAI endpoint. The message keeps the established
 * `xAI HTTP <status>: <detail>` shape (truncated, matched by
 * isTransientError in client.ts); `body` carries the untruncated response
 * so the adapter can inspect what the API actually rejected.
 */
export class XaiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`xAI HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "XaiHttpError";
  }
}

const REASONING_EFFORT_REJECTION = /reasoning[_\s.-]*effort/i;

/**
 * True when the error is a non-transient 4xx whose body names the
 * `reasoning_effort` parameter — i.e. this model rejects the param rather
 * than the request being otherwise malformed. Requiring the parameter name
 * (not generic "unknown parameter" phrasing) keeps unrelated 400s failing
 * over to Claude instead of poisoning the unsupported-model memo.
 */
function isReasoningEffortRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status =
    error instanceof XaiHttpError
      ? error.status
      : Number(/\bxAI HTTP (4\d{2})\b/.exec(error.message)?.[1] ?? NaN);
  if (!(status >= 400 && status < 500) || status === 429) return false;
  const haystack = error instanceof XaiHttpError ? error.body : error.message;
  return REASONING_EFFORT_REJECTION.test(haystack);
}

export interface GrokAdapterOptions {
  client: XaiLike;
  /** Output token ceiling. Generous default covers the longest article. */
  maxTokens?: number;
}

const EMIT_SCHEMA_NAME = "emit_result";
const DEFAULT_MAX_TOKENS = 16384;
const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
// Long enough for a 16k-token rewrite at reasoning_effort=low; short enough
// that a hung xAI socket fails over to Claude instead of burning a CI runner.
// Timeouts are *not* retried on the same provider (see isTransientError).
const REQUEST_TIMEOUT_MS = 180_000;

interface GenConfig {
  responseMimeType?: string;
  responseSchema?: unknown;
}

/** Wrap an injected xAI client as a `GeminiLike`. */
export function grokAdapter(opts: GrokAdapterOptions): GeminiLike {
  const { client } = opts;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Models observed to reject reasoning_effort (see the behavioral probe
  // below). Per-adapter, so one process pays at most one stripped retry
  // per model.
  const reasoningEffortUnsupported = new Set<string>();

  return {
    models: {
      async generateContent(req) {
        const promptText =
          typeof req.contents === "string" ? req.contents : JSON.stringify(req.contents);
        const cfg = (req.config ?? undefined) as GenConfig | undefined;
        const wantsJson =
          cfg?.responseMimeType === "application/json" && cfg.responseSchema !== undefined;

        const body: XaiChatRequest = {
          model: req.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: promptText }],
        };
        // Behavioral probe: the xAI models API exposes no capability flags,
        // and docs.x.ai/docs/guides/reasoning only documents reasoning_effort
        // for grok-4.5/grok-4.6 — so send it by default and learn from a
        // rejection (below) instead of hardcoding a model list.
        if (!reasoningEffortUnsupported.has(req.model)) {
          body.reasoning_effort = "low";
        }
        if (wantsJson) {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: EMIT_SCHEMA_NAME,
              // Existing Gemini schemas omit additionalProperties:false and
              // leave optional fields out of `required`. OpenAI-compatible
              // strict mode rejects both; xAI still validates the shape.
              strict: false,
              schema: cfg!.responseSchema,
            },
          };
        }

        let response: XaiChatResponse;
        try {
          response = await client.chatCompletions(body);
        } catch (error) {
          if (body.reasoning_effort !== undefined && isReasoningEffortRejection(error)) {
            reasoningEffortUnsupported.add(req.model);
            const { reasoning_effort: _rejected, ...stripped } = body;
            response = await client.chatCompletions(stripped);
          } else {
            throw error;
          }
        }
        const choice = response.choices?.[0];
        const text = choice?.message?.content?.trim() ?? "";
        if (choice?.finish_reason === "length") {
          throw new Error(
            "Grok response truncated (finish_reason=length) — try again later",
          );
        }
        if (wantsJson) {
          if (!text) {
            throw new Error("Grok returned empty content for a JSON-mode request — try again later");
          }
          try {
            JSON.parse(text);
          } catch {
            throw new Error("Grok JSON-mode response was not valid JSON — try again later");
          }
        }
        return { text };
      },

      async embedContent() {
        throw new Error("Grok adapter does not support embeddings (route to Gemini)");
      },
    },
  };
}

/**
 * Build a Grok-backed `GeminiLike` from an API key. Uses stdlib `fetch`
 * (injectable for tests) so the library keeps no hard runtime dependency
 * on an xAI SDK.
 */
export async function createGrokClient(opts: {
  apiKey: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): Promise<GeminiLike> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const client: XaiLike = {
    async chatCompletions(req) {
      const response = await fetchImpl(XAI_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new XaiHttpError(response.status, detail);
      }
      return (await response.json()) as XaiChatResponse;
    },
  };
  return grokAdapter({ client, ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) });
}

/**
 * xAI Grok Imagine image generation.
 *
 * Separate endpoint and model family from chat (`/v1/images/generations`,
 * `grok-imagine-*`), so this is a standalone helper rather than part of the
 * `GeminiLike` adapter — that interface only covers text + embeddings.
 *
 * Returns raw bytes: `response_format: "b64_json"` avoids a second round-trip
 * to a signed URL that expires, which is what the caller wants when the image
 * is about to be written to disk and committed.
 */
export interface GrokImageOptions {
  apiKey: string;
  prompt: string;
  /** Defaults to grok-imagine-image-2.0, xAI's recommended image model. */
  model?: string;
  /** e.g. "16:9" (default), "1:1", "auto". */
  aspectRatio?: string;
  resolution?: "1k" | "2k";
  /** Only honored by grok-imagine-image-2.0. */
  quality?: "low" | "medium";
  fetchImpl?: typeof fetch;
}

interface XaiImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

const XAI_IMAGE_URL = "https://api.x.ai/v1/images/generations";
const DEFAULT_IMAGE_MODEL = "grok-imagine-image-2.0";

export async function generateGrokImage(opts: GrokImageOptions): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = {
    model: opts.model ?? DEFAULT_IMAGE_MODEL,
    prompt: opts.prompt,
    n: 1,
    response_format: "b64_json",
    aspect_ratio: opts.aspectRatio ?? "16:9",
    ...(opts.resolution ? { resolution: opts.resolution } : {}),
    ...(opts.quality ? { quality: opts.quality } : {}),
  };

  const response = await fetchImpl(XAI_IMAGE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new XaiHttpError(response.status, detail);
  }

  const payload = (await response.json()) as XaiImageResponse;
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("xAI image response contained no b64_json data");
  }
  return Buffer.from(b64, "base64");
}
