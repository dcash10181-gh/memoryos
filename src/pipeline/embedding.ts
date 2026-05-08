import OpenAI from 'openai';
import { getConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const key = getConfig().embedding.api_key ?? process.env.OPENAI_API_KEY ?? '';
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// ─── Batch embed with retry + rate-limit backoff ──────────────────────────────
export async function embedTexts(
  texts: string[],
  retries = 3
): Promise<number[][]> {
  const { provider, model, dimensions } = getConfig().embedding;

  // Truncate to avoid token limits — ~8000 tokens max for text-embedding-3-small
  const truncated = texts.map(t => t.slice(0, 24_000));

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (provider === 'openai') {
        const res = await getOpenAI().embeddings.create({
          model,
          input: truncated,
          dimensions,
        });
        return res.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
      }

      if (provider === 'voyage') {
        return await embedVoyage(truncated, model);
      }

      // Local fallback — deterministic hash-based pseudo-embedding for dev/testing
      return truncated.map(t => hashEmbed(t, dimensions));

    } catch (err: unknown) {
      const isRateLimit = err instanceof Error && err.message.includes('429');
      if (attempt < retries && isRateLimit) {
        const delay = Math.pow(2, attempt) * 2000;
        logger.warn(`[embed] Rate limited — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  return truncated.map(t => hashEmbed(t, dimensions));
}

export async function embedText(text: string): Promise<number[]> {
  const results = await embedTexts([text]);
  return results[0];
}

// ─── Cosine similarity for deduplication ──────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ─── Voyage AI (recommended by Anthropic for retrieval) ──────────────────────
async function embedVoyage(texts: string[], model: string): Promise<number[][]> {
  const { default: axios } = await import('axios');
  const { data } = await axios.post(
    'https://api.voyageai.com/v1/embeddings',
    { input: texts, model },
    { headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` } }
  );
  return data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    .map((d: { embedding: number[] }) => d.embedding);
}

// ─── Deterministic local embed (dev/offline mode) ────────────────────────────
function hashEmbed(text: string, dims: number): number[] {
  const vec = new Float32Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += text.charCodeAt(i) / 127;
  }
  // L2-normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) + 1e-10;
  return Array.from(vec).map(v => v / norm);
}
