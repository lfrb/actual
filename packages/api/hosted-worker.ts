import { createHash } from 'node:crypto';

import { init, lib } from '@actual-app/core/server/main';
import {
  setHostedBudgetActive,
  setRemoteOperationContext,
} from '@actual-app/core/server/remote-operation-context';
import {
  beginRemoteOperation,
  failRemoteOperation,
  getRemoteOperationStatus,
  initializeRemoteOperationJournal,
  succeedRemoteOperation,
} from '@actual-app/core/server/remote-operation-journal';
import {
  inspectRemoteOutboxPage,
  setRemoteEventIdFactory,
} from '@actual-app/core/server/remote-operation-outbox';
import {
  parseRemoteCalendarDate,
  parseRemoteV1Request,
  REMOTE_OPERATION_REGISTRY,
} from '@actual-app/core/shared/remote-v1-contract';
import type { Handlers } from '@actual-app/core/types/handlers';

function send(
  message: Record<string, unknown>,
  callback?: (error: Error | null) => void,
) {
  if (process.send) {
    if (callback) process.send(message, callback);
    else process.send(message);
  } else {
    callback?.(new Error('worker-ipc-disconnected'));
  }
}

let loaded = false;
let stopping = false;
let startupFinished = false;
let shutdownRequested = false;
let rpcQueue: Promise<void> = Promise.resolve();
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

async function close() {
  if (stopping) return;
  if (!startupFinished) {
    shutdownRequested = true;
    return;
  }
  stopping = true;
  await rpcQueue;
  setHostedBudgetActive(false);
  if (loaded) {
    try {
      await lib.send('close-budget');
    } catch {
      // Startup may fail before a budget is loaded.
    }
  }
  process.exit(0);
}

process.on('message', message => {
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === 'shutdown'
  ) {
    void close();
    return;
  }
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    (message.type === 'rpc' ||
      message.type === 'operation-status' ||
      message.type === 'outbox-inspect')
  ) {
    const next = rpcQueue.then(() => dispatchRpc(message));
    rpcQueue = next.then(
      () => undefined,
      () => undefined,
    );
  }
});
process.on('disconnect', () => void close());
process.on('SIGTERM', () => void close());

async function start() {
  if (process.env.ACTUAL_HOSTED_RUNTIME !== '1') {
    throw new Error('hosted-worker-runtime-required');
  }
  const dataDir = process.env.ACTUAL_REMOTE_WORKER_ROOT;
  const directoryId = process.env.ACTUAL_REMOTE_ENGINE_DIRECTORY;
  const budgetId = process.env.ACTUAL_REMOTE_BUDGET_ID;
  if (!dataDir || !directoryId || !budgetId) {
    throw new Error('worker-config-missing');
  }
  if (process.env.ACTUAL_SERVER_URL || process.env.ACTUAL_SERVER_TOKEN) {
    throw new Error('hosted-worker-server-auth-forbidden');
  }
  await init({ dataDir });
  const result =
    process.env.ACTUAL_REMOTE_CREATE === '1'
      ? await lib.send('create-remote-budget', { id: directoryId })
      : await lib.send('load-budget', { id: directoryId });
  if (
    result &&
    typeof result === 'object' &&
    'error' in result &&
    result.error
  ) {
    throw new Error(`engine-load-${String(result.error)}`);
  }
  loaded = true;
  setRemoteEventIdFactory(
    identity => `evt_${createHash('sha256').update(identity).digest('hex')}`,
  );
  initializeRemoteOperationJournal(budgetId);
  setHostedBudgetActive(true);
  send({ type: 'ready', pid: process.pid });
}

async function dispatchRpc(message: unknown) {
  if (!process.send || !message || typeof message !== 'object') return;
  if (stopping) return;
  const value = message as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : '';
  if (value.type === 'operation-status') {
    const credentialId =
      typeof value.credentialId === 'string' ? value.credentialId : '';
    const requestId =
      typeof value.targetRequestId === 'string' ? value.targetRequestId : '';
    const budgetId = typeof value.budgetId === 'string' ? value.budgetId : '';
    send({
      type: 'operation-status-result',
      id,
      result:
        budgetId === process.env.ACTUAL_REMOTE_BUDGET_ID &&
        credentialId.length > 0 &&
        requestId.length > 0
          ? getRemoteOperationStatus(budgetId, credentialId, requestId)
          : null,
    });
    return;
  }
  if (value.type === 'outbox-inspect') {
    try {
      send({
        type: 'outbox-inspect-result',
        id,
        result: inspectRemoteOutboxPage(
          typeof value.limit === 'number' ? value.limit : 100,
        ),
      });
    } catch {
      send({
        type: 'rpc-result',
        id,
        error: { code: 'outbox-inspection-failed' },
      });
    }
    return;
  }
  const requestId = typeof value.requestId === 'string' ? value.requestId : '';
  const credentialId =
    typeof value.credentialId === 'string' ? value.credentialId : '';
  const budgetId = typeof value.budgetId === 'string' ? value.budgetId : '';
  let writeOperation = false;
  let operation: string | null = null;
  try {
    if (
      !id ||
      !requestId ||
      !credentialId ||
      !budgetId ||
      budgetId !== process.env.ACTUAL_REMOTE_BUDGET_ID ||
      value.type !== 'rpc' ||
      typeof value.operation !== 'string'
    ) {
      throw new Error('invalid-request');
    }
    const request = parseRemoteV1Request({
      protocolVersion: 1,
      requestId,
      operation: value.operation,
      payload: value.payload,
    });
    operation = request.operation;
    const spec = REMOTE_OPERATION_REGISTRY[request.operation];
    writeOperation = spec.write;
    if (writeOperation) {
      const journal = beginRemoteOperation({
        budgetId,
        credentialId,
        requestId,
        operation: request.operation,
        payloadHash: createHash('sha256')
          .update(
            stableJson({
              operation: request.operation,
              payload: request.payload,
            }),
          )
          .digest('hex'),
      });
      if (journal.kind === 'conflict') {
        send({
          type: 'rpc-result',
          id,
          error: { code: 'request-id-conflict' },
        });
        return;
      }
      if (journal.kind === 'existing') {
        if (journal.status.status === 'running') {
          send({
            type: 'rpc-result',
            id,
            error: { code: 'operation-in-progress' },
          });
        } else if (journal.status.status === 'succeeded') {
          if (journal.status.resultExpired) {
            send({
              type: 'rpc-result',
              id,
              error: { code: 'operation-result-expired' },
            });
          } else {
            send({ type: 'rpc-result', id, result: journal.status.result });
          }
        } else {
          send({
            type: 'rpc-result',
            id,
            error: { code: journal.status.errorCode ?? 'operation-failed' },
          });
        }
        return;
      }
    }
    setRemoteOperationContext(
      writeOperation ? { budgetId, credentialId, requestId } : null,
    );
    const args =
      request.operation === 'rule.delete'
        ? request.payload.id
        : request.operation === 'aql.query'
          ? request.payload.query
          : request.operation === 'account.balance' && request.payload.cutoff
            ? {
                ...request.payload,
                cutoff: parseRemoteCalendarDate(
                  request.payload.cutoff as string,
                ),
              }
            : request.payload;
    // The checked protocol registry and operation validator narrow this dynamic IPC
    // boundary to engine handlers; keep the assertion to the validated arg tuple.
    const handlerArgs = args as Parameters<Handlers[typeof spec.handler]>[0];
    const result =
      request.operation === 'transactions.list'
        ? await listTransactionsBounded(request.payload)
        : await lib.send(spec.handler, handlerArgs);
    const wireResult = result === undefined ? null : result;
    assertBoundedResult(wireResult);
    const encoded = JSON.stringify({
      type: 'rpc-result',
      id,
      result: wireResult,
    });
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) {
      throw new Error('remote-result-too-large');
    }
    if (writeOperation) {
      succeedRemoteOperation({
        budgetId,
        credentialId,
        requestId,
        result: wireResult,
      });
    }
    send({ type: 'rpc-result', id, result: wireResult });
  } catch (error) {
    let code =
      error instanceof Error && error.message === 'invalid-request'
        ? 'invalid-request'
        : error instanceof Error && error.message === 'request-id-conflict'
          ? 'request-id-conflict'
          : error instanceof Error &&
              error.message === 'remote-result-too-large'
            ? 'result-too-large'
            : 'operation-failed';
    let quarantine = false;
    if (writeOperation && credentialId && requestId && budgetId && operation) {
      try {
        code = failRemoteOperation({
          budgetId,
          credentialId,
          requestId,
          errorCode: code,
        });
        quarantine = code === 'operation-interrupted';
      } catch {
        // Leave the running journal and candidates for startup recovery. This
        // process may have stale projections after a durable financial commit.
        code = 'operation-interrupted';
        quarantine = true;
      }
    }
    const interrupted = code === 'operation-interrupted';
    if (quarantine || interrupted) {
      stopping = true;
      setHostedBudgetActive(false);
      send({ type: 'rpc-result', id, error: { code }, fatal: true }, () =>
        process.exit(1),
      );
    } else {
      send({ type: 'rpc-result', id, error: { code } });
    }
  } finally {
    setRemoteOperationContext(null);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function listTransactionsBounded(payload: Record<string, unknown>) {
  const filters = [
    payload.accountId && { account: payload.accountId },
    payload.startDate && { date: { $gte: payload.startDate } },
    payload.endDate && { date: { $lte: payload.endDate } },
  ].filter(Boolean);
  const query = lib.q('transactions');
  const filtered = filters.length > 0 ? query.filter({ $and: filters }) : query;
  const result = await lib.send(
    'query',
    filtered.select('*').options({ splits: 'grouped' }).limit(1001).serialize(),
  );
  if (result.data.length > 1000) throw new Error('remote-result-too-large');
  return result.data;
}

function assertBoundedResult(
  value: unknown,
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
): void {
  if (depth > 16 || ++budget.nodes > 50_000) {
    throw new Error('remote-result-too-large');
  }
  if (typeof value === 'string') budget.bytes += Buffer.byteLength(value);
  if (budget.bytes > MAX_RESULT_BYTES) {
    throw new Error('remote-result-too-large');
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error('remote-result-too-large');
    for (const item of value) assertBoundedResult(item, depth + 1, budget);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      budget.bytes += Buffer.byteLength(key);
      if (budget.bytes > MAX_RESULT_BYTES) {
        throw new Error('remote-result-too-large');
      }
      assertBoundedResult(item, depth + 1, budget);
    }
  }
}

start()
  .catch(error => {
    const message = {
      type: 'startup-error',
      message: error instanceof Error ? error.message : 'worker-startup-failed',
    };
    if (process.send) {
      process.send(message, () => process.exit(1));
    } else {
      process.exit(1);
    }
  })
  .finally(() => {
    startupFinished = true;
    if (shutdownRequested) void close();
  });
