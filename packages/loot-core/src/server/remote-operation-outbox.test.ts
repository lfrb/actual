import { createHash } from 'node:crypto';

import { Timestamp } from '@actual-app/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import {
  setHostedBudgetActive,
  setRemoteOperationContext,
} from '#server/remote-operation-context';
import {
  beginRemoteOperation,
  getRemoteOperationStatus,
  initializeRemoteOperationJournal,
  succeedRemoteOperation,
} from '#server/remote-operation-journal';
import {
  inspectRemoteOutbox,
  setRemoteEventIdFactory,
} from '#server/remote-operation-outbox';
import { applyMessages, setSyncingMode } from '#server/sync';
import { mergeTransactions } from '#server/transactions/merge';

const scope = {
  budgetId: 'outbox-budget',
  credentialId: 'outbox-credential',
  requestId: 'outbox-request',
};
const transaction = {
  account: 'account',
  date: '2026-11-14',
  amount: -125,
};

function startOperation() {
  beginRemoteOperation({
    ...scope,
    operation: 'transactions.add',
    payloadHash: 'outbox-command-hash',
  });
  setRemoteOperationContext(scope);
}

function finishOperation() {
  succeedRemoteOperation({ ...scope, result: 'ok' });
  setRemoteOperationContext(null);
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await db.insertAccount({ id: 'account', name: 'Checking' });
  await db.insertTransaction({
    ...transaction,
    id: 'existing-import',
    imported_id: 'bank-import-id',
  });
  await db.insertTransaction({ ...transaction, id: 'existing-manual' });
  await db.insertTransaction({ ...transaction, id: 'existing-deleted' });
  await db.deleteTransaction({ id: 'existing-deleted' });
  setRemoteEventIdFactory(identity =>
    createHash('sha256').update(identity).digest('hex'),
  );
  initializeRemoteOperationJournal(scope.budgetId);
});

afterEach(() => {
  setRemoteOperationContext(null);
  setHostedBudgetActive(false);
  setRemoteEventIdFactory(null);
  setSyncingMode('disabled');
});

describe('durable transaction creation outbox', () => {
  it('rejects an unscoped financial write after hosted bootstrap', async () => {
    setHostedBudgetActive(true);
    await expect(
      db.insertTransaction({ ...transaction, id: 'unscoped-write' }),
    ).rejects.toThrow('hosted-operation-context-required');
    expect(
      db.firstSync('SELECT id FROM transactions WHERE id = ?', [
        'unscoped-write',
      ]),
    ).toBeNull();
    expect(inspectRemoteOutbox(100)).toEqual([]);
  });

  it('fails closed on a transaction marked as both parent and child', async () => {
    startOperation();
    await db.insertTransaction({
      ...transaction,
      id: 'split-parent',
      is_parent: true,
    });
    await expect(
      db.insertTransaction({
        ...transaction,
        id: 'ambiguous-shape',
        is_parent: true,
        is_child: true,
        parent_id: 'split-parent',
      }),
    ).rejects.toThrow('remote-event-unknown-transaction-shape');
    expect(
      db.firstSync('SELECT id FROM transactions WHERE id = ?', [
        'ambiguous-shape',
      ]),
    ).toBeNull();
  });

  it('does not announce old or deferred incoming messages', async () => {
    startOperation();
    setSyncingMode('offline');
    const timestamp = () => {
      const value = Timestamp.send();
      if (!value) throw new Error('missing-test-timestamp');
      return value;
    };
    await applyMessages(
      [
        {
          dataset: 'transactions',
          row: 'superseded-row',
          column: 'amount',
          value: -100,
          timestamp: timestamp(),
          old: true,
        },
        {
          dataset: 'transactions',
          row: 'future-schema-row',
          column: 'unknown_future_column',
          value: 'not-applied',
          timestamp: timestamp(),
        },
      ],
      true,
    );
    finishOperation();
    expect(inspectRemoteOutbox(100)).toEqual([]);
    expect(
      db.runQuery(
        'SELECT id FROM transactions WHERE id IN (?, ?)',
        ['superseded-row', 'future-schema-row'],
        true,
      ),
    ).toEqual([]);
  });

  it('keeps a creation payload immutable when a later operation edits or deletes its row', async () => {
    startOperation();
    await db.insertTransaction({ ...transaction, id: 'ordinary-creation' });
    finishOperation();
    const original = inspectRemoteOutbox(100);
    expect(original).toEqual([
      expect.objectContaining({
        operationId: scope.requestId,
        payload: expect.objectContaining({
          version: 1,
          budgetId: scope.budgetId,
          transactionIds: ['ordinary-creation'],
          operationStatus: 'succeeded',
        }),
      }),
    ]);

    const later = { ...scope, requestId: 'later-edit' };
    beginRemoteOperation({
      ...later,
      operation: 'transaction.update',
      payloadHash: 'later-edit-hash',
    });
    setRemoteOperationContext(later);
    await db.updateTransaction({ id: 'ordinary-creation', notes: 'Changed' });
    await db.deleteTransaction({ id: 'ordinary-creation' });
    succeedRemoteOperation({ ...later, result: 'ok' });
    setRemoteOperationContext(null);
    expect(inspectRemoteOutbox(100)).toEqual(original);
  });

  it('does not announce bootstrap rows, updates, or tombstone restoration', async () => {
    expect(inspectRemoteOutbox(100)).toEqual([]);
    startOperation();
    await db.updateTransaction({ id: 'existing-manual', notes: 'Updated' });
    await db.updateTransaction({ id: 'existing-deleted', tombstone: 0 });
    finishOperation();
    expect(inspectRemoteOutbox(100)).toEqual([]);
  });

  it('suppresses a new transaction removed before its operation finishes', async () => {
    startOperation();
    await db.insertTransaction({ ...transaction, id: 'created-then-removed' });
    await db.deleteTransaction({ id: 'created-then-removed' });
    finishOperation();
    expect(inspectRemoteOutbox(100)).toEqual([]);
  });

  it('suppresses a new candidate merged into an existing transaction', async () => {
    startOperation();
    await db.insertTransaction({ ...transaction, id: 'merged-away' });
    const kept = await mergeTransactions([
      { id: 'existing-import' },
      { id: 'merged-away' },
    ]);
    expect(kept).toBe('existing-import');
    finishOperation();
    expect(inspectRemoteOutbox(100)).toEqual([]);
  });

  it('announces the surviving new root when it replaces an existing transaction', async () => {
    startOperation();
    await db.insertTransaction({
      ...transaction,
      id: 'surviving-import',
      imported_id: 'new-import-id',
    });
    const kept = await mergeTransactions([
      { id: 'existing-manual' },
      { id: 'surviving-import' },
    ]);
    expect(kept).toBe('surviving-import');
    finishOperation();
    expect(inspectRemoteOutbox(100)).toEqual([
      expect.objectContaining({
        status: 'pending',
        attemptCount: 0,
        payload: expect.objectContaining({
          type: 'transactions.created',
          transactionIds: ['surviving-import'],
          operationStatus: 'succeeded',
        }),
      }),
    ]);
  });

  it('rolls back the financial commit when candidate insertion fails', async () => {
    startOperation();
    db.execQuery(`CREATE TRIGGER reject_creation_candidate
      BEFORE INSERT ON remote_event_candidates
      BEGIN SELECT RAISE(ABORT, 'injected-candidate-failure'); END`);
    await expect(
      db.insertTransaction({ ...transaction, id: 'must-roll-back' }),
    ).rejects.toThrow('injected-candidate-failure');
    expect(
      db.firstSync('SELECT id FROM transactions WHERE id = ?', [
        'must-roll-back',
      ]),
    ).toBeNull();
    expect(
      getRemoteOperationStatus(
        scope.budgetId,
        scope.credentialId,
        scope.requestId,
      ),
    ).toMatchObject({ status: 'running', commitCount: 0 });
    expect(inspectRemoteOutbox(100)).toEqual([]);
  });

  it('retains candidates and running status if terminal event persistence fails', async () => {
    startOperation();
    await db.insertTransaction({
      ...transaction,
      id: 'committed-before-failure',
    });
    db.execQuery(`CREATE TRIGGER reject_terminal_event
      BEFORE INSERT ON remote_outbox
      BEGIN SELECT RAISE(ABORT, 'injected-outbox-failure'); END`);
    expect(finishOperation).toThrow('injected-outbox-failure');
    expect(
      getRemoteOperationStatus(
        scope.budgetId,
        scope.credentialId,
        scope.requestId,
      ),
    ).toMatchObject({ status: 'running', commitCount: 1 });
    expect(inspectRemoteOutbox(100)).toEqual([]);
    setRemoteOperationContext(null);
    db.execQuery('DROP TRIGGER reject_terminal_event');
    initializeRemoteOperationJournal(scope.budgetId);
    expect(
      getRemoteOperationStatus(
        scope.budgetId,
        scope.credentialId,
        scope.requestId,
      ),
    ).toMatchObject({ status: 'interrupted', commitCount: 1 });
    const recoveredEvents = inspectRemoteOutbox(100);
    expect(recoveredEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          transactionIds: ['committed-before-failure'],
          operationStatus: 'interrupted',
        }),
      }),
    ]);
    initializeRemoteOperationJournal(scope.budgetId);
    expect(inspectRemoteOutbox(100)).toEqual(recoveredEvents);
  });
});
