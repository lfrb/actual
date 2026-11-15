import * as db from '#server/db';
import {
  finalizeRemoteOperationEvents,
  initializeRemoteEventOutbox,
} from '#server/remote-operation-outbox';

const MAX_RETAINED_RESULT_BYTES = 64 * 1024;

export type RemoteOperationStatus = {
  operation: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  result: unknown;
  errorCode: string | null;
  commitCount: number;
  affectedIds: string[];
  affectedIdsTruncated: boolean;
  resultExpired: boolean;
};

type JournalRow = {
  operation: string;
  payload_hash: string;
  status: RemoteOperationStatus['status'];
  result_json: string | null;
  error_code: string | null;
  commit_count: number;
  affected_ids_json: string;
  affected_ids_truncated: number;
  result_expired: number;
};

export function initializeRemoteOperationJournal(budgetId: string) {
  db.execQuery(`CREATE TABLE IF NOT EXISTS remote_operations (
    budget_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
    result_json TEXT,
    error_code TEXT,
    commit_count INTEGER NOT NULL DEFAULT 0,
    affected_ids_json TEXT NOT NULL DEFAULT '[]',
    affected_ids_truncated INTEGER NOT NULL DEFAULT 0,
    result_expired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (budget_id, credential_id, request_id)
  )`);
  initializeRemoteEventOutbox();

  // The worker holds the exclusive writer lock before this recovery runs.
  db.transaction(() => {
    const running = db.runQuery<{
      credential_id: string;
      request_id: string;
    }>(
      `SELECT credential_id, request_id FROM remote_operations
        WHERE budget_id = ? AND status = 'running'`,
      [budgetId],
      true,
    );
    for (const operation of running) {
      finalizeRemoteOperationEvents({
        budgetId,
        credentialId: operation.credential_id,
        requestId: operation.request_id,
        operationStatus: 'interrupted',
      });
      const result = db.runQuery(
        `UPDATE remote_operations SET status = 'interrupted',
            error_code = 'operation-interrupted', updated_at = ?
          WHERE budget_id = ? AND credential_id = ? AND request_id = ?
            AND status = 'running'`,
        [
          new Date().toISOString(),
          budgetId,
          operation.credential_id,
          operation.request_id,
        ],
      );
      if (result.changes !== 1) {
        throw new Error('remote-operation-journal-recovery-failed');
      }
    }
    pruneRemoteOperationResults(budgetId);
  });
}

export function beginRemoteOperation(args: {
  budgetId: string;
  credentialId: string;
  requestId: string;
  operation: string;
  payloadHash: string;
}) {
  const existing = findRow(args.budgetId, args.credentialId, args.requestId);
  if (existing) {
    if (existing.payload_hash !== args.payloadHash) {
      return { kind: 'conflict' as const };
    }
    return { kind: 'existing' as const, status: toStatus(existing) };
  }

  const now = new Date().toISOString();
  db.runQuery(
    `INSERT INTO remote_operations
      (budget_id, credential_id, request_id, operation, payload_hash, status,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    [
      args.budgetId,
      args.credentialId,
      args.requestId,
      args.operation,
      args.payloadHash,
      now,
      now,
    ],
  );
  return { kind: 'started' as const };
}

export function recordRemoteOperationCommit(
  budgetId: string,
  credentialId: string,
  requestId: string,
  affectedIds: string[],
) {
  const row = findRow(budgetId, credentialId, requestId);
  if (!row) throw new Error('remote-operation-journal-missing');
  const ids = JSON.parse(row.affected_ids_json) as string[];
  if (row.status !== 'running') {
    throw new Error('remote-operation-journal-not-running');
  }
  const allIds = [...new Set([...ids, ...affectedIds])];
  const truncated = row.affected_ids_truncated === 1 || allIds.length > 5000;
  const result = db.runQuery(
    `UPDATE remote_operations
        SET commit_count = commit_count + 1, affected_ids_json = ?,
            affected_ids_truncated = ?, updated_at = ?
      WHERE budget_id = ? AND credential_id = ? AND request_id = ?
        AND status = 'running'`,
    [
      JSON.stringify(truncated ? allIds.slice(0, 5000) : allIds),
      truncated ? 1 : 0,
      new Date().toISOString(),
      budgetId,
      credentialId,
      requestId,
    ],
  );
  if (result.changes !== 1) {
    throw new Error('remote-operation-journal-update-failed');
  }
}

export function succeedRemoteOperation(args: {
  budgetId: string;
  credentialId: string;
  requestId: string;
  result: unknown;
}) {
  const resultJson = JSON.stringify(args.result) ?? 'null';
  const canRetainResult =
    new TextEncoder().encode(resultJson).byteLength <=
    MAX_RETAINED_RESULT_BYTES;
  db.transaction(() => {
    finalizeRemoteOperationEvents({
      budgetId: args.budgetId,
      credentialId: args.credentialId,
      requestId: args.requestId,
      operationStatus: 'succeeded',
    });
    const update = db.runQuery(
      `UPDATE remote_operations SET status = 'succeeded', result_json = ?,
          result_expired = ?,
          updated_at = ?
        WHERE budget_id = ? AND credential_id = ? AND request_id = ?
          AND status = 'running'`,
      [
        canRetainResult ? resultJson : null,
        canRetainResult ? 0 : 1,
        new Date().toISOString(),
        args.budgetId,
        args.credentialId,
        args.requestId,
      ],
    );
    if (update.changes !== 1) {
      throw new Error('remote-operation-journal-update-failed');
    }
    pruneRemoteOperationResults(args.budgetId);
  });
}

export function failRemoteOperation(args: {
  budgetId: string;
  credentialId: string;
  requestId: string;
  errorCode: string;
}) {
  const row = findRow(args.budgetId, args.credentialId, args.requestId);
  if (!row || row.status !== 'running') return args.errorCode;
  const status = row.commit_count > 0 ? 'interrupted' : 'failed';
  const errorCode =
    status === 'interrupted' ? 'operation-interrupted' : args.errorCode;
  db.transaction(() => {
    if (status === 'interrupted') {
      finalizeRemoteOperationEvents({
        budgetId: args.budgetId,
        credentialId: args.credentialId,
        requestId: args.requestId,
        operationStatus: 'interrupted',
      });
    }
    const update = db.runQuery(
      `UPDATE remote_operations SET status = ?, error_code = ?, updated_at = ?
        WHERE budget_id = ? AND credential_id = ? AND request_id = ?
          AND status = 'running'`,
      [
        status,
        errorCode,
        new Date().toISOString(),
        args.budgetId,
        args.credentialId,
        args.requestId,
      ],
    );
    if (update.changes !== 1) {
      throw new Error('remote-operation-journal-update-failed');
    }
  });
  return errorCode;
}

export function getRemoteOperationStatus(
  budgetId: string,
  credentialId: string,
  requestId: string,
): RemoteOperationStatus | null {
  const row = findRow(budgetId, credentialId, requestId);
  return row ? toStatus(row) : null;
}

function findRow(budgetId: string, credentialId: string, requestId: string) {
  return db.firstSync<JournalRow>(
    `SELECT operation, payload_hash, status, result_json, error_code,
            commit_count, affected_ids_json, affected_ids_truncated,
            result_expired
       FROM remote_operations
      WHERE budget_id = ? AND credential_id = ? AND request_id = ?`,
    [budgetId, credentialId, requestId],
  );
}

function toStatus(row: JournalRow): RemoteOperationStatus {
  return {
    operation: row.operation,
    status: row.status,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    errorCode: row.error_code,
    commitCount: row.commit_count,
    affectedIds: JSON.parse(row.affected_ids_json) as string[],
    affectedIdsTruncated: row.affected_ids_truncated === 1,
    resultExpired: row.result_expired === 1,
  };
}

function pruneRemoteOperationResults(budgetId: string) {
  db.runQuery(
    `UPDATE remote_operations SET result_json = NULL, result_expired = 1
      WHERE budget_id = ? AND status = 'succeeded' AND result_json IS NOT NULL
        AND rowid NOT IN (
          SELECT rowid FROM remote_operations
            WHERE budget_id = ? AND status = 'succeeded'
            ORDER BY updated_at DESC, rowid DESC LIMIT 16
        )`,
    [budgetId, budgetId],
  );
}
