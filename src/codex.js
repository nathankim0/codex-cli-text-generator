import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function runCommand(file, args, { input = '', timeoutMs = 300_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (code === 0 && !timedOut) {
        resolve({ code, signal, stdout, stderr });
        return;
      }
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited with code ${code ?? signal}`;
      const error = new Error(`${file} ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      error.code = timedOut ? 'CODEX_TIMEOUT' : 'CODEX_EXEC_FAILED';
      error.exitCode = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.end(input);
  });
}

export async function checkCodex({ codexPath = 'codex', execImpl = runCommand } = {}) {
  const [version, login] = await Promise.all([
    execImpl(codexPath, ['--version'], { timeoutMs: 15_000 }),
    execImpl(codexPath, ['login', 'status'], { timeoutMs: 15_000 }),
  ]);
  const loginStatus = `${login.stdout}\n${login.stderr}`.trim();
  if (!/Logged in using ChatGPT/i.test(loginStatus)) {
    const error = new Error(`Codex CLI is not logged in with ChatGPT: ${loginStatus || 'unknown status'}`);
    error.code = 'CODEX_NOT_LOGGED_IN';
    throw error;
  }
  return {
    version: `${version.stdout}\n${version.stderr}`.trim(),
    loginStatus,
  };
}

function parseResetAt(message, now = new Date()) {
  const raw = message.match(/(?:try again at|resets? at)\s+([^.,]+(?:,\s*\d{4}\s+\d{1,2}:\d{2}\s+[AP]M|\s+[AP]M)?)/i)?.[1];
  if (!raw) return null;
  const normalized = raw.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
  const hasDate = /[A-Za-z]{3}\s+\d{1,2}/.test(normalized);
  const candidate = hasDate
    ? normalized
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${normalized}`;
  let parsed = new Date(candidate);
  if (!hasDate && Number.isFinite(parsed.getTime()) && parsed <= now) {
    parsed = new Date(parsed.getTime() + 24 * 60 * 60 * 1000);
  }
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isUsageLimitMessage(message) {
  return /you(?:'|’)ve hit your usage limit|usage_limit_reached|usage limit reached|workspace is out of credits|credits depleted/i.test(message);
}

function classifyCodexError(error) {
  const message = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
  if (!isUsageLimitMessage(message)) return error;
  const limitError = new Error(message.trim());
  limitError.code = 'CODEX_USAGE_LIMIT';
  limitError.resetAt = parseResetAt(message);
  limitError.cause = error;
  return limitError;
}

export async function generateText({
  prompt,
  model,
  profile,
  outputSchema,
  timeoutMs = 300_000,
  codexPath = 'codex',
  execImpl = runCommand,
} = {}) {
  if (!prompt?.trim()) throw new Error('Prompt is required.');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'god-tibo-text-'));
  const outputPath = path.join(tempDir, 'last-message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    tempDir,
    '--output-last-message',
    outputPath,
    ...(model ? ['--model', model] : []),
    ...(profile ? ['--profile', profile] : []),
    ...(outputSchema ? ['--output-schema', path.resolve(outputSchema)] : []),
    '-',
  ];

  try {
    let run;
    try {
      run = await execImpl(codexPath, args, { input: prompt, timeoutMs });
    } catch (error) {
      throw classifyCodexError(error);
    }
    const text = await fs.readFile(outputPath, 'utf8').catch(() => '');
    if (!text.trim()) {
      const error = new Error('Codex completed without a final text response.');
      error.code = 'EMPTY_CODEX_OUTPUT';
      error.stdout = run.stdout;
      error.stderr = run.stderr;
      throw error;
    }
    return {
      text: text.trimEnd(),
      stderr: run.stderr,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export const codexInternals = { parseResetAt, isUsageLimitMessage, classifyCodexError };
