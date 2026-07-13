import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBulk } from '../src/bulk.js';

test('runBulk retries failures and resumes successful IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtt-bulk-'));
  const outputDir = path.join(dir, 'text');
  const resultsPath = path.join(dir, 'results.jsonl');
  const calls = new Map();
  const generateImpl = async ({ prompt }) => {
    const count = (calls.get(prompt) ?? 0) + 1;
    calls.set(prompt, count);
    if (prompt === 'retry' && count === 1) throw new Error('temporary');
    return { text: `done:${prompt}` };
  };
  const jobs = [
    { id: 'first', prompt: 'first' },
    { id: 'retry', prompt: 'retry' },
  ];

  const first = await runBulk({
    jobs,
    outputDir,
    resultsPath,
    retries: 1,
    batchSize: 1,
    batchDelayMs: 0,
    quiet: true,
    generateImpl,
  });
  assert.deepEqual(first, { total: 2, skipped: 0, succeeded: 2, failed: 0 });
  assert.equal(await fs.readFile(path.join(outputDir, 'retry.txt'), 'utf8'), 'done:retry\n');

  const second = await runBulk({ jobs, outputDir, resultsPath, retries: 1, quiet: true, generateImpl });
  assert.deepEqual(second, { total: 2, skipped: 2, succeeded: 0, failed: 0 });
  assert.equal(calls.get('first'), 1);

  const changed = await runBulk({
    jobs: [{ id: 'first', prompt: 'changed' }, jobs[1]],
    outputDir,
    resultsPath,
    retries: 1,
    quiet: true,
    generateImpl,
  });
  assert.deepEqual(changed, { total: 2, skipped: 1, succeeded: 1, failed: 0 });
  assert.equal(calls.get('changed'), 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runBulk rejects duplicate IDs before writing outputs', async () => {
  await assert.rejects(
    runBulk({
      jobs: [{ id: 'same', prompt: 'one' }, { id: 'same', prompt: 'two' }],
      quiet: true,
      generateImpl: async () => ({ text: 'unused' }),
    }),
    /Duplicate job ID: same/,
  );
});
