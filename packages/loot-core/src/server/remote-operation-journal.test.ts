import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { setRemoteOperationContext } from '#server/remote-operation-context';
import {
  beginRemoteOperation,
  failRemoteOperation,
  getRemoteOperationStatus,
  initializeRemoteOperationJournal,
  recordRemoteOperationCommit,
  succeedRemoteOperation,
} from '#server/remote-operation-journal';

const scope = {
  budgetId: 'budget-one',
  credentialId: 'credential-one',
  requestId: 'request-one',
};
const command = {
  ...scope,
  operation: 'transactions.add',
  payloadHash: 'validated-command-hash',
};

function status() {
  return getRemoteOperationStatus(
    scope.budgetId,
    scope.credentialId,
    scope.requestId,
  );
}

beforeEach(async () => {
  await global.emptyDatabase()();
  initializeRemoteOperationJournal(scope.budgetId);
});

afterEach(() => setRemoteOperationContext(null));

describe('hosted operation journal', () => {
  it('reserves a request once and isolates budget and credential identities', () => {
    expect(beginRemoteOperation(command)).toEqual({ kind: 'started' });
    expect(beginRemoteOperation(command)).toMatchObject({
      kind: 'existing',
      status: { status: 'running', commitCount: 0 },
    });
    expect(
      beginRemoteOperation({ ...command, payloadHash: 'different-command' }),
    ).toEqual({ kind: 'conflict' });
    expect(
      beginRemoteOperation({ ...command, credentialId: 'credential-two' }),
    ).toEqual({ kind: 'started' });
    expect(
      beginRemoteOperation({ ...command, budgetId: 'budget-two' }),
    ).toEqual({ kind: 'started' });
    expect(
      getRemoteOperationStatus(
        scope.budgetId,
        'other-credential',
        scope.requestId,
      ),
    ).toBeNull();
  });

  it('saves the wire result, including null, without reopening a terminal command', () => {
    beginRemoteOperation(command);
    succeedRemoteOperation({ ...scope, result: null });
    expect(beginRemoteOperation(command)).toMatchObject({
      kind: 'existing',
      status: { status: 'succeeded', result: null, resultExpired: false },
    });
    expect(() =>
      recordRemoteOperationCommit(
        scope.budgetId,
        scope.credentialId,
        scope.requestId,
        ['transactions:unexpected'],
      ),
    ).toThrow('remote-operation-journal-not-running');
  });

  it('distinguishes a failed command from a partially committed command', () => {
    beginRemoteOperation(command);
    expect(
      failRemoteOperation({ ...scope, errorCode: 'operation-failed' }),
    ).toBe('operation-failed');
    expect(status()).toMatchObject({ status: 'failed', commitCount: 0 });

    const partial = { ...command, requestId: 'partially-committed' };
    beginRemoteOperation(partial);
    recordRemoteOperationCommit(
      partial.budgetId,
      partial.credentialId,
      partial.requestId,
      ['transactions:source'],
    );
    expect(
      failRemoteOperation({ ...partial, errorCode: 'operation-failed' }),
    ).toBe('operation-interrupted');
    expect(beginRemoteOperation(partial)).toMatchObject({
      kind: 'existing',
      status: {
        status: 'interrupted',
        errorCode: 'operation-interrupted',
        commitCount: 1,
        affectedIds: ['transactions:source'],
      },
    });
  });

  it('recovers only the current budget and retains committed evidence', () => {
    beginRemoteOperation(command);
    beginRemoteOperation({ ...command, budgetId: 'budget-two' });
    recordRemoteOperationCommit(
      scope.budgetId,
      scope.credentialId,
      scope.requestId,
      ['transactions:source'],
    );
    initializeRemoteOperationJournal(scope.budgetId);
    expect(status()).toMatchObject({
      status: 'interrupted',
      errorCode: 'operation-interrupted',
      affectedIds: ['transactions:source'],
    });
    expect(
      getRemoteOperationStatus(
        'budget-two',
        scope.credentialId,
        scope.requestId,
      ),
    ).toMatchObject({ status: 'running' });
  });

  it('rolls back financial messages when atomic journal bookkeeping fails', async () => {
    await db.insertAccount({ id: 'account', name: 'Checking' });
    beginRemoteOperation(command);
    db.execQuery(`CREATE TRIGGER reject_remote_commit
      BEFORE UPDATE OF commit_count ON remote_operations
      BEGIN SELECT RAISE(ABORT, 'injected-journal-failure'); END`);
    setRemoteOperationContext(scope);
    await expect(
      db.insertTransaction({
        id: 'must-not-exist',
        account: 'account',
        date: '2026-11-14',
        amount: -125,
      }),
    ).rejects.toThrow('injected-journal-failure');
    expect(
      db.firstSync('SELECT id FROM transactions WHERE id = ?', [
        'must-not-exist',
      ]),
    ).toBeNull();
    expect(status()).toMatchObject({ commitCount: 0, affectedIds: [] });
  });

  it('records financial row identifiers in the same commit', async () => {
    await db.insertAccount({ id: 'account', name: 'Checking' });
    beginRemoteOperation(command);
    setRemoteOperationContext(scope);
    await db.insertTransaction({
      id: 'persisted',
      account: 'account',
      date: '2026-11-14',
      amount: -125,
    });
    expect(status()).toMatchObject({
      commitCount: 1,
      affectedIds: ['transactions:persisted'],
      affectedIdsTruncated: false,
    });
  });

  it('reports when committed identifiers exceed the recovery response bound', () => {
    beginRemoteOperation(command);
    recordRemoteOperationCommit(
      scope.budgetId,
      scope.credentialId,
      scope.requestId,
      Array.from({ length: 5001 }, (_, index) => `transactions:${index}`),
    );
    expect(status()).toMatchObject({
      commitCount: 1,
      affectedIdsTruncated: true,
    });
    expect(status()?.affectedIds).toHaveLength(5000);
  });

  it('expires bounded results while preserving request conflict protection', () => {
    for (let index = 0; index < 20; index++) {
      const operation = { ...command, requestId: `retained-${index}` };
      beginRemoteOperation(operation);
      succeedRemoteOperation({ ...operation, result: { id: index } });
    }
    expect(
      db.firstSync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM remote_operations WHERE result_json IS NOT NULL',
      )?.count,
    ).toBeLessThanOrEqual(16);
    const expired = db.firstSync<{ request_id: string }>(
      'SELECT request_id FROM remote_operations WHERE result_expired = 1 LIMIT 1',
    );
    expect(expired).toBeTruthy();
    expect(
      beginRemoteOperation({ ...command, requestId: expired!.request_id }),
    ).toMatchObject({
      kind: 'existing',
      status: { status: 'succeeded', resultExpired: true },
    });
    expect(
      beginRemoteOperation({
        ...command,
        requestId: expired!.request_id,
        payloadHash: 'changed',
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('keeps success evidence when a response is too large to retain', () => {
    beginRemoteOperation(command);
    // Multi-byte text verifies the storage limit is measured in UTF-8 bytes.
    succeedRemoteOperation({ ...scope, result: 'é'.repeat(40_000) });
    expect(status()).toMatchObject({
      status: 'succeeded',
      result: null,
      resultExpired: true,
    });
    expect(beginRemoteOperation(command)).toMatchObject({
      kind: 'existing',
      status: { status: 'succeeded', resultExpired: true },
    });
  });
});
