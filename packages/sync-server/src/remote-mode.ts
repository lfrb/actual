import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import express from 'express';

import { getAccountDb } from './account-db';
import { File, FilesService } from './app-sync/services/files-service';
import { config } from './load-config';
import { RemoteWorkerManager } from './remote-worker-manager';
import { isValidFileId } from './util/paths';
import { validateBudgetSession } from './util/validate-budget-session';
import { getRequestToken } from './util/validate-user';

type RuntimeRow = { engine_directory_id: string; state: string };

const remoteRoot = resolve(join(config.get('userFiles'), 'remote-budgets'));
export const remoteWorkerManager = new RemoteWorkerManager({
  storageRoot: remoteRoot,
});

const app = express.Router();

app.post('/session/open', async (req, res) => {
  const auth = authenticate(req, res);
  if (!auth) return;
  if (
    !req.body ||
    Object.keys(req.body).some(
      key => !['budgetId', 'protocolVersion'].includes(key),
    ) ||
    req.body.protocolVersion !== 1
  ) {
    res.status(400).json({ status: 'error', reason: 'invalid-request' });
    return;
  }
  const budgetId = req.body?.budgetId;
  const record = getOwnedRemoteBudget(budgetId, auth.userId);
  if (!record) {
    res.status(404).json({ status: 'error', reason: 'budget-not-found' });
    return;
  }
  if (!auth.grantedFileIds.includes(budgetId)) {
    res.status(403).json({ status: 'error', reason: 'budget-access-denied' });
    return;
  }
  if (record.runtime.state !== 'ready') {
    res.status(409).json({ status: 'error', reason: 'budget-not-ready' });
    return;
  }
  try {
    const session = await remoteWorkerManager.openSession(
      budgetId,
      record.runtime.engine_directory_id,
      auth.userId,
      auth.credentialId,
    );
    const currentAuth = authenticate(req, res);
    if (
      !currentAuth ||
      currentAuth.userId !== auth.userId ||
      currentAuth.credentialId !== auth.credentialId ||
      !currentAuth.grantedFileIds.includes(budgetId)
    ) {
      await remoteWorkerManager.closeSession(budgetId, session.id);
      if (!res.headersSent) {
        res.status(401).json({ status: 'error', reason: 'unauthorized' });
      }
      return;
    }
    res.status(201).json({
      protocolVersion: 1,
      sessionId: session.id,
      budgetId,
    });
  } catch (error) {
    sendManagerError(res, error);
  }
});

app.post('/session/:budgetId/:sessionId/close', async (req, res) => {
  const auth = authenticate(req, res);
  if (!auth) return;
  const record = getOwnedRemoteBudget(req.params.budgetId, auth.userId);
  if (!record || !auth.grantedFileIds.includes(req.params.budgetId)) {
    res.status(404).json({ status: 'error', reason: 'budget-not-found' });
    return;
  }
  const session = remoteWorkerManager.validateSession(
    req.params.budgetId,
    req.params.sessionId,
    auth.userId,
    auth.credentialId,
  );
  if (!session) {
    res.status(404).json({ status: 'error', reason: 'session-not-found' });
    return;
  }
  try {
    await remoteWorkerManager.closeSession(
      req.params.budgetId,
      req.params.sessionId,
    );
    res.status(204).end();
  } catch (error) {
    sendManagerError(res, error);
  }
});

app.get('/session/:budgetId/:sessionId', (req, res) => {
  const auth = authenticate(req, res);
  if (!auth) return;
  const record = getOwnedRemoteBudget(req.params.budgetId, auth.userId);
  if (!record || !auth.grantedFileIds.includes(req.params.budgetId)) {
    res.status(404).json({ status: 'error', reason: 'budget-not-found' });
    return;
  }
  const session = remoteWorkerManager.validateSession(
    req.params.budgetId,
    req.params.sessionId,
    auth.userId,
    auth.credentialId,
  );
  if (!session) {
    res.status(404).json({ status: 'error', reason: 'session-not-found' });
    return;
  }
  res.json({
    protocolVersion: 1,
    sessionId: session.id,
    budgetId: req.params.budgetId,
  });
});

export { app as remoteModeHandlers };

/** Internal empty-budget provisioning hook for server administration and tests. */
export async function provisionEmptyRemoteBudget(
  ownerId: string,
  name: string,
) {
  if (
    typeof name !== 'string' ||
    !ownerId ||
    !name.trim() ||
    name.length > 128
  ) {
    throw new Error('invalid-remote-budget-metadata');
  }
  const owner = getAccountDb().first(
    'SELECT id FROM users WHERE id = ? AND enabled = 1',
    [ownerId],
  );
  if (!owner) throw new Error('remote-budget-owner-unavailable');
  await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
  const candidate = randomUUID().replaceAll('-', '');
  if (!isValidFileId(candidate)) {
    throw new Error('invalid-remote-budget-identity');
  }
  const id = candidate;
  const accountDb = getAccountDb();
  accountDb.transaction(() => {
    const files = new FilesService(accountDb);
    files.set(
      new File({
        id,
        name,
        groupId: null,
        encryptMeta: null,
        syncVersion: null,
        owner: ownerId,
        operationMode: 'remote',
        deleted: true,
      }),
    );
    accountDb.mutate(
      `INSERT INTO remote_budget_runtime (file_id, engine_directory_id, state, created_at)
       VALUES (?, ?, 'provisioning', ?)`,
      [id, id, Date.now()],
    );
  });
  try {
    await remoteWorkerManager.createBudget(id, id);
    await remoteWorkerManager.stopProvisioningWorker(id);
    accountDb.transaction(() => {
      accountDb.mutate(
        "UPDATE remote_budget_runtime SET state = 'ready' WHERE file_id = ?",
        [id],
      );
      accountDb.mutate('UPDATE files SET deleted = 0 WHERE id = ?', [id]);
    });
    return { id, operationMode: 'remote' as const };
  } catch (error) {
    try {
      await remoteWorkerManager.stopProvisioningWorker(id);
    } catch (stopError) {
      accountDb.mutate(
        "UPDATE remote_budget_runtime SET state = 'failed' WHERE file_id = ?",
        [id],
      );
      process.emitWarning(
        stopError instanceof Error ? stopError.message : 'worker stop failed',
      );
      throw new Error('remote-budget-provision-cleanup-pending');
    }
    accountDb.transaction(() => {
      accountDb.mutate('DELETE FROM remote_budget_runtime WHERE file_id = ?', [
        id,
      ]);
      accountDb.mutate('DELETE FROM files WHERE id = ?', [id]);
    });
    const dir = resolve(remoteRoot, id);
    if (dir.startsWith(remoteRoot + '/')) {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

function authenticate(req: express.Request, res: express.Response) {
  const token = getRequestToken(req, res);
  if (res.headersSent) return null;
  const session = validateBudgetSession(req, res);
  if (!session || typeof token !== 'string') return null;
  return {
    userId: session.user_id,
    grantedFileIds:
      'apiKeyFileIds' in session
        ? session.apiKeyFileIds
        : getOwnedFileIds(session.user_id),
    credentialId: createHash('sha256').update(token).digest('hex'),
  };
}

function getOwnedFileIds(userId: string) {
  return getAccountDb()
    .all('SELECT id FROM files WHERE owner = ? AND deleted = 0', [userId])
    .map((row: { id: string }) => row.id);
}

function getOwnedRemoteBudget(budgetId: unknown, userId: string) {
  if (typeof budgetId !== 'string' || !isValidFileId(budgetId)) return null;
  let file: File;
  try {
    file = new FilesService(getAccountDb()).get(budgetId);
  } catch {
    return null;
  }
  if (file.operationMode !== 'remote' || file.owner !== userId) return null;
  const runtime = getAccountDb().first(
    'SELECT engine_directory_id, state FROM remote_budget_runtime WHERE file_id = ?',
    [budgetId],
  ) as RuntimeRow | undefined;
  return runtime ? { file, runtime } : null;
}

function sendManagerError(res: express.Response, error: unknown) {
  if (res.headersSent) return;
  const message = error instanceof Error ? error.message : 'worker-error';
  if (message === 'remote-session-limit') {
    res.status(429).json({ status: 'error', reason: message });
    return;
  }
  if (message === 'remote-budget-already-open') {
    res.status(503).json({ status: 'error', reason: message });
    return;
  }
  res.status(503).json({ status: 'error', reason: 'worker-unavailable' });
}
