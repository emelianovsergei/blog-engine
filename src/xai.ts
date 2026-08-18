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
        // Per docs.x.ai/docs/guides/reasoning only grok-4.5 / grok-4.6 accept
        // reasoning_effort; other models may reject it, and a 4xx here is a
        // permanent (non-transient) fall-through to the Claude leg.
        if (/^grok-4\.[56]/.test(req.model)) {
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

        const response = await client.chatCompletions(body);
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
        throw new Error(`xAI HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      return (await response.json()) as XaiChatResponse;
    },
  };
  return grokAdapter({ client, ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) });
}
