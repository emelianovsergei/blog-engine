/** Semantic duplicate detection via Gemini embeddings + cosine similarity. */
import type { CandidateTopic, ExistingPostLike, GeminiLike } from "./types.js";

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
/** Candidates at or above this cosine similarity to an existing post are rejected. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.86;

export interface DuplicationScore {
  /** Highest cosine similarity to any existing post (0-1). */
  maxSimilarity: number;
  /** Slug of the closest existing post, or null when there are none. */
  nearestSlug: string | null;
}

export interface DuplicationResult {
  /** Index-aligned with the input candidates. */
  scores: DuplicationScore[];
  /** False when the embedding call failed and dedup degraded to a no-op. */
  available: boolean;
}

/** Cosine similarity of two equal-length-ish vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embed(gemini: GeminiLike, model: string, texts: string[]): Promise<number[][]> {
  const response = await gemini.models.embedContent({ model, contents: texts });
  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: asked for ${texts.length}, got ${embeddings.length}`,
    );
  }
  return embeddings.map((entry) => entry.values ?? []);
}

export interface ScoreDuplicationArgs {
  gemini: GeminiLike;
  candidates: CandidateTopic[];
  existingPosts: ExistingPostLike[];
  model?: string;
}

/**
 * Scores every candidate by its nearest existing post. If the embedding call
 * fails, returns all-zero scores with `available: false` so the run continues
 * on slug-only + prompt-level dedup rather than failing.
 */
export async function scoreDuplication(args: ScoreDuplicationArgs): Promise<DuplicationResult> {
  const { gemini, candidates, existingPosts } = args;
  const model = args.model ?? DEFAULT_EMBEDDING_MODEL;
  const zero = (): DuplicationScore => ({ maxSimilarity: 0, nearestSlug: null });

  if (candidates.length === 0) return { scores: [], available: true };
  if (existingPosts.length === 0) {
    return { scores: candidates.map(zero), available: true };
  }

  const candidateTexts = candidates.map((c) => `${c.topic} ${c.notes}`.trim());
  const postTexts = existingPosts.map((p) => `${p.title} ${p.description ?? ""}`.trim());

  try {
    const [candidateVecs, postVecs] = await Promise.all([
      embed(gemini, model, candidateTexts),
      embed(gemini, model, postTexts),
    ]);
    const scores = candidateVecs.map((vec) => {
      let maxSimilarity = 0;
      let nearestSlug: string | null = null;
      postVecs.forEach((postVec, index) => {
        const similarity = cosineSimilarity(vec, postVec);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          nearestSlug = existingPosts[index]?.slug ?? null;
        }
      });
      return { maxSimilarity, nearestSlug };
    });
    return { scores, available: true };
  } catch {
    return { scores: candidates.map(zero), available: false };
  }
}
