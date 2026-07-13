import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { generateText } from './codex.js';
import { createMemoryGuard } from './resources.js';

function safeFileName(value) {
  const safe = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'item';
}

async function completedJobs(resultsPath) {
  const content = await fs.readFile(resultsPath, 'utf8').catch(() => '');
  const completed = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const result = JSON.parse(line);
      if (result.status === 'success') completed.set(String(result.id), result.fingerprint ?? null);
    } catch {
      // A partially written last line should not block resuming earlier jobs.
    }
  }
  return completed;
}

function jobFingerprint(job, generateOptions) {
  const relevantOptions = {
    model: generateOptions.model ?? null,
    profile: generateOptions.profile ?? null,
    outputSchema: generateOptions.outputSchema ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify({ prompt: job.prompt, options: relevantOptions }))
    .digest('hex');
}

function createJsonlWriter(filePath) {
  let pending = Promise.resolve();
  return (record) => {
    pending = pending.then(() => fs.appendFile(filePath, `${JSON.stringify(record)}\n`));
    return pending;
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

function assertUniqueIds(jobs) {
  const seen = new Set();
  for (const job of jobs) {
    const id = String(job.id);
    if (seen.has(id)) throw new Error(`Duplicate job ID: ${id}`);
    seen.add(id);
  }
}

export async function runBulk({
  jobs,
  outputDir = 'output/text',
  resultsPath = 'output/results.jsonl',
  concurrency = 2,
  retries = 2,
  batchSize = 20,
  batchDelayMs = 5_000,
  minFreeMemoryMb = 1024,
  memoryPerWorkerMb = 512,
  memoryPollMs = 15_000,
  resume = true,
  extension = 'txt',
  quiet = false,
  generateImpl = generateText,
  generateOptions = {},
  memoryGuardImpl,
} = {}) {
  if (!Array.isArray(jobs)) throw new Error('jobs must be an array.');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be at least 1.');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries cannot be negative.');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be at least 1.');
  if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) throw new Error('batchDelayMs cannot be negative.');
  if (!Number.isFinite(minFreeMemoryMb) || minFreeMemoryMb < 0) throw new Error('minFreeMemoryMb cannot be negative.');
  if (!Number.isFinite(memoryPerWorkerMb) || memoryPerWorkerMb < 0) throw new Error('memoryPerWorkerMb cannot be negative.');
  if (!Number.isFinite(memoryPollMs) || memoryPollMs < 1) throw new Error('memoryPollMs must be positive.');
  assertUniqueIds(jobs);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  const done = resume ? await completedJobs(resultsPath) : new Map();
  const preparedJobs = jobs.map((job) => ({ ...job, fingerprint: jobFingerprint(job, generateOptions) }));
  const pendingJobs = preparedJobs.filter((job) => done.get(String(job.id)) !== job.fingerprint);
  const writeResult = createJsonlWriter(resultsPath);
  const summary = {
    total: jobs.length,
    skipped: jobs.length - pendingJobs.length,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    remaining: 0,
    halted: false,
    haltReason: null,
    resetAt: null,
  };
  let processed = 0;
  let lastMemoryNoticeAt = 0;
  const memoryGuard = memoryGuardImpl ?? createMemoryGuard({
    minFreeMemoryMb,
    memoryPerWorkerMb,
    pollMs: memoryPollMs,
    onWait: ({ availableMb, requiredMb }) => {
      if (quiet || Date.now() - lastMemoryNoticeAt < memoryPollMs - 10) return;
      lastMemoryNoticeAt = Date.now();
      process.stderr.write(`memory guard: ${availableMb} MiB available, waiting for ${requiredMb} MiB\n`);
    },
  });

  function haltForUsageLimit(error) {
    summary.halted = true;
    summary.haltReason = 'usage_limit';
    summary.resetAt = summary.resetAt ?? error.resetAt ?? null;
  }

  async function runChunk(chunk) {
    let cursor = 0;
    async function worker() {
      while (cursor < chunk.length) {
        if (summary.halted) return;
        const job = chunk[cursor++];
        const releaseMemory = await memoryGuard.acquire({ shouldStop: () => summary.halted });
        if (!releaseMemory) return;
        const startedAt = new Date();
        let lastError;
        let deferred = false;

        try {
          for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
            try {
              const result = await generateImpl({ prompt: job.prompt, ...generateOptions });
              const outputPath = path.join(outputDir, `${safeFileName(job.id)}.${extension}`);
              await writeFileAtomic(outputPath, `${result.text}\n`);
              const finishedAt = new Date();
              await writeResult({
                id: job.id,
                fingerprint: job.fingerprint,
                status: 'success',
                attempt,
                outputPath,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: finishedAt - startedAt,
              });
              summary.succeeded += 1;
              processed += 1;
              if (!quiet) process.stderr.write(`[${processed}/${pendingJobs.length}] ok ${job.id}\n`);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (error.code === 'CODEX_USAGE_LIMIT' || summary.halted) {
                if (error.code === 'CODEX_USAGE_LIMIT') haltForUsageLimit(error);
                deferred = true;
                break;
              }
              if (attempt <= retries) {
                const backoff = Math.min(1_000 * 2 ** (attempt - 1), 10_000);
                await delay(backoff + Math.floor(Math.random() * 250));
              }
            }
          }

          if (deferred) {
            const finishedAt = new Date();
            await writeResult({
              id: job.id,
              fingerprint: job.fingerprint,
              status: 'deferred',
              reason: 'usage_limit',
              resetAt: summary.resetAt,
              startedAt: startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              durationMs: finishedAt - startedAt,
            });
            summary.deferred += 1;
            processed += 1;
            if (!quiet) process.stderr.write(`[${processed}/${pendingJobs.length}] deferred ${job.id}: Codex usage limit\n`);
          } else if (lastError) {
            const finishedAt = new Date();
            await writeResult({
              id: job.id,
              fingerprint: job.fingerprint,
              status: 'failed',
              attempts: retries + 1,
              error: lastError.message,
              startedAt: startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              durationMs: finishedAt - startedAt,
            });
            summary.failed += 1;
            processed += 1;
            if (!quiet) process.stderr.write(`[${processed}/${pendingJobs.length}] failed ${job.id}: ${lastError.message}\n`);
          }
        } finally {
          await releaseMemory();
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, chunk.length) }, () => worker()));
  }

  for (let offset = 0; offset < pendingJobs.length; offset += batchSize) {
    const chunk = pendingJobs.slice(offset, offset + batchSize);
    if (!quiet) {
      const batchNumber = Math.floor(offset / batchSize) + 1;
      const batchCount = Math.ceil(pendingJobs.length / batchSize);
      process.stderr.write(`batch ${batchNumber}/${batchCount}: ${chunk.length} jobs\n`);
    }
    await runChunk(chunk);
    if (summary.halted) break;
    if (offset + batchSize < pendingJobs.length && batchDelayMs > 0) {
      if (!quiet) process.stderr.write(`waiting ${batchDelayMs / 1_000}s before next batch\n`);
      await delay(batchDelayMs);
    }
  }
  summary.remaining = Math.max(0, pendingJobs.length - summary.succeeded - summary.failed - summary.deferred);
  return summary;
}

export const bulkInternals = { safeFileName, completedJobs, assertUniqueIds, jobFingerprint };
