import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteWorkerManager } from './remote-worker-manager';

const workerEntry = new URL('../../api/dist/hosted-worker.js', import.meta.url);
const require = createRequire(import.meta.url);
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

async function createCrashWorkerEntry(root: string) {
  const wrapperPath = path.join(root, 'kill-after-commit.mjs');
  await fs.writeFile(
    wrapperPath,
    `import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const marker = ${JSON.stringify(path.join(root, 'killed-after-commit'))};
const original = Database.prototype.transaction;
Database.prototype.transaction = function (...args) {
  const database = this;
  const transaction = original.apply(database, args);
  const wrap = fn => function (...parameters) {
    const result = fn.apply(this, parameters);
    try {
      const row = database.prepare("SELECT request_id FROM remote_operations WHERE status='running' AND commit_count > 0 LIMIT 1").get();
      if (row?.request_id === 'crash-request-1' && !existsSync(marker)) {
        writeFileSync(marker, 'killed');
        process.kill(process.pid, 'SIGKILL');
      }
    } catch {}
    return result;
  };
  const wrapped = wrap(transaction);
  wrapped.immediate = wrap(transaction.immediate);
  wrapped.deferred = wrap(transaction.deferred);
  wrapped.exclusive = wrap(transaction.exclusive);
  return wrapped;
};
await import(${JSON.stringify(workerEntry.href)});
`,
  );
  return wrapperPath;
}

describe('built hosted engine worker', () => {
  it('recovers a committed write as interrupted after a real worker kill and never replays it', async () => {
    const root = await fs.mkdtemp(
      path.join('/tmp', 'actual-remote-worker-crash-'),
    );
    roots.push(root);
    const manager = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: await createCrashWorkerEntry(root),
      startupTimeoutMs: 30_000,
      rpcTimeoutMs: 30_000,
    });
    managers.push(manager);
    const budgetId = opaqueId();
    const engineId = opaqueId();
    await manager.createBudget(budgetId, engineId);
    await manager.stopProvisioningWorker(budgetId);
    const session = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'credential',
    );
    await expect(
      manager.dispatch(
        budgetId,
        session.id,
        () => true,
        'account.create',
        {
          account: { name: 'Crash boundary', offbudget: false, closed: false },
        },
        true,
        'crash-request-1',
      ),
    ).rejects.toThrow('remote-operation-indeterminate');
    await vi.waitFor(() =>
      expect(manager.getWorkerPid(budgetId)).toBeUndefined(),
    );

    const reopenedSession = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'credential',
    );
    const status = await manager.operationStatus<{
      status: string;
      commitCount: number;
      errorCode: string | null;
    }>(
      budgetId,
      engineId,
      'owner',
      'credential',
      'crash-request-1',
      () => true,
    );
    expect(status).toMatchObject({
      status: 'interrupted',
      commitCount: 1,
      errorCode: 'operation-interrupted',
    });
    await expect(
      manager.dispatch(
        budgetId,
        reopenedSession.id,
        () => true,
        'account.create',
        {
          account: { name: 'Crash boundary', offbudget: false, closed: false },
        },
        true,
        'crash-request-1',
      ),
    ).rejects.toThrow('remote-operation-interrupted');
    const accounts = await manager.dispatch<Array<{ name: string }>>(
      budgetId,
      reopenedSession.id,
      () => true,
      'accounts.list',
      {},
      false,
      'crash-verify-accounts',
    );
    expect(accounts.filter(row => row.name === 'Crash boundary')).toHaveLength(
      1,
    );
  });

  it('revalidates queued calls, applies queue backpressure, and quarantines a timed-out writer', async () => {
    const { manager } = await createManager();
    const budgetId = opaqueId();
    const engineId = opaqueId();
    await manager.createBudget(budgetId, engineId);
    await manager.stopProvisioningWorker(budgetId);
    const session = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'key',
    );

    const first = manager.dispatch(
      budgetId,
      session.id,
      () => true,
      'accounts.list',
      {},
      false,
      'first',
    );
    let stillAuthorized = true;
    const queued = manager.dispatch(
      budgetId,
      session.id,
      () => stillAuthorized,
      'accounts.list',
      {},
      false,
      'queued',
    );
    stillAuthorized = false;
    await first;
    await expect(queued).rejects.toThrow('remote-operation-not-dispatched');

    const queuedCalls = Array.from({ length: 32 }, () =>
      manager.dispatch(
        budgetId,
        session.id,
        () => true,
        'accounts.list',
        {},
        false,
        `queued-${Math.random()}`,
      ),
    );
    await expect(
      manager.dispatch(
        budgetId,
        session.id,
        () => true,
        'accounts.list',
        {},
        false,
        'full',
      ),
    ).rejects.toThrow('remote-queue-full');
    const settled = Promise.allSettled(queuedCalls);
    await manager.closeAll();
    await settled;
  });

  it('reports dispatched write timeouts as indeterminate and rejects queued commands', async () => {
    const root = await fs.mkdtemp(
      path.join('/tmp', 'actual-remote-worker-timeout-'),
    );
    roots.push(root);
    const entry = path.join(root, 'stall-worker.js');
    await fs.writeFile(
      entry,
      "process.on('message', message => { if (message?.type === 'shutdown') process.exit(0); }); process.send({ type: 'ready' });",
    );
    const manager = new RemoteWorkerManager({
      storageRoot: root,
      workerEntry: entry,
      startupTimeoutMs: 30_000,
      rpcTimeoutMs: 25,
    });
    managers.push(manager);
    const budgetId = opaqueId();
    const engineId = opaqueId();
    await manager.createBudget(budgetId, engineId);
    await manager.stopProvisioningWorker(budgetId);
    const session = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'key',
    );
    const write = manager.dispatch(
      budgetId,
      session.id,
      () => true,
      'preferences.save',
      { id: 'numberFormat', value: 'comma-dot' },
      true,
      'write',
    );
    const queuedRead = manager.dispatch(
      budgetId,
      session.id,
      () => true,
      'accounts.list',
      {},
      false,
      'queued-read',
    );
    await Promise.all([
      expect(write).rejects.toThrow('remote-operation-indeterminate'),
      expect(queuedRead).rejects.toThrow('remote-operation-not-dispatched'),
    ]);
    await vi.waitFor(
      () => expect(manager.getWorkerPid(budgetId)).toBeUndefined(),
      { timeout: 5_000 },
    );
  });

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
