import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { atomicWriteFile } from './util/atomic-write';

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 3_000;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS_PER_BUDGET = 32;
const MAX_ACTIVE_WORKERS = 128;
const lockOperationQueues = new Map<string, Promise<void>>();

export type RemoteWorkerSession = {
  id: string;
  userId: string;
  credentialId: string;
  lastUsedAt: number;
};

type Worker = {
  child: ChildProcess;
  lockPath: string;
  lockToken: string;
  sessions: Map<string, RemoteWorkerSession>;
  ready: Promise<void>;
  rejectReady: (error: Error) => void;
  resolveReady: () => void;
  idleTimer: NodeJS.Timeout;
  stopping?: Promise<void>;
};

export type RemoteWorkerManagerOptions = {
  storageRoot: string;
  workerEntry?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  sessionIdleMs?: number;
  maxSessionsPerBudget?: number;
  maxActiveWorkers?: number;
};

/** One isolated, bounded child process per opaque server budget identity. */
export class RemoteWorkerManager {
  private readonly storageRoot: string;
  private readonly configuredWorkerEntry: string | undefined;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly sessionIdleMs: number;
  private readonly maxSessionsPerBudget: number;
  private readonly maxActiveWorkers: number;
  private readonly workers = new Map<string, Worker>();
  private readonly starting = new Map<string, Promise<Worker>>();
  private closing = false;

  constructor(options: RemoteWorkerManagerOptions) {
    this.storageRoot = resolve(options.storageRoot);
    this.configuredWorkerEntry = options.workerEntry
      ? resolve(options.workerEntry)
      : undefined;
    this.startupTimeoutMs = options.startupTimeoutMs ?? START_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? STOP_TIMEOUT_MS;
    this.sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    this.maxSessionsPerBudget =
      options.maxSessionsPerBudget ?? MAX_SESSIONS_PER_BUDGET;
    this.maxActiveWorkers = options.maxActiveWorkers ?? MAX_ACTIVE_WORKERS;
  }

  async createBudget(fileId: string, engineDirectoryId: string) {
    if (this.closing) throw new Error('remote-worker-manager-closed');
    assertOpaqueId(fileId);
    assertOpaqueId(engineDirectoryId);
    return this.getOrStartWorker(fileId, engineDirectoryId, true);
  }

  async openSession(
    fileId: string,
    engineDirectoryId: string,
    userId: string,
    credentialId: string,
  ): Promise<RemoteWorkerSession> {
    if (this.closing) throw new Error('remote-worker-manager-closed');
    assertOpaqueId(fileId);
    assertOpaqueId(engineDirectoryId);
    const worker = await this.getWorker(fileId, engineDirectoryId);
    if (this.closing) throw new Error('remote-worker-manager-closed');
    this.expireIdleSessions(worker);
    if (worker.sessions.size >= this.maxSessionsPerBudget) {
      throw new Error('remote-session-limit');
    }
    const session = {
      id: randomUUID(),
      userId,
      credentialId,
      lastUsedAt: Date.now(),
    };
    worker.sessions.set(session.id, session);
    this.scheduleIdleCheck(fileId, worker);
    return session;
  }

  validateSession(
    fileId: string,
    sessionId: string,
    userId: string,
    credentialId: string,
  ): RemoteWorkerSession | null {
    const worker = this.workers.get(fileId);
    if (!worker) return null;
    this.expireIdleSessions(worker);
    const session = worker.sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.credentialId !== credentialId
    ) {
      return null;
    }
    session.lastUsedAt = Date.now();
    this.scheduleIdleCheck(fileId, worker);
    return session;
  }

  getWorkerPid(fileId: string) {
    return this.workers.get(fileId)?.child.pid;
  }

  async closeSession(fileId: string, sessionId: string) {
    const worker = this.workers.get(fileId);
    if (!worker) return;
    worker.sessions.delete(sessionId);
    if (worker.sessions.size === 0) await this.stopWorker(fileId, worker);
  }

  async stopProvisioningWorker(fileId: string) {
    const worker = this.workers.get(fileId);
    if (worker) await this.stopWorker(fileId, worker);
  }

  async closeAll() {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all(
      [...this.workers].map(([fileId, worker]) =>
        this.stopWorker(fileId, worker),
      ),
    );
  }

  private expireIdleSessions(worker: Worker) {
    const cutoff = Date.now() - this.sessionIdleMs;
    for (const [id, session] of worker.sessions) {
      if (session.lastUsedAt < cutoff) worker.sessions.delete(id);
    }
  }

  private scheduleIdleCheck(fileId: string, worker: Worker) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => {
      this.expireIdleSessions(worker);
      if (worker.sessions.size === 0) {
        void this.stopWorker(fileId, worker).catch(reportCleanupFailure);
      } else {
        this.scheduleIdleCheck(fileId, worker);
      }
    }, this.sessionIdleMs);
    worker.idleTimer.unref();
  }

  private async getWorker(fileId: string, engineDirectoryId: string) {
    return this.getOrStartWorker(fileId, engineDirectoryId, false);
  }

  private async getOrStartWorker(
    fileId: string,
    engineDirectoryId: string,
    create: boolean,
  ) {
    const existing = this.workers.get(fileId);
    if (existing) {
      if (existing.stopping) {
        await existing.stopping;
        if (this.closing) throw new Error('remote-worker-manager-closed');
        return this.getOrStartWorker(fileId, engineDirectoryId, create);
      }
      await existing.ready;
      if (existing.stopping) {
        await existing.stopping;
        if (this.closing) throw new Error('remote-worker-manager-closed');
        return this.getOrStartWorker(fileId, engineDirectoryId, create);
      }
      return existing;
    }
    const pending = this.starting.get(fileId);
    if (pending) return pending;
    const start = this.startWorker(fileId, engineDirectoryId, create);
    this.starting.set(fileId, start);
    try {
      return await start;
    } finally {
      if (this.starting.get(fileId) === start) this.starting.delete(fileId);
    }
  }

  private async startWorker(
    fileId: string,
    engineDirectoryId: string,
    create = false,
  ) {
    if (this.closing) throw new Error('remote-worker-manager-closed');
    if (this.workers.size + this.starting.size >= this.maxActiveWorkers) {
      throw new Error('remote-worker-capacity-exhausted');
    }
    const budgetDir = resolve(this.storageRoot, engineDirectoryId);
    const prefix = this.storageRoot.endsWith(sep)
      ? this.storageRoot
      : this.storageRoot + sep;
    if (!budgetDir.startsWith(prefix)) {
      throw new Error('invalid-engine-directory');
    }
    const lockPath = join(
      this.storageRoot,
      '.remote-locks',
      `${engineDirectoryId}.lock`,
    );
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    const lockToken = await acquireProcessLock(lockPath);
    let workerEntry: string;
    try {
      workerEntry =
        this.configuredWorkerEntry ??
        createRequire(import.meta.url).resolve('@actual-app/api/hosted-worker');
    } catch {
      await releaseProcessLock(lockPath, lockToken);
      throw new Error('remote-worker-entry-unavailable');
    }
    let rejectReadyCallback: ((error: Error) => void) | undefined;
    let resolveReadyCallback: (() => void) | undefined;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReadyCallback = resolvePromise;
      rejectReadyCallback = rejectPromise;
    });
    const rejectReady = (error: Error) => rejectReadyCallback?.(error);
    const resolveReady = () => resolveReadyCallback?.();
    const startupTimer = setTimeout(
      () => rejectReady(new Error('remote-worker-start-timeout')),
      this.startupTimeoutMs,
    );
    startupTimer.unref();
    const child = spawn(process.execPath, [workerEntry], {
      cwd: this.storageRoot,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        ACTUAL_HOSTED_RUNTIME: '1',
        ACTUAL_REMOTE_WORKER_ROOT: this.storageRoot,
        ACTUAL_REMOTE_ENGINE_DIRECTORY: engineDirectoryId,
        ...(create ? { ACTUAL_REMOTE_CREATE: '1' } : {}),
      },
    });
    const worker: Worker = {
      child,
      lockPath,
      lockToken,
      sessions: new Map(),
      ready,
      rejectReady,
      resolveReady,
      idleTimer: setTimeout(() => undefined, 0),
    };
    this.workers.set(fileId, worker);
    child.on('message', message => {
      if (!isRecord(message)) return;
      if (message.type === 'ready') {
        clearTimeout(startupTimer);
        worker.resolveReady();
      } else if (message.type === 'startup-error') {
        clearTimeout(startupTimer);
        worker.rejectReady(new Error(String(message.message)));
      }
    });
    child.once('error', error => {
      clearTimeout(startupTimer);
      worker.rejectReady(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(startupTimer);
      worker.rejectReady(
        new Error(`remote-worker-exited-${code ?? signal ?? 'unknown'}`),
      );
      if (this.workers.get(fileId) === worker) this.workers.delete(fileId);
      void releaseProcessLock(lockPath, lockToken).catch(reportCleanupFailure);
    });
    const workerPidReady =
      child.pid === undefined
        ? Promise.reject(new Error('remote-worker-spawn-failed'))
        : writeWorkerPid(lockPath, lockToken, child.pid);
    void workerPidReady.catch(error => {
      worker.rejectReady(error);
      child.kill('SIGTERM');
    });
    try {
      await Promise.all([ready, workerPidReady]);
      return worker;
    } catch (error) {
      clearTimeout(startupTimer);
      child.kill('SIGTERM');
      if (!(await waitForExit(child, this.shutdownTimeoutMs))) {
        child.kill('SIGKILL');
        if (!(await waitForExit(child, this.shutdownTimeoutMs))) {
          throw new Error('remote-worker-did-not-exit');
        }
      }
      await releaseProcessLock(lockPath, lockToken);
      throw error;
    }
  }

  private async stopWorker(fileId: string, worker: Worker) {
    if (worker.stopping) return worker.stopping;
    if (this.workers.get(fileId) !== worker) return;
    worker.stopping = this.stopWorkerProcess(fileId, worker);
    return worker.stopping;
  }

  private async stopWorkerProcess(fileId: string, worker: Worker) {
    clearTimeout(worker.idleTimer);
    if (worker.child.connected) {
      worker.child.send({ type: 'shutdown', id: randomUUID() }, error => {
        if (error) worker.child.kill('SIGTERM');
      });
    } else {
      worker.child.kill('SIGTERM');
    }
    if (!(await waitForExit(worker.child, this.shutdownTimeoutMs))) {
      worker.child.kill('SIGKILL');
      if (!(await waitForExit(worker.child, this.shutdownTimeoutMs))) {
        throw new Error('remote-worker-did-not-exit');
      }
    }
    await releaseProcessLock(worker.lockPath, worker.lockToken);
  }
}

async function acquireProcessLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  await withLockGuard(lockPath, async () => {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    try {
      const owner = parseLockMetadata(await readFile(lockPath, 'utf8'));
      if (owner.workerPid !== undefined && isProcessAlive(owner.workerPid)) {
        throw new Error('remote-budget-already-open');
      }
      const { stat } = await import('node:fs/promises');
      const lockStat = await stat(lockPath);
      if (
        Date.now() - lockStat.mtimeMs < 5_000 ||
        (owner.workerPid === undefined && isProcessAlive(owner.serverPid))
      ) {
        throw new Error('remote-budget-lock-unavailable');
      }
      await rm(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // No prior owner.
      } else {
        throw error;
      }
    }
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(
      JSON.stringify({ token, serverPid: process.pid, startedAt: Date.now() }),
    );
    await handle.close();
  });
  return token;
}

async function writeWorkerPid(
  lockPath: string,
  token: string,
  workerPid: number,
) {
  await withLockGuard(lockPath, async () => {
    const contents = parseLockMetadata(await readFile(lockPath, 'utf8'));
    if (contents.token !== token) throw new Error('remote-worker-lock-lost');
    await atomicWriteFile(lockPath, JSON.stringify({ ...contents, workerPid }));
  });
}

async function releaseProcessLock(lockPath: string, token: string) {
  await withLockGuard(lockPath, async () => {
    try {
      const contents = parseLockMetadata(await readFile(lockPath, 'utf8'));
      if (contents.token === token) await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

async function withLockGuard<T>(lockPath: string, action: () => Promise<T>) {
  const previous = lockOperationQueues.get(lockPath) ?? Promise.resolve();
  let finishQueue: (() => void) | undefined;
  const queueItem = new Promise<void>(resolveQueue => {
    finishQueue = resolveQueue;
  });
  lockOperationQueues.set(lockPath, queueItem);
  await previous;
  const guardPath = `${lockPath}.guard`;
  let guardToken: string | undefined;
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let guard;
    try {
      guard = await open(guardPath, 'wx', 0o600);
    } catch {
      // A crashed guard is deliberately fail-closed; an administrator can inspect
      // and remove it after confirming no manager is mutating this lock.
      throw new Error('remote-budget-lock-unavailable');
    }
    guardToken = randomUUID();
    await guard.writeFile(guardToken);
    await guard.close();
    return await action();
  } finally {
    try {
      if (
        guardToken !== undefined &&
        (await readFile(guardPath, 'utf8')) === guardToken
      ) {
        await rm(guardPath, { force: true });
      }
    } catch {
      // The guard may already have been removed during process cleanup.
    }
    if (lockOperationQueues.get(lockPath) === queueItem) {
      lockOperationQueues.delete(lockPath);
    }
    finishQueue?.();
  }
}

function parseLockMetadata(value: string) {
  const record: unknown = JSON.parse(value);
  if (
    !isRecord(record) ||
    typeof record.token !== 'string' ||
    !Number.isInteger(record.serverPid) ||
    typeof record.startedAt !== 'number' ||
    (record.workerPid !== undefined && !Number.isInteger(record.workerPid))
  ) {
    throw new Error('remote-budget-lock-unavailable');
  }
  return record as {
    token: string;
    serverPid: number;
    startedAt: number;
    workerPid?: number;
  };
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<boolean>(resolveExit =>
      child.once('exit', () => resolveExit(true)),
    ),
    delay(timeoutMs).then(() => false),
  ]);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reportCleanupFailure(error: unknown) {
  process.emitWarning(
    error instanceof Error ? error.message : 'remote worker cleanup failed',
  );
}

function assertOpaqueId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('invalid-budget-identity');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
