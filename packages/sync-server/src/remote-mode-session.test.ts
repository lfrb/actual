import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { getAccountDb } from './account-db';
import { config } from './load-config';
import {
  provisionEmptyRemoteBudget,
  remoteModeHandlers,
  remoteWorkerManager,
} from './remote-mode';

const created: { owner: string; token: string; budgetId?: string }[] = [];
const openedSessions: { budgetId: string; sessionId: string }[] = [];

async function invokeRoute(
  routePath: string,
  method: 'get' | 'post',
  token: string,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  const layer = remoteModeHandlers.stack.find(
    item => item.route?.path === routePath,
  );
  if (!layer?.route) throw new Error(`Missing route ${method} ${routePath}`);
  const handler = layer.route.stack[0].handle as unknown as (
    req: unknown,
    res: typeof response,
    next: () => void,
  ) => Promise<void>;
  const response = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value as Record<string, string>;
      this.headersSent = true;
      return this;
    },
    send(value: unknown) {
      this.body = value as Record<string, string>;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const req = {
    method: method.toUpperCase(),
    path: routePath,
    headers: { authorization: `Bearer ${token}` },
    body,
    params,
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  await handler(req, response, () => undefined);
  return response;
}

afterEach(async () => {
  const root = path.join(config.get('userFiles'), 'remote-budgets');
  for (const session of openedSessions.splice(0)) {
    await remoteWorkerManager.closeSession(session.budgetId, session.sessionId);
  }
  for (const item of created.splice(0)) {
    getAccountDb().mutate('DELETE FROM sessions WHERE user_id = ?', [
      item.owner,
    ]);
    getAccountDb().mutate('DELETE FROM api_keys WHERE user_id = ?', [
      item.owner,
    ]);
    if (item.budgetId) {
      getAccountDb().mutate(
        'DELETE FROM remote_budget_runtime WHERE file_id = ?',
        [item.budgetId],
      );
      getAccountDb().mutate('DELETE FROM files WHERE id = ?', [item.budgetId]);
      await fs.rm(path.join(root, item.budgetId), {
        recursive: true,
        force: true,
      });
    }
    getAccountDb().mutate('DELETE FROM users WHERE id = ?', [item.owner]);
  }
});

describe('remote session authorization', () => {
  it('serves the complete session lifecycle through the mounted HTTP routes', async () => {
    const owner = randomUUID();
    const token = randomUUID();
    getAccountDb().mutate(
      'INSERT INTO users (id, user_name, role, enabled) VALUES (?, ?, ?, 1)',
      [owner, owner, 'BASIC'],
    );
    getAccountDb().mutate(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, -1)',
      [token, owner],
    );
    const owned: { owner: string; token: string; budgetId?: string } = {
      owner,
      token,
    };
    created.push(owned);
    const budget = await provisionEmptyRemoteBudget(owner, 'HTTP session');
    owned.budgetId = budget.id;

    const server = express();
    server.use(express.json());
    server.use('/remote', remoteModeHandlers);
    const opened = await request(server)
      .post('/remote/session/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ protocolVersion: 1, budgetId: budget.id })
      .expect(201);
    expect(opened.statusCode).toBe(201);
    openedSessions.push({
      budgetId: budget.id,
      sessionId: opened.body.sessionId,
    });
    const status = await request(server)
      .get(`/remote/session/${budget.id}/${opened.body.sessionId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.statusCode).toBe(200);
    const closed = await request(server)
      .post(`/remote/session/${budget.id}/${opened.body.sessionId}/close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(closed.statusCode).toBe(204);
  });

  it('binds sessions to owner and credential, rechecks revocation, and closes one session independently', async () => {
    const owner = randomUUID();
    const token = randomUUID();
    getAccountDb().mutate(
      'INSERT INTO users (id, user_name, role, enabled) VALUES (?, ?, ?, 1)',
      [owner, owner, 'BASIC'],
    );
    getAccountDb().mutate(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, -1)',
      [token, owner],
    );
    const alternateToken = randomUUID();
    getAccountDb().mutate(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, -1)',
      [alternateToken, owner],
    );
    created.push({ owner, token });
    const budget = await provisionEmptyRemoteBudget(owner, 'Session lifecycle');
    created[created.length - 1].budgetId = budget.id;

    const opened = await invokeRoute('/session/open', 'post', token, {
      protocolVersion: 1,
      budgetId: budget.id,
    });
    expect(opened.statusCode).toBe(201);
    openedSessions.push({
      budgetId: budget.id,
      sessionId: String(opened.body.sessionId),
    });
    const second = await invokeRoute('/session/open', 'post', token, {
      protocolVersion: 1,
      budgetId: budget.id,
    });
    expect(second.statusCode).toBe(201);
    openedSessions.push({
      budgetId: budget.id,
      sessionId: String(second.body.sessionId),
    });

    for (const [requestToken, expectedStatus] of [
      [alternateToken, 404],
      ['valid-token-user', 404],
    ] as const) {
      const rejected = await invokeRoute(
        '/session/:budgetId/:sessionId',
        'get',
        requestToken,
        {},
        { budgetId: budget.id, sessionId: opened.body.sessionId },
      );
      expect(rejected.statusCode).toBe(expectedStatus);
    }
    const adminDenied = await invokeRoute(
      '/session/open',
      'post',
      'valid-token-admin',
      { protocolVersion: 1, budgetId: budget.id },
    );
    expect(adminDenied.statusCode).toBe(404);

    const closed = await invokeRoute(
      '/session/:budgetId/:sessionId/close',
      'post',
      token,
      {},
      { budgetId: budget.id, sessionId: opened.body.sessionId },
    );
    expect(closed.statusCode).toBe(204);
    const remains = await invokeRoute(
      '/session/:budgetId/:sessionId',
      'get',
      token,
      {},
      { budgetId: budget.id, sessionId: second.body.sessionId },
    );
    expect(remains.statusCode).toBe(200);

    getAccountDb().mutate('UPDATE users SET enabled = 0 WHERE id = ?', [owner]);
    const disabledUser = await invokeRoute(
      '/session/:budgetId/:sessionId',
      'get',
      token,
      {},
      { budgetId: budget.id, sessionId: second.body.sessionId },
    );
    expect(disabledUser.statusCode).toBe(401);
    getAccountDb().mutate('UPDATE users SET enabled = 1 WHERE id = ?', [owner]);

    const apiKey = `actual_${randomBytes(32).toString('base64url')}`;
    const apiKeyId = randomUUID();
    getAccountDb().mutate(
      'INSERT INTO api_keys (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [
        apiKeyId,
        owner,
        'remote-test',
        createHash('sha256').update(apiKey).digest('hex'),
        Date.now(),
      ],
    );
    getAccountDb().mutate(
      'INSERT INTO api_key_budgets (key_id, file_id) VALUES (?, ?)',
      [apiKeyId, budget.id],
    );
    const keySession = await invokeRoute('/session/open', 'post', apiKey, {
      protocolVersion: 1,
      budgetId: budget.id,
    });
    expect(keySession.statusCode).toBe(201);
    openedSessions.push({
      budgetId: budget.id,
      sessionId: String(keySession.body.sessionId),
    });
    getAccountDb().mutate(
      'DELETE FROM api_key_budgets WHERE key_id = ? AND file_id = ?',
      [apiKeyId, budget.id],
    );
    const revokedGrant = await invokeRoute(
      '/session/:budgetId/:sessionId',
      'get',
      apiKey,
      {},
      { budgetId: budget.id, sessionId: String(keySession.body.sessionId) },
    );
    expect(revokedGrant.statusCode).toBe(404);
    getAccountDb().mutate('DELETE FROM api_keys WHERE id = ?', [apiKeyId]);
    const revokedKey = await invokeRoute(
      '/session/:budgetId/:sessionId',
      'get',
      apiKey,
      {},
      { budgetId: budget.id, sessionId: String(keySession.body.sessionId) },
    );
    expect(revokedKey.statusCode).toBe(401);

    getAccountDb().mutate('DELETE FROM sessions WHERE token = ?', [token]);
    const revoked = await invokeRoute(
      '/session/:budgetId/:sessionId',
      'get',
      token,
      {},
      { budgetId: budget.id, sessionId: second.body.sessionId },
    );
    expect(revoked.statusCode).toBe(401);
  });

  it('rejects unsupported session protocol versions before loading a worker', async () => {
    const response = await invokeRoute('/session/open', 'post', 'valid-token', {
      protocolVersion: 2,
      budgetId: 'nonexistent',
    });
    expect(response.statusCode).toBe(400);
  });
});
