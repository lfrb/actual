import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteWorkerManager } from './remote-worker-manager';

const workerEntry = new URL('../../api/dist/hosted-worker.js', import.meta.url);
const managers: RemoteWorkerManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createManager() {
  const root = await fs.mkdtemp(path.join('/tmp', 'actual-remote-worker-'));
  roots.push(root);
  const manager = new RemoteWorkerManager({
    storageRoot: root,
    workerEntry: workerEntry.pathname,
    startupTimeoutMs: 30_000,
  });
  managers.push(manager);
  return { manager, root };
}

function opaqueId() {
  return crypto.randomBytes(16).toString('hex');
}

describe('built hosted engine worker', () => {
  it('shares concurrent sessions, isolates budgets, and reloads persistent SQLite after restart', async () => {
    const { manager, root } = await createManager();
    const [budgetA, budgetB, engineA, engineB] = [
      opaqueId(),
      opaqueId(),
      opaqueId(),
      opaqueId(),
    ];

    await Promise.all([
      manager.createBudget(budgetA, engineA),
      manager.createBudget(budgetB, engineB),
    ]);
    await Promise.all([
      manager.stopProvisioningWorker(budgetA),
      manager.stopProvisioningWorker(budgetB),
    ]);
    const [firstA, secondA, firstB] = await Promise.all([
      manager.openSession(budgetA, engineA, 'owner', 'key-a'),
      manager.openSession(budgetA, engineA, 'owner', 'key-b'),
      manager.openSession(budgetB, engineB, 'owner', 'key-a'),
    ]);

    expect(firstA.id).not.toBe(secondA.id);
    expect(manager.getWorkerPid(budgetA)).not.toBe(
      manager.getWorkerPid(budgetB),
    );
    const pidA = manager.getWorkerPid(budgetA);

    await manager.closeSession(budgetA, firstA.id);
    expect(manager.getWorkerPid(budgetA)).toBe(pidA);
    expect(
      manager.validateSession(budgetA, secondA.id, 'owner', 'key-b'),
    ).not.toBeNull();
    expect(
      manager.validateSession(budgetA, secondA.id, 'owner', 'key-a'),
    ).toBeNull();

    const closeLastSession = manager.closeSession(budgetA, secondA.id);
    const restartedSessionPromise = manager.openSession(
      budgetA,
      engineA,
      'owner',
      'key-a',
    );
    const [restartedSession] = await Promise.all([
      restartedSessionPromise,
      closeLastSession,
    ]);
    expect(manager.getWorkerPid(budgetA)).not.toBe(pidA);
    await manager.closeSession(budgetA, restartedSession.id);
    await manager.closeSession(budgetB, firstB.id);

    const dbPath = path.join(root, engineA, 'db.sqlite');
    const db = new Database(dbPath);
    db.prepare(
      'INSERT OR REPLACE INTO preferences (id, value) VALUES (?, ?)',
    ).run('remote-step3-restart-marker', 'persisted');
    db.close();

    const restartedManager = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: workerEntry.pathname,
      startupTimeoutMs: 30_000,
    });
    managers.push(restartedManager);
    const resumed = await restartedManager.openSession(
      budgetA,
      engineA,
      'owner',
      'key-a',
    );
    expect(resumed.id).toBeTruthy();
    await restartedManager.closeSession(budgetA, resumed.id);

    const reopenedDb = new Database(dbPath, { readonly: true });
    const marker = reopenedDb
      .prepare('SELECT value FROM preferences WHERE id = ?')
      .get('remote-step3-restart-marker') as { value: string } | undefined;
    reopenedDb.close();
    expect(marker?.value).toBe('persisted');
  });

  it('rejects a second manager while the real child process owns the budget lock', async () => {
    const { manager: first, root } = await createManager();
    const budgetId = opaqueId();
    const engineId = opaqueId();
    await first.createBudget(budgetId, engineId);
    const session = await first.openSession(budgetId, engineId, 'owner', 'key');

    const second = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: workerEntry.pathname,
      startupTimeoutMs: 30_000,
    });
    managers.push(second);
    await expect(
      second.openSession(budgetId, engineId, 'owner', 'key'),
    ).rejects.toThrow('remote-budget-already-open');
    await first.closeSession(budgetId, session.id);
  });

  it('cleans a failed built-worker startup lock and expires idle sessions', async () => {
    const root = await fs.mkdtemp(
      path.join('/tmp', 'actual-remote-worker-failure-'),
    );
    roots.push(root);
    const failed = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: path.join(root, 'missing-worker.js'),
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    });
    managers.push(failed);
    const budgetId = opaqueId();
    const engineId = opaqueId();
    await expect(
      failed.openSession(budgetId, engineId, 'owner', 'key'),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(root, '.remote-locks', `${engineId}.lock`)),
    ).rejects.toThrow();

    const idle = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: workerEntry.pathname,
      startupTimeoutMs: 30_000,
      sessionIdleMs: 20,
    });
    managers.push(idle);
    await idle.createBudget(budgetId, engineId);
    await idle.stopProvisioningWorker(budgetId);
    const session = await idle.openSession(budgetId, engineId, 'owner', 'key');
    expect(idle.getWorkerPid(budgetId)).toBeDefined();
    await vi.waitFor(
      () => {
        expect(
          idle.validateSession(budgetId, session.id, 'owner', 'key'),
        ).toBeNull();
        expect(idle.getWorkerPid(budgetId)).toBeUndefined();
      },
      { timeout: 5_000, interval: 20 },
    );
  });
});
