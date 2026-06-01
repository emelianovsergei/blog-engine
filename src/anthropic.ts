/**
 * Anthropic Claude adapter that satisfies the structural `GeminiLike` interface,
 * so it drops into every existing call site (candidates, review, rewrite) and
 * the consumer generators without touching their code.
 *
 * Text generation maps to `messages.create`. JSON-mode requests — those passing
 * `config.responseMimeType: "application/json"` + `config.responseSchema` (a plain
 * JSON Schema) — are satisfied with a forced single-tool call, so Claude returns
 * structured output validated against the same schema Gemini's `responseSchema`
 * enforced. Embeddings are not a Claude capability and are routed to Gemini by the
 * composite client (see client.ts); calling `embedContent` here throws.
 */
import type { GeminiLike } from "./types.js";

/** A content block in an Anthropic message response. */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessage {
  content: AnthropicContentBlock[];
}

export interface AnthropicCreateRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  tool_choice?: { type: string; name?: string };
}

/** Minimal structural view of the `@anthropic-ai/sdk` client we use. */
export interface AnthropicLike {
  messages: {
    create(req: AnthropicCreateRequest): Promise<AnthropicMessage>;
  };
}

export interface ClaudeAdapterOptions {
  client: AnthropicLike;
  /** Output token ceiling. Generous default covers the longest article. */
  maxTokens?: number;
}

const EMIT_TOOL = "emit_result";
// Generous ceiling: a verbose review (3 dimension rationales + many issues with
// fix text + suggestions) can run long, and a cut-off tool call yields JSON
// missing required fields. Billing is on actual output tokens, not this cap.
const DEFAULT_MAX_TOKENS = 16384;

interface GenConfig {
  responseMimeType?: string;
  responseSchema?: unknown;
}

/** Wrap an injected Anthropic client as a `GeminiLike`. */
export function claudeAdapter(opts: ClaudeAdapterOptions): GeminiLike {
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

        if (wantsJson) {
          const message = await client.messages.create({
            model: req.model,
            max_tokens: maxTokens,
            tools: [
              {
                name: EMIT_TOOL,
                description: "Return the result as structured JSON matching the schema.",
                input_schema: cfg!.responseSchema,
              },
            ],
            tool_choice: { type: "tool", name: EMIT_TOOL },
            messages: [{ role: "user", content: promptText }],
          });
          const toolUse = message.content.find((b) => b.type === "tool_use");
          if (!toolUse) {
            throw new Error("Claude returned no tool_use block for a JSON-mode request");
          }
          return { text: JSON.stringify(toolUse.input) };
        }

        const message = await client.messages.create({
          model: req.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: promptText }],
        });
        const text = message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        return { text };
      },

      async embedContent() {
        throw new Error("Claude adapter does not support embeddings (route to Gemini)");
      },
    },
  };
}

/**
 * Build a Claude-backed `GeminiLike` from an API key. Dynamically imports
 * `@anthropic-ai/sdk` so the library keeps no hard runtime dependency on it.
 */
export async function createClaudeClient(opts: {
  apiKey: string;
  maxTokens?: number;
}): Promise<GeminiLike> {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (init: { apiKey: string }) => AnthropicLike;
  };
  const client = new mod.default({ apiKey: opts.apiKey });
  return claudeAdapter({ client, ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) });
}
