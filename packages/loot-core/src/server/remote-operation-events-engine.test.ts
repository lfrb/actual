import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { setRemoteOperationContext } from '#server/remote-operation-context';
import {
  beginRemoteOperation,
  initializeRemoteOperationJournal,
  succeedRemoteOperation,
} from '#server/remote-operation-journal';
import {
  inspectRemoteOutbox,
  setRemoteEventIdFactory,
} from '#server/remote-operation-outbox';
import { setSyncingMode } from '#server/sync';
import {
  insertRule,
  loadRules,
  resetState,
} from '#server/transactions/transaction-rules';
import * as transfer from '#server/transactions/transfer';

const scope = {
  budgetId: 'engine-events-budget',
  credentialId: 'engine-events-credential',
};

let requestNumber = 0;
let transferPayeeA: string;
let transferPayeeB: string;

function startOperation(requestId = `engine-operation-${++requestNumber}`) {
  const operation = { ...scope, requestId };
  beginRemoteOperation({
    ...operation,
    operation: 'transactions.add',
    payloadHash: createHash('sha256').update(requestId).digest('hex'),
  });
  setRemoteOperationContext(operation);
  return operation;
}

function finishOperation(operation: ReturnType<typeof startOperation>) {
  succeedRemoteOperation({ ...operation, result: 'ok' });
  setRemoteOperationContext(null);
}

beforeEach(async () => {
  await global.emptyDatabase()();
  resetState();
  await loadMappings();
  await loadRules();
  await db.insertAccount({ id: 'source', name: 'Source' });
  await db.insertAccount({ id: 'target-a', name: 'Target A' });
  await db.insertAccount({ id: 'target-b', name: 'Target B' });
  await db.insertPayee({ name: 'Transfer to source', transfer_acct: 'source' });
  transferPayeeA = await db.insertPayee({
    name: 'Transfer A',
    transfer_acct: 'target-a',
  });
  transferPayeeB = await db.insertPayee({
    name: 'Transfer B',
    transfer_acct: 'target-b',
  });
  setRemoteEventIdFactory(identity =>
    createHash('sha256').update(identity).digest('hex'),
  );
  initializeRemoteOperationJournal(scope.budgetId);
});

afterEach(() => {
  setRemoteOperationContext(null);
  setRemoteEventIdFactory(null);
  setSyncingMode('disabled');
  resetState();
});

describe('creation events from transaction handlers', () => {
  it('coalesces both transfer legs from a split across multiple target accounts', async () => {
    const operation = startOperation('multi-transfer-operation');
    await addTransactions('source', [
      {
        date: '2026-11-14',
        amount: -300,
        payee_name: 'Split purchase',
        subtransactions: [
          { amount: -100, payee: transferPayeeA },
          { amount: -200, payee: transferPayeeB },
        ],
      },
    ]);
    finishOperation(operation);

    const operationEvents = inspectRemoteOutbox(100).filter(
      item => item.operationId === operation.requestId,
    );
    expect(operationEvents).toHaveLength(1);
    const transactionIds = operationEvents[0].payload.transactionIds;
    expect(transactionIds).toHaveLength(3);
    expect(operationEvents[0].payload.unpairedTransferIds).toEqual([]);
    const roots = db.runQuery<{
      id: string;
      account: string;
      isParent: number;
      isChild: number;
    }>(
      `SELECT id, acct AS account, isParent, isChild FROM transactions
        WHERE id IN (${transactionIds.map(() => '?').join(', ')})`,
      transactionIds,
      true,
    );
    expect(roots).toHaveLength(3);
    expect(roots.every(row => row.isChild === 0)).toBe(true);
    expect(new Set(roots.map(row => row.account))).toEqual(
      new Set(['source', 'target-a', 'target-b']),
    );
    expect(roots.filter(row => row.isParent === 1)).toHaveLength(1);
  });

  it('normalizes a rule-created split to its parent logical ID', async () => {
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'split-rule' }],
      actions: [
        {
          op: 'set-split-amount',
          value: -100,
          options: { splitIndex: 1, method: 'fixed-amount' },
        },
        {
          op: 'set-split-amount',
          value: 0,
          options: { splitIndex: 2, method: 'remainder' },
        },
      ],
    });
    await loadRules();
    const operation = startOperation('rule-split-operation');
    await addTransactions('source', [
      {
        date: '2026-11-14',
        amount: -300,
        imported_payee: 'split-rule',
        payee_name: 'Rule split',
      },
    ]);
    finishOperation(operation);

    const event = inspectRemoteOutbox(100).find(
      item => item.operationId === operation.requestId,
    );
    expect(event?.payload.transactionIds).toHaveLength(1);
    const [rootId] = event?.payload.transactionIds ?? [];
    const root = db.firstSync<{ isParent: number; isChild: number }>(
      'SELECT isParent, isChild FROM transactions WHERE id = ?',
      [rootId],
    );
    expect(root).toMatchObject({ isParent: 1, isChild: 0 });
  });

  it('marks a partially completed split transfer as unpaired at the parent', async () => {
    const operation = startOperation('partial-split-transfer-operation');
    await addTransactions(
      'source',
      [
        {
          date: '2026-11-14',
          amount: -300,
          payee_name: 'Split purchase',
          subtransactions: [
            { amount: -100, payee: transferPayeeA },
            { amount: -200, payee: transferPayeeB },
          ],
        },
      ],
      { runTransfers: false },
    );
    const children = db.runQuery<{ id: string }>(
      `SELECT id FROM transactions WHERE isChild = 1 ORDER BY id`,
      [],
      true,
    );
    expect(children).toHaveLength(2);
    await transfer.onInsert(await db.getTransaction(children[0].id));
    finishOperation(operation);

    const events = inspectRemoteOutbox(100).filter(
      item => item.operationId === operation.requestId,
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.transactionIds).toHaveLength(2);
    expect(events[0].payload.unpairedTransferIds).toHaveLength(1);
    expect(events[0].payload.transactionIds).toContain(
      events[0].payload.unpairedTransferIds[0],
    );
    expect(events[0].payload.transactionIds).not.toContain(children[0].id);
    expect(events[0].payload.transactionIds).not.toContain(children[1].id);
  });

  it('does not emit a transaction removed by an applicable rule', async () => {
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'drop-rule' }],
      actions: [{ op: 'delete-transaction', value: '' }],
    });
    await loadRules();
    const operation = startOperation('rule-delete-operation');
    await addTransactions('source', [
      {
        date: '2026-11-14',
        amount: -100,
        imported_payee: 'drop-rule',
        payee_name: 'Rule deleted',
      },
    ]);
    finishOperation(operation);

    expect(
      inspectRemoteOutbox(100).filter(
        item => item.operationId === operation.requestId,
      ),
    ).toEqual([]);
  });
});
