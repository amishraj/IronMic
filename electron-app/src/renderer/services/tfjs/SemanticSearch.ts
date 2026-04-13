/**
 * SemanticSearch — On-device semantic search using Universal Sentence Encoder.
 *
 * Generates 512-dim embeddings for all content and performs cosine similarity
 * search across entries, notes, and AI sessions simultaneously.
 *
 * Embeddings are stored in SQLite via the Rust core and retrieved for
 * similarity computation in the ML Web Worker.
 */

import { MLClient } from '../../workers/ml-client';
import type { EmbeddingResult, SimilarityResult } from '../../workers/types';

export interface SemanticSearchResult {
  contentId: string;
  contentType: string;
  score: number;
  /** Text preview (loaded separately) */
  preview?: string;
}

export interface IndexingProgress {
  total: number;
  indexed: number;
  inProgress: boolean;
}

export class SemanticSearch {
  private modelLoaded = false;
  private indexing = false;

  /**
   * Load the Universal Sentence Encoder model.
   */
  async loadModel(): Promise<void> {
    if (this.modelLoaded) return;

    try {
      await MLClient.init();

      const ironmic = (window as any).ironmic;
      const modelsDir = ironmic?.getModelsDir ? await ironmic.getModelsDir() : '';

      if (modelsDir) {
        await MLClient.initModel('universal-sentence-encoder', {
          modelUrl: `file://${modelsDir}/tfjs/use/model.json`,
          config: { embeddingDim: 512 },
        });
        this.modelLoaded = true;
        console.log('[SemanticSearch] USE model loaded');
      } else {
        console.warn('[SemanticSearch] Models directory not available');
      }
    } catch (err) {
      console.warn('[SemanticSearch] Failed to load USE model:', err);
    }
  }

  isModelLoaded(): boolean {
    return this.modelLoaded;
  }

  /**
   * Generate an embedding for a text string.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.modelLoaded) return null;

    try {
      const result = await MLClient.embed(text) as EmbeddingResult;
      return result.embedding;
    } catch (err) {
      console.warn('[SemanticSearch] Embedding failed:', err);
      return null;
    }
  }

  /**
   * Embed and store content in the database.
   */
  async embedAndStore(contentId: string, contentType: string, text: string): Promise<boolean> {
    const embedding = await this.embed(text);
    if (!embedding) return false;

    const ironmic = (window as any).ironmic;
    if (!ironmic?.embeddingStore) return false;

    try {
      // Convert Float32Array to Buffer for IPC
      const buffer = Buffer.from(embedding.buffer);
      await ironmic.embeddingStore(contentId, contentType, buffer, 'use-v1');
      return true;
    } catch (err) {
      console.warn('[SemanticSearch] Failed to store embedding:', err);
      return false;
    }
  }

  /**
   * Search for similar content by query text.
   */
  async search(query: string, topK: number = 10): Promise<SemanticSearchResult[]> {
    if (!this.modelLoaded) return [];

    const ironmic = (window as any).ironmic;
    if (!ironmic?.embeddingGetAllWithData) return [];

    try {
      // 1. Embed the query
      const queryEmbedding = await this.embed(query);
      if (!queryEmbedding) return [];

      // 2. Get all stored embeddings
      const rawBuffer: Buffer = await ironmic.embeddingGetAllWithData(null);
      if (!rawBuffer || rawBuffer.length < 4) return [];

      // 3. Parse the packed binary format from Rust
      const allEmbeddings = this.parseEmbeddingBuffer(rawBuffer);
      if (allEmbeddings.length === 0) return [];

      // 4. Compute cosine similarity
      const results = this.cosineSimilaritySearch(queryEmbedding, allEmbeddings, topK);
      return results;
    } catch (err) {
      console.warn('[SemanticSearch] Search failed:', err);
      return [];
    }
  }

  /**
   * Index all unembedded content (background batch process).
   */
  async indexUnembeddedContent(
    onProgress?: (progress: IndexingProgress) => void,
  ): Promise<number> {
    if (!this.modelLoaded || this.indexing) return 0;

    const ironmic = (window as any).ironmic;
    if (!ironmic?.embeddingGetUnembedded) return 0;

    this.indexing = true;
    let indexed = 0;

    try {
      // Get unembedded entries
      const unembeddedJson = await ironmic.embeddingGetUnembedded(100);
      const unembedded: Array<{ id: string; text: string }> = JSON.parse(unembeddedJson);

      const total = unembedded.length;
      onProgress?.({ total, indexed: 0, inProgress: true });

      // Process in batches of 5
      for (let i = 0; i < unembedded.length; i += 5) {
        const batch = unembedded.slice(i, i + 5);
        await Promise.all(
          batch.map(async (item) => {
            const success = await this.embedAndStore(item.id, 'entry', item.text);
            if (success) indexed++;
          }),
        );
        onProgress?.({ total, indexed, inProgress: true });
      }
    } catch (err) {
      console.warn('[SemanticSearch] Indexing failed:', err);
    } finally {
      this.indexing = false;
      onProgress?.({ total: indexed, indexed, inProgress: false });
    }

    console.log(`[SemanticSearch] Indexed ${indexed} entries`);
    return indexed;
  }

  /**
   * Get indexing statistics.
   */
  async getStats(): Promise<{ total: number; byType: Record<string, number> }> {
    const ironmic = (window as any).ironmic;
    if (!ironmic?.embeddingGetStats) {
      return { total: 0, byType: {} };
    }

    try {
      const statsJson = await ironmic.embeddingGetStats();
      const byType: Record<string, number> = JSON.parse(statsJson);
      const total = Object.values(byType).reduce((sum, count) => sum + count, 0);
      return { total, byType };
    } catch {
      return { total: 0, byType: {} };
    }
  }

  /**
   * Delete all embeddings and reset.
   */
  async resetIndex(): Promise<void> {
    const ironmic = (window as any).ironmic;
    if (ironmic?.embeddingDeleteAll) {
      await ironmic.embeddingDeleteAll();
    }
  }

  // ── Internal ──

  /**
   * Parse the packed binary format returned by Rust's getAllEmbeddingsWithData.
   * Format: [count(u32), then for each: id_len(u32), id_bytes, type_len(u32), type_bytes, emb_len(u32), emb_bytes]
   */
  private parseEmbeddingBuffer(
    buffer: Buffer,
  ): Array<{ contentId: string; contentType: string; embedding: Float32Array }> {
    const results: Array<{ contentId: string; contentType: string; embedding: Float32Array }> = [];
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;

    if (buffer.length < 4) return results;

    const count = view.getUint32(offset, true);
    offset += 4;

    for (let i = 0; i < count && offset < buffer.length; i++) {
      // Content ID
      const idLen = view.getUint32(offset, true);
      offset += 4;
      const contentId = new TextDecoder().decode(buffer.slice(offset, offset + idLen));
      offset += idLen;

      // Content Type
      const typeLen = view.getUint32(offset, true);
      offset += 4;
      const contentType = new TextDecoder().decode(buffer.slice(offset, offset + typeLen));
      offset += typeLen;

      // Embedding
      const embLen = view.getUint32(offset, true);
      offset += 4;
      const embBytes = buffer.slice(offset, offset + embLen);
      offset += embLen;

      // Convert bytes to Float32Array
      const embedding = new Float32Array(embBytes.buffer, embBytes.byteOffset, embBytes.byteLength / 4);

      results.push({ contentId, contentType, embedding: new Float32Array(embedding) });
    }

    return results;
  }

  /**
   * Compute cosine similarity between a query and all stored embeddings.
   */
  private cosineSimilaritySearch(
    query: Float32Array,
    embeddings: Array<{ contentId: string; contentType: string; embedding: Float32Array }>,
    topK: number,
  ): SemanticSearchResult[] {
    // Precompute query norm
    let queryNorm = 0;
    for (let i = 0; i < query.length; i++) {
      queryNorm += query[i] * query[i];
    }
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return [];

    const scores: SemanticSearchResult[] = [];

    for (const item of embeddings) {
      let dot = 0;
      let itemNorm = 0;
      const emb = item.embedding;
      const len = Math.min(query.length, emb.length);

      for (let i = 0; i < len; i++) {
        dot += query[i] * emb[i];
        itemNorm += emb[i] * emb[i];
      }
      itemNorm = Math.sqrt(itemNorm);
      if (itemNorm === 0) continue;

      const score = dot / (queryNorm * itemNorm);
      scores.push({
        contentId: item.contentId,
        contentType: item.contentType,
        score,
      });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }
}

/** Singleton instance */
export const semanticSearch = new SemanticSearch();
