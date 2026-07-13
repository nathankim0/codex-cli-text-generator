import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryGuard, resourceInternals } from '../src/resources.js';

test('parses Linux MemAvailable and macOS vm_stat', () => {
  assert.equal(resourceInternals.parseLinuxMemAvailable('MemAvailable:       2048 kB\n'), 2 * 1024 * 1024);
  const mac = [
    'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
    'Pages free: 100.',
    'Pages inactive: 200.',
    'Pages speculative: 50.',
    'Pages purgeable: 25.',
  ].join('\n');
  assert.equal(resourceInternals.parseMacVmStat(mac), 375 * 4096);
});

test('memory guard waits until enough memory is available', async () => {
  const snapshots = [100 * 1024 * 1024, 2 * 1024 * 1024 * 1024];
  let waits = 0;
  const guard = createMemoryGuard({
    minFreeMemoryMb: 1024,
    memoryPerWorkerMb: 0,
    pollMs: 1,
    snapshotImpl: async () => snapshots.shift() ?? 2 * 1024 * 1024 * 1024,
    onWait: () => { waits += 1; },
  });
  const release = await guard.acquire();
  assert.equal(waits, 1);
  await release();
});
