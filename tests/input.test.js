import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inputInternals, loadJobs, renderTemplate } from '../src/input.js';

test('renderTemplate supports nested values', () => {
  assert.equal(renderTemplate('Hello {{ user.name }}', { user: { name: 'Tibo' } }), 'Hello Tibo');
});

test('CSV parser supports commas and escaped quotes', () => {
  assert.deepEqual(inputInternals.parseCsv('id,prompt\n1,"Hello, ""world"""\n'), [
    ['id', 'prompt'],
    ['1', 'Hello, "world"'],
  ]);
});

test('loadJobs renders a JSONL template', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtt-input-'));
  const input = path.join(dir, 'jobs.jsonl');
  await fs.writeFile(input, '{"id":"a","topic":"batching"}\n');
  const jobs = await loadJobs(input, { template: 'Write about {{topic}}.' });
  assert.equal(jobs[0].id, 'a');
  assert.equal(jobs[0].prompt, 'Write about batching.');
  await fs.rm(dir, { recursive: true, force: true });
});
