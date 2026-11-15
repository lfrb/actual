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
  const requestHeaders: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  const req = {
    method: method.toUpperCase(),
    path: routePath,
    headers: requestHeaders,
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
  it('executes bounded financial RPC through the built worker and HTTP route', async () => {
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
    const budget = await provisionEmptyRemoteBudget(owner, 'RPC integration');
    owned.budgetId = budget.id;

    const server = express();
    server.use('/remote', express.json({ limit: '1mb' }), remoteModeHandlers);
    const opened = await request(server)
      .post('/remote/session/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ protocolVersion: 1, budgetId: budget.id })
      .expect(201);
    const sessionId = opened.body.sessionId as string;
    openedSessions.push({ budgetId: budget.id, sessionId });
    const rpcUrl = `/remote/${budget.id}/${sessionId}/rpc`;

    const createdAccount = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'create-account-1',
        operation: 'account.create',
        payload: {
          account: { name: 'Remote checking', offbudget: false, closed: false },
        },
      })
      .expect(200);
    expect(createdAccount.body.result).toBeTruthy();
    const duplicateAccount = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'create-account-1',
        operation: 'account.create',
        payload: {
          account: { name: 'Remote checking', offbudget: false, closed: false },
        },
      })
      .expect(200);
    expect(duplicateAccount.body.result).toBe(createdAccount.body.result);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'create-account-1',
        operation: 'account.create',
        payload: {
          account: {
            name: 'Different payload',
            offbudget: false,
            closed: false,
          },
        },
      })
      .expect(409);
    const operationStatus = await request(server)
      .get(`/remote/${budget.id}/operations/create-account-1`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(operationStatus.body.operation).toMatchObject({
      operation: 'account.create',
      status: 'succeeded',
      result: createdAccount.body.result,
    });
    const secondCredential = randomUUID();
    getAccountDb().mutate(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, -1)',
      [secondCredential, owner],
    );
    await request(server)
      .get(`/remote/${budget.id}/operations/create-account-1`)
      .set('Authorization', `Bearer ${secondCredential}`)
      .expect(404);
    getAccountDb().mutate('DELETE FROM sessions WHERE token = ?', [
      secondCredential,
    ]);
    await request(server)
      .get(`/remote/${budget.id}/operations/create-account-1`)
      .set('Authorization', `Bearer ${secondCredential}`)
      .expect(401);
    const listed = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'accounts-1',
        operation: 'accounts.list',
        payload: {},
      })
      .expect(200);
    expect(listed.body.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Remote checking',
          offbudget: false,
          closed: false,
        }),
      ]),
    );

    const accountId = createdAccount.body.result as string;
    const imported = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'import-1',
        operation: 'transactions.import',
        payload: {
          accountId,
          transactions: [
            {
              account: accountId,
              date: '2026-01-12',
              imported_id: 'remote-import-1',
              payee_name: 'Imported market',
              amount: -1250,
            },
          ],
        },
      })
      .expect(200);
    expect(imported.body.result).toBeDefined();
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'import-match-1',
        operation: 'transactions.import',
        payload: {
          accountId,
          transactions: [
            {
              account: accountId,
              date: '2026-01-12',
              imported_id: 'remote-import-1',
              payee_name: 'Imported market',
              amount: -1250,
            },
          ],
        },
      })
      .expect(200);
    const importedOutbox = await remoteWorkerManager.inspectOutbox<{
      items: Array<{
        operationId: string;
        payload: { transactionIds: string[] };
      }>;
      hasMore: boolean;
    }>(
      budget.id,
      budget.id,
      owner,
      createHash('sha256').update(token).digest('hex'),
      100,
      () => true,
    );
    expect(
      importedOutbox.items.filter(item => item.operationId === 'import-1'),
    ).toHaveLength(1);
    expect(
      importedOutbox.items.filter(
        item => item.operationId === 'import-match-1',
      ),
    ).toHaveLength(0);
    const transactions = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'transactions-1',
        operation: 'transactions.list',
        payload: { accountId, startDate: '2026-01-01', endDate: '2026-01-31' },
      })
      .expect(200);
    expect(transactions.body.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-01-12', amount: -1250 }),
      ]),
    );
    expect(
      transactions.body.result.filter(
        (row: { date: string }) => row.date === '2026-01-12',
      ),
    ).toHaveLength(1);

    for (const table of [
      'transactions',
      'accounts',
      'account_groups',
      'categories',
      'category_groups',
      'payees',
      'rules',
    ]) {
      const query = await request(server)
        .post(rpcUrl)
        .set('Authorization', `Bearer ${token}`)
        .send({
          protocolVersion: 1,
          requestId: `aql-${table}`,
          operation: 'aql.query',
          payload: {
            query: {
              table,
              tableOptions: {},
              filterExpressions: [],
              selectExpressions: ['*'],
              groupExpressions: [],
              orderExpressions: [],
              calculation: false,
              rawMode: false,
              withDead: false,
              validateRefs: true,
              limit: 1,
              offset: 0,
            },
          },
        })
        .expect(200);
      expect(Array.isArray(query.body.result.data), table).toBe(true);
    }

    const categoryGroup = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'category-group-1',
        operation: 'category-group.create',
        payload: { group: { name: 'Remote expenses' } },
      })
      .expect(200);
    const category = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'category-1',
        operation: 'category.create',
        payload: {
          category: {
            name: 'Remote food',
            group_id: categoryGroup.body.result,
          },
        },
      })
      .expect(200);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'category-update-1',
        operation: 'category.update',
        payload: {
          id: category.body.result,
          fields: { name: 'Remote food updated' },
        },
      })
      .expect(200);
    const split = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'split-1',
        operation: 'transactions.add',
        payload: {
          accountId,
          transactions: [
            {
              date: '2026-01-13',
              amount: -1500,
              payee_name: 'Split shop',
              subtransactions: [
                {
                  amount: -1000,
                  category: category.body.result,
                  notes: 'first split note',
                },
                { amount: -500, category: null },
              ],
            },
          ],
        },
      })
      .expect(200);
    expect(split.body.result).toBeDefined();
    const splitOutbox = await remoteWorkerManager.inspectOutbox<{
      items: Array<{
        operationId: string;
        payload: { transactionIds: string[] };
      }>;
      hasMore: boolean;
    }>(
      budget.id,
      budget.id,
      owner,
      createHash('sha256').update(token).digest('hex'),
      100,
      () => true,
    );
    const splitEvent = splitOutbox.items.find(
      item => item.operationId === 'split-1',
    );
    expect(splitEvent?.payload.transactionIds).toHaveLength(1);
    const splitList = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'split-list-1',
        operation: 'transactions.list',
        payload: { accountId, startDate: '2026-01-13', endDate: '2026-01-13' },
      })
      .expect(200);
    const splitParent = splitList.body.result.find(
      (row: { date: string }) => row.date === '2026-01-13',
    );
    expect(splitParent.amount).toBe(-1500);
    expect(splitParent.subtransactions).toHaveLength(2);
    expect(
      splitParent.subtransactions.reduce(
        (sum: number, row: { amount: number }) => sum + row.amount,
        0,
      ),
    ).toBe(-1500);
    const splitChild = splitParent.subtransactions[0];
    const otherSplitChild = splitParent.subtransactions[1];
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'split-child-update-1',
        operation: 'transactions.update',
        payload: { id: splitChild.id, fields: { amount: -900 } },
      })
      .expect(200);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'split-sibling-update-1',
        operation: 'transactions.update',
        payload: { id: otherSplitChild.id, fields: { amount: -600 } },
      })
      .expect(200);
    const updatedSplit = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'split-child-list-1',
        operation: 'transactions.list',
        payload: { accountId, startDate: '2026-01-13', endDate: '2026-01-13' },
      })
      .expect(200);
    const updatedParent = updatedSplit.body.result.find(
      (row: { date: string }) => row.date === '2026-01-13',
    );
    expect(updatedParent.amount).toBe(
      updatedParent.subtransactions.reduce(
        (sum: number, row: { amount: number }) => sum + row.amount,
        0,
      ),
    );
    const updatedSplitChild = updatedParent.subtransactions.find(
      (row: { id: string }) => row.id === splitChild.id,
    );
    expect(updatedSplitChild.amount).toBe(-900);
    expect(updatedSplitChild.notes).toBe('first split note');

    const destination = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'account-create-2',
        operation: 'account.create',
        payload: {
          account: { name: 'Remote savings', offbudget: false, closed: false },
        },
      })
      .expect(200);
    const payees = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'transfer-payees-1',
        operation: 'payees.list',
        payload: {},
      })
      .expect(200);
    const transferPayee = payees.body.result.find(
      (payee: { transfer_acct?: string }) =>
        payee.transfer_acct === destination.body.result,
    );
    expect(transferPayee).toBeDefined();
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'transfer-add-1',
        operation: 'transactions.add',
        payload: {
          accountId,
          runTransfers: true,
          transactions: [
            { date: '2026-01-14', amount: -2200, payee: transferPayee.id },
          ],
        },
      })
      .expect(200);
    const transferRows = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'transfer-list-1',
        operation: 'transactions.list',
        payload: { startDate: '2026-01-14', endDate: '2026-01-14' },
      })
      .expect(200);
    expect(transferRows.body.result).toHaveLength(2);
    expect(transferRows.body.result[0].transfer_id).toBe(
      transferRows.body.result[1].id,
    );
    expect(transferRows.body.result[1].transfer_id).toBe(
      transferRows.body.result[0].id,
    );
    expect(
      transferRows.body.result[0].amount + transferRows.body.result[1].amount,
    ).toBe(0);

    const tag = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'tag-1',
        operation: 'tag.create',
        payload: { tag: { tag: 'remote-test' } },
      })
      .expect(200);
    expect(tag.body.result).toBeTruthy();
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'tag-update-1',
        operation: 'tag.update',
        payload: {
          id: tag.body.result,
          fields: { description: 'updated through rpc' },
        },
      })
      .expect(200);
    const tags = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'tags-1',
        operation: 'tags.list',
        payload: {},
      })
      .expect(200);
    expect(tags.body.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'remote-test' })]),
    );

    const rulePayee = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-payee-1',
        operation: 'payee.create',
        payload: { payee: { name: 'Rule assignment shop' } },
      })
      .expect(200);
    const rule = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-create-1',
        operation: 'rule.add',
        payload: {
          rule: {
            stage: 'pre',
            conditionsOp: 'and',
            conditions: [
              { field: 'payee', op: 'is', value: rulePayee.body.result },
            ],
            actions: [
              { op: 'set', field: 'category', value: category.body.result },
            ],
          },
        },
      })
      .expect(200);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-run-1',
        operation: 'transactions.add',
        payload: {
          accountId,
          transactions: [
            {
              date: '2026-01-15',
              amount: -333,
              payee: rulePayee.body.result,
            },
          ],
        },
      })
      .expect(200);
    const ruleApplied = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-applied-list-1',
        operation: 'transactions.list',
        payload: { accountId, startDate: '2026-01-15', endDate: '2026-01-15' },
      })
      .expect(200);
    expect(ruleApplied.body.result[0].category).toBe(category.body.result);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-update-1',
        operation: 'rule.update',
        payload: {
          rule: {
            id: rule.body.result.id,
            stage: 'pre',
            conditionsOp: 'and',
            conditions: [
              { field: 'payee', op: 'is', value: rulePayee.body.result },
            ],
            actions: [
              { op: 'set', field: 'category', value: category.body.result },
            ],
          },
        },
      })
      .expect(200);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'rule-delete-1',
        operation: 'rule.delete',
        payload: { id: rule.body.result.id },
      })
      .expect(200);

    const preference = await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'prefs-1',
        operation: 'preferences.save',
        payload: { id: 'numberFormat', value: 'comma-dot' },
      })
      .expect(200);
    expect(preference.body.result).toBeDefined();

    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        requestId: 'bad-aql-1',
        operation: 'aql.query',
        payload: { query: { table: 'preferences', rawMode: true } },
      })
      .expect(400);
    await request(server)
      .post(rpcUrl)
      .set('Authorization', `Bearer ${randomUUID()}`)
      .send({
        protocolVersion: 1,
        requestId: 'hijack-1',
        operation: 'accounts.list',
        payload: {},
      })
      .expect(401);
  }, 30_000);

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
