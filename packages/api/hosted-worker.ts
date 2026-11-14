import { init, lib } from '@actual-app/core/server/main';
import {
  parseRemoteCalendarDate,
  parseRemoteV1Request,
  REMOTE_OPERATION_REGISTRY,
} from '@actual-app/core/shared/remote-v1-contract';
import type { Handlers } from '@actual-app/core/types/handlers';

function send(message: Record<string, unknown>) {
  if (process.send) process.send(message);
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
    message.type === 'rpc'
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
  if (!dataDir || !directoryId) throw new Error('worker-config-missing');
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
  send({ type: 'ready', pid: process.pid });
}

async function dispatchRpc(message: unknown) {
  if (!process.send || !message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : '';
  let writeOperation = false;
  try {
    if (!id || value.type !== 'rpc' || typeof value.operation !== 'string') {
      throw new Error('invalid-request');
    }
    const request = parseRemoteV1Request({
      protocolVersion: 1,
      requestId: id,
      operation: value.operation,
      payload: value.payload,
    });
    const spec = REMOTE_OPERATION_REGISTRY[request.operation];
    writeOperation = spec.write;
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
    send({ type: 'rpc-result', id, result: wireResult });
  } catch (error) {
    const code = writeOperation
      ? 'operation-indeterminate'
      : error instanceof Error && error.message === 'invalid-request'
        ? 'invalid-request'
        : error instanceof Error && error.message === 'remote-result-too-large'
          ? 'result-too-large'
          : 'operation-failed';
    send({ type: 'rpc-result', id, error: { code } });
  }
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
