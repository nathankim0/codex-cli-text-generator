import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MEBIBYTE = 1024 * 1024;

function parseLinuxMemAvailable(content) {
  const kibibytes = Number(content.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]);
  return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
}

function parseMacVmStat(content) {
  const pageSize = Number(content.match(/page size of (\d+) bytes/i)?.[1] ?? 4096);
  const pageKeys = ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable'];
  let pages = 0;
  for (const key of pageKeys) {
    const value = Number(content.match(new RegExp(`^${key}:\\s+(\\d+)\\.`, 'm'))?.[1] ?? 0);
    pages += value;
  }
  return pages > 0 ? pages * pageSize : null;
}

export async function getAvailableMemoryBytes({ platform = process.platform } = {}) {
  if (platform === 'linux') {
    const content = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
    return parseLinuxMemAvailable(content) ?? os.freemem();
  }
  if (platform === 'darwin') {
    const result = await execFileAsync('vm_stat', [], { encoding: 'utf8' }).catch(() => null);
    return parseMacVmStat(result?.stdout ?? '') ?? os.freemem();
  }
  return os.freemem();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createMemoryGuard({
  minFreeMemoryMb = 1024,
  memoryPerWorkerMb = 512,
  pollMs = 15_000,
  snapshotImpl = getAvailableMemoryBytes,
  onWait = () => {},
} = {}) {
  let activeJobs = 0;
  let lockTail = Promise.resolve();

  async function withLock(operation) {
    let releaseLock;
    const next = new Promise((resolve) => { releaseLock = resolve; });
    const previous = lockTail;
    lockTail = next;
    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
    }
  }

  async function acquire({ shouldStop = () => false } = {}) {
    while (true) {
      if (shouldStop()) return null;
      const result = await withLock(async () => {
        const availableBytes = await snapshotImpl();
        const requiredBytes = (minFreeMemoryMb + activeJobs * memoryPerWorkerMb) * MEBIBYTE;
        if (availableBytes >= requiredBytes) {
          activeJobs += 1;
          return { acquired: true, availableBytes, requiredBytes };
        }
        return { acquired: false, availableBytes, requiredBytes };
      });

      if (result.acquired) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await withLock(async () => { activeJobs = Math.max(0, activeJobs - 1); });
        };
      }

      onWait({
        availableMb: Math.floor(result.availableBytes / MEBIBYTE),
        requiredMb: Math.ceil(result.requiredBytes / MEBIBYTE),
      });
      await delay(pollMs);
    }
  }

  return { acquire };
}

export const resourceInternals = { parseLinuxMemAvailable, parseMacVmStat };
