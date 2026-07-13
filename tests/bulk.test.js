import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBulk } from '../src/bulk.js';

test('runBulk retries failures and resumes successful IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-text-bulk-'));
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
  assert.equal(first.succeeded, 2);
  assert.equal(first.failed, 0);
  assert.equal(first.halted, false);
  assert.equal(await fs.readFile(path.join(outputDir, 'retry.txt'), 'utf8'), 'done:retry\n');

  const second = await runBulk({ jobs, outputDir, resultsPath, retries: 1, quiet: true, generateImpl });
  assert.equal(second.skipped, 2);
  assert.equal(second.succeeded, 0);
  assert.equal(calls.get('first'), 1);

  const changed = await runBulk({
    jobs: [{ id: 'first', prompt: 'changed' }, jobs[1]],
    outputDir,
    resultsPath,
    retries: 1,
    quiet: true,
    generateImpl,
  });
  assert.equal(changed.skipped, 1);
  assert.equal(changed.succeeded, 1);
  assert.equal(calls.get('changed'), 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runBulk defers work and halts when Codex usage is exhausted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-text-quota-'));
  const error = new Error("You've hit your usage limit. Try again later.");
  error.code = 'CODEX_USAGE_LIMIT';
  error.resetAt = '2026-07-14T00:00:00.000Z';
  const summary = await runBulk({
    jobs: [{ id: 'a', prompt: 'one' }, { id: 'b', prompt: 'two' }],
    outputDir: path.join(dir, 'text'),
    resultsPath: path.join(dir, 'results.jsonl'),
    concurrency: 1,
    quiet: true,
    generateImpl: async () => { throw error; },
    memoryGuardImpl: { acquire: async () => async () => {} },
  });

  assert.equal(summary.halted, true);
  assert.equal(summary.haltReason, 'usage_limit');
  assert.equal(summary.deferred, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(summary.resetAt, '2026-07-14T00:00:00.000Z');
  const checkpoint = await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8');
  assert.match(checkpoint, /"status":"deferred"/);
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
