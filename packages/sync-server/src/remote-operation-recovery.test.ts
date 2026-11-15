import { randomBytes } from 'node:crypto';
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
const boundaryRequestId = 'boundary-transfer';

type OutboxPage = {
  items: {
    eventId: string;
    status: string;
    payload: {
      operationStatus: string;
      transactionIds: string[];
      unpairedTransferIds: string[];
    };
  }[];
  hasMore: boolean;
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
  );
});

/** Inject faults after a real SQLite commit, without production fault hooks. */
async function createFaultWorkerEntry(root: string, mode: 'kill' | 'throw') {
  const wrapper = path.join(root, 'fault-after-transfer-commit.mjs');
  await fs.writeFile(
    wrapper,
    `import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const marker = ${JSON.stringify(path.join(root, 'fault-injected'))};
const original = Database.prototype.transaction;
Database.prototype.transaction = function (...args) {
  const database = this;
  const transaction = original.apply(database, args);
  const wrap = fn => function (...parameters) {
    const result = fn.apply(this, parameters);
    let atBoundary = false;
    try {
      const operation = database.prepare(
        "SELECT commit_count FROM remote_operations WHERE request_id = ? AND status = 'running'"
      ).get(${JSON.stringify(boundaryRequestId)});
      const candidates = database.prepare(
        'SELECT COUNT(*) AS count FROM remote_event_candidates WHERE request_id = ?'
      ).get(${JSON.stringify(boundaryRequestId)});
      atBoundary = operation?.commit_count > 0 && candidates?.count > 0;
    } catch {
      // Budget bootstrap runs before the hosted-only schema exists.
    }
    if (atBoundary && !existsSync(marker)) {
      writeFileSync(marker, 'financial-commit-completed');
      if (${JSON.stringify(mode)} === 'kill') process.kill(process.pid, 'SIGKILL');
      else throw new Error('injected-postcommit-failure');
    }
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
  return wrapper;
}

async function createFixture(mode: 'kill' | 'throw') {
  const root = await fs.mkdtemp(path.join('/tmp', 'actual-transfer-recovery-'));
  roots.push(root);
  const manager = new RemoteWorkerManager({
    storageRoot: root,
    workerEntry: await createFaultWorkerEntry(root, mode),
    startupTimeoutMs: 30_000,
  });
  managers.push(manager);
  const budgetId = randomBytes(16).toString('hex');
  const engineId = randomBytes(16).toString('hex');
  await manager.createBudget(budgetId, engineId);
  await manager.stopProvisioningWorker(budgetId);
  const session = await manager.openSession(
    budgetId,
    engineId,
    'owner',
    'credential',
  );
  const sourceId = await manager.dispatch<string>(
    budgetId,
    session.id,
    () => true,
    'account.create',
    { account: { name: 'Source', offbudget: false, closed: false } },
    true,
    'setup-source',
  );
  const destinationId = await manager.dispatch<string>(
    budgetId,
    session.id,
    () => true,
    'account.create',
    { account: { name: 'Destination', offbudget: false, closed: false } },
    true,
    'setup-destination',
  );
  const payees = await manager.dispatch<
    { id: string; transfer_acct?: string }[]
  >(budgetId, session.id, () => true, 'payees.list', {}, false, 'setup-payees');
  const transferPayee = payees.find(
    payee => payee.transfer_acct === destinationId,
  );
  if (!transferPayee) throw new Error('missing-test-transfer-payee');
  const payload = {
    accountId: sourceId,
    runTransfers: true,
    transactions: [
      { date: '2026-11-14', amount: -950, payee: transferPayee.id },
    ],
  };
  return {
    manager,
    root,
    budgetId,
    engineId,
    session,
    sourceId,
    destinationId,
    payload,
  };
}

function readCommittedSource(
  root: string,
  engineId: string,
  sourceId: string,
  destinationId: string,
) {
  const database = new Database(path.join(root, engineId, 'db.sqlite'), {
    readonly: true,
  });
  try {
    const rows = database
      .prepare(
        'SELECT id, acct, amount, transferred_id FROM transactions WHERE tombstone = 0',
      )
      .all() as {
      id: string;
      acct: string;
      amount: number;
      transferred_id: string | null;
    }[];
    const source = rows.filter(row => row.acct === sourceId);
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ amount: -950, transferred_id: null });
    expect(rows.filter(row => row.acct === destinationId)).toEqual([]);
    return source[0].id;
  } finally {
    database.close();
  }
}

describe('remote transaction event recovery through the built worker', () => {
  it('recovers an unmatched transfer after SIGKILL between financial batches, once', async () => {
    const {
      manager,
      root,
      budgetId,
      engineId,
      session,
      sourceId,
      destinationId,
      payload,
    } = await createFixture('kill');
    await expect(
      manager.dispatch(
        budgetId,
        session.id,
        () => true,
        'transactions.add',
        payload,
        true,
        boundaryRequestId,
      ),
    ).rejects.toThrow('remote-operation-indeterminate');
    await vi.waitFor(
      () => expect(manager.getWorkerPid(budgetId)).toBeUndefined(),
      { timeout: 5000 },
    );
    const sourceTransactionId = readCommittedSource(
      root,
      engineId,
      sourceId,
      destinationId,
    );

    const reopened = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'credential',
    );
    const status = await manager.operationStatus(
      budgetId,
      engineId,
      'owner',
      'credential',
      boundaryRequestId,
      () => true,
    );
    expect(status).toMatchObject({ status: 'interrupted', commitCount: 1 });
    const events = await manager.inspectOutbox<OutboxPage>(
      budgetId,
      engineId,
      'owner',
      'credential',
      100,
      () => true,
    );
    expect(events).toEqual({
      items: [
        expect.objectContaining({
          eventId: expect.stringMatching(/^evt_[a-f0-9]{64}$/),
          status: 'pending',
          payload: expect.objectContaining({
            operationStatus: 'interrupted',
            transactionIds: [sourceTransactionId],
            unpairedTransferIds: [sourceTransactionId],
          }),
        }),
      ],
      hasMore: false,
    });
    await expect(
      manager.dispatch(
        budgetId,
        reopened.id,
        () => true,
        'transactions.add',
        payload,
        true,
        boundaryRequestId,
      ),
    ).rejects.toThrow('remote-operation-interrupted');
    await manager.closeSession(budgetId, reopened.id);
    const secondRestart = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'credential',
    );
    expect(
      await manager.inspectOutbox<OutboxPage>(
        budgetId,
        engineId,
        'owner',
        'credential',
        100,
        () => true,
      ),
    ).toEqual(events);
    readCommittedSource(root, engineId, sourceId, destinationId);
    await manager.closeSession(budgetId, secondRestart.id);
  }, 30_000);

  it('quarantines a worker after a caught postcommit error and rejects queued reads', async () => {
    const {
      manager,
      root,
      budgetId,
      engineId,
      session,
      sourceId,
      destinationId,
      payload,
    } = await createFixture('throw');
    const write = manager.dispatch(
      budgetId,
      session.id,
      () => true,
      'transactions.add',
      payload,
      true,
      boundaryRequestId,
    );
    const queuedRead = manager.dispatch(
      budgetId,
      session.id,
      () => true,
      'accounts.list',
      {},
      false,
      'queued-after-fault',
    );
    await Promise.all([
      expect(write).rejects.toThrow('remote-operation-interrupted'),
      expect(queuedRead).rejects.toThrow('remote-operation-not-dispatched'),
    ]);
    await vi.waitFor(
      () => expect(manager.getWorkerPid(budgetId)).toBeUndefined(),
      { timeout: 5000 },
    );
    const sourceTransactionId = readCommittedSource(
      root,
      engineId,
      sourceId,
      destinationId,
    );
    const reopened = await manager.openSession(
      budgetId,
      engineId,
      'owner',
      'credential',
    );
    const balance = await manager.dispatch(
      budgetId,
      reopened.id,
      () => true,
      'account.balance',
      { id: sourceId },
      false,
      'reloaded-balance',
    );
    expect(balance).toBe(-950);
    const events = await manager.inspectOutbox<OutboxPage>(
      budgetId,
      engineId,
      'owner',
      'credential',
      100,
      () => true,
    );
    expect(events.items).toHaveLength(1);
    expect(events.items[0].payload).toMatchObject({
      operationStatus: 'interrupted',
      transactionIds: [sourceTransactionId],
      unpairedTransferIds: [sourceTransactionId],
    });
  }, 30_000);
});
