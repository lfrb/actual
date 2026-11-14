import { init, lib } from '@actual-app/core/server/main';

function send(message: Record<string, unknown>) {
  if (process.send) process.send(message);
}

let loaded = false;
let stopping = false;
let startupFinished = false;
let shutdownRequested = false;

async function close() {
  if (stopping) return;
  if (!startupFinished) {
    shutdownRequested = true;
    return;
  }
  stopping = true;
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
