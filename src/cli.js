#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runBulk } from './bulk.js';
import { checkCodex, generateText } from './codex.js';
import { loadJobs, loadTemplate } from './input.js';

const HELP = `codex-text - bulk text generation through Codex CLI

Usage:
  codex-text --prompt "Write a product description" [--output result.txt]
  codex-text --input jobs.jsonl [--template-file prompt.md] [options]

Input formats:
  .txt                 one prompt per non-empty line
  .jsonl / .ndjson     one string or object per line
  .json                an array of strings or objects
  .csv                 header row plus data rows

Bulk options:
  --input <file>             Input file
  --template-file <file>     Prompt template using {{field}} placeholders
  --output-dir <dir>         Text files directory (default: output/text)
  --results <file>           JSONL checkpoint (default: output/results.jsonl)
  --concurrency <n>          Parallel Codex processes (default: 2)
  --retries <n>              Retries after a failure (default: 2)
  --batch-size <n>           Jobs per batch (default: 20)
  --batch-delay <seconds>    Pause between batches (default: 5)
  --min-free-memory <MiB>    Pause below available memory (default: 1024)
  --memory-per-worker <MiB>  Reserve per active job (default: 512)
  --memory-poll <seconds>    Memory recheck interval (default: 15)
  --no-resume                Run successful IDs again
  --extension <ext>          Output extension (default: txt)

Codex options:
  --model <model>            Codex model override
  --profile <name>           Codex config profile
  --schema <file>            JSON Schema for structured output
  --timeout <seconds>        Per-job timeout (default: 300)
  --codex <path>             Codex executable (default: codex)

Other:
  --quiet                    Hide per-job progress
  --help                     Show help
  --version                  Show version
`;

function parseArgs(argv) {
  const options = {
    concurrency: 2,
    retries: 2,
    batchSize: 20,
    batchDelay: 5,
    minFreeMemory: 1024,
    memoryPerWorker: 512,
    memoryPoll: 15,
    resume: true,
    timeout: 300,
    extension: 'txt',
  };
  const valueOptions = new Map([
    ['--prompt', 'prompt'], ['--output', 'output'], ['--input', 'input'],
    ['--template-file', 'templateFile'], ['--output-dir', 'outputDir'], ['--results', 'results'],
    ['--concurrency', 'concurrency'], ['--retries', 'retries'], ['--extension', 'extension'],
    ['--batch-size', 'batchSize'], ['--batch-delay', 'batchDelay'],
    ['--min-free-memory', 'minFreeMemory'], ['--memory-per-worker', 'memoryPerWorker'],
    ['--memory-poll', 'memoryPoll'],
    ['--model', 'model'], ['--profile', 'profile'], ['--schema', 'schema'],
    ['--timeout', 'timeout'], ['--codex', 'codexPath'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      options[valueOptions.get(arg)] = value;
    } else if (arg === '--no-resume') options.resume = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  options.concurrency = Number(options.concurrency);
  options.retries = Number(options.retries);
  options.batchSize = Number(options.batchSize);
  options.batchDelayMs = Number(options.batchDelay) * 1_000;
  options.minFreeMemoryMb = Number(options.minFreeMemory);
  options.memoryPerWorkerMb = Number(options.memoryPerWorker);
  options.memoryPollMs = Number(options.memoryPoll) * 1_000;
  options.timeoutMs = Number(options.timeout) * 1_000;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer.');
  if (!Number.isInteger(options.retries) || options.retries < 0) throw new Error('--retries must be a non-negative integer.');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error('--batch-size must be a positive integer.');
  if (!Number.isFinite(options.batchDelayMs) || options.batchDelayMs < 0) throw new Error('--batch-delay must be zero or a positive number.');
  if (!Number.isFinite(options.minFreeMemoryMb) || options.minFreeMemoryMb < 0) throw new Error('--min-free-memory must be zero or a positive number.');
  if (!Number.isFinite(options.memoryPerWorkerMb) || options.memoryPerWorkerMb < 0) throw new Error('--memory-per-worker must be zero or a positive number.');
  if (!Number.isFinite(options.memoryPollMs) || options.memoryPollMs <= 0) throw new Error('--memory-poll must be a positive number.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout must be a positive number.');
  if (!/^[a-zA-Z0-9]+$/.test(options.extension)) throw new Error('--extension must contain only letters and numbers.');
  return options;
}

async function packageVersion() {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  return JSON.parse(await fs.readFile(packagePath, 'utf8')).version;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  if (Boolean(options.prompt) === Boolean(options.input)) {
    throw new Error('Choose exactly one of --prompt or --input.');
  }

  const generateOptions = {
    model: options.model,
    profile: options.profile,
    outputSchema: options.schema,
    timeoutMs: options.timeoutMs,
    codexPath: options.codexPath,
  };
  const preflight = await checkCodex({ codexPath: options.codexPath });
  if (!options.quiet) process.stderr.write(`${preflight.version}; ${preflight.loginStatus}\n`);

  if (options.prompt) {
    const result = await generateText({ prompt: options.prompt, ...generateOptions });
    if (options.output) {
      await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
      await fs.writeFile(options.output, `${result.text}\n`);
    } else {
      process.stdout.write(`${result.text}\n`);
    }
    return;
  }

  const template = await loadTemplate(options.templateFile);
  const jobs = await loadJobs(options.input, { template });
  const summary = await runBulk({
    jobs,
    outputDir: options.outputDir ?? 'output/text',
    resultsPath: options.results ?? 'output/results.jsonl',
    concurrency: options.concurrency,
    retries: options.retries,
    batchSize: options.batchSize,
    batchDelayMs: options.batchDelayMs,
    minFreeMemoryMb: options.minFreeMemoryMb,
    memoryPerWorkerMb: options.memoryPerWorkerMb,
    memoryPollMs: options.memoryPollMs,
    resume: options.resume,
    extension: options.extension,
    quiet: options.quiet,
    generateOptions,
  });
  process.stderr.write(
    `done: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.deferred} deferred, `
      + `${summary.remaining} remaining, ${summary.skipped} skipped\n`,
  );
  if (summary.halted) {
    const reset = summary.resetAt ? ` Reset: ${summary.resetAt}.` : '';
    process.stderr.write(`Codex usage limit reached.${reset} Run the same command after the limit resets.\n`);
    process.exitCode = 2;
  } else if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`codex-text: ${error.message}\n`);
  process.exitCode = 1;
});
