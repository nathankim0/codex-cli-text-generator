import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkCodex, generateText } from '../src/codex.js';

test('checkCodex requires ChatGPT login', async () => {
  const execImpl = async (_file, args) => args[0] === '--version'
    ? { stdout: 'codex-cli 1.0.0', stderr: '' }
    : { stdout: 'Logged in using ChatGPT', stderr: '' };
  const result = await checkCodex({ execImpl });
  assert.match(result.version, /1.0.0/);
});

test('generateText passes the prompt over stdin and reads final output', async () => {
  let received;
  const execImpl = async (_file, args, options) => {
    received = { args, options };
    const outputIndex = args.indexOf('--output-last-message');
    await fs.writeFile(args[outputIndex + 1], 'finished text\n');
    return { stdout: '', stderr: '' };
  };
  const result = await generateText({ prompt: 'secret prompt', execImpl });
  assert.equal(result.text, 'finished text');
  assert.equal(received.options.input, 'secret prompt');
  assert.equal(received.args.includes('secret prompt'), false);
  assert.equal(received.args[received.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(received.args.includes('--ephemeral'));
});
