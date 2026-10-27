import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReprocessMemory } from '../src/application/reprocess-memory.js';
import type { MemoryEmbeddingRepository } from '../src/application/ports.js';

test('reprocessing resolves one model per bounded batch and stops on uncertain writes', async () => {
  const writes: string[] = [];
  let resolutions = 0;
  const repository: MemoryEmbeddingRepository = {
    embeddingBatch: async (after, limit) => {
      assert.equal(after, '0');
      assert.equal(limit, 10);
      return [
        { id: '1', text: 'first' },
        { id: '2', text: 'second' },
      ];
    },
    replaceEmbedding: async (id, text, vector, space) => {
      assert.equal(space, 'new-model');
      assert.deepEqual(vector, [1, 0]);
      assert.equal(text, id === '1' ? 'first' : 'second');
      writes.push(id);
      if (id === '2') throw new Error('uncertain write');
    },
  };
  const task = new ReprocessMemory(repository, {
    enabled: true,
    embed: async () => {
      throw new Error('must resolve');
    },
    resolve: async () => {
      resolutions++;
      return {
        enabled: true,
        space: 'new-model',
        embed: async (_text, type) => {
          assert.equal(type, 'RETRIEVAL_DOCUMENT');
          return [1, 0];
        },
      };
    },
  });
  await assert.rejects(task.batch('0'), /uncertain write/);
  assert.deepEqual(writes, ['1', '2']);
  assert.equal(resolutions, 1);
});

test('disabled embeddings never read or mutate memories', async () => {
  const task = new ReprocessMemory(
    {
      embeddingBatch: async () => {
        throw new Error('must not read');
      },
      replaceEmbedding: async () => {
        throw new Error('must not write');
      },
    },
    { enabled: false, embed: async () => [] },
  );
  await assert.rejects(task.batch('0'), /Activa y guarda/);
});

test('completed batch reports cursor and completion without touching memory content', async () => {
  const writes: string[] = [];
  const task = new ReprocessMemory(
    {
      embeddingBatch: async () => [{ id: '17', text: 'remember this' }],
      replaceEmbedding: async (id) => {
        writes.push(id);
      },
    },
    { enabled: true, space: 'new', embed: async () => [1, 0] },
  );
  assert.deepEqual(await task.batch('10'), { processed: 1, after: '17', done: true });
  assert.deepEqual(writes, ['17']);
});
