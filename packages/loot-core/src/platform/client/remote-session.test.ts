import { describe, expect, it, vi } from 'vitest';

import { RemoteReadonlySession } from './remote-session';

function createServer() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/session/open')) {
      return Response.json(
        {
          protocolVersion: 1,
          budgetId: 'budget',
          sessionId: 'session',
          readOnly: true,
        },
        { status: 201 },
      );
    }
    if (String(url).endsWith('/close')) {
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(String(init?.body));
    return Response.json({
      protocolVersion: 1,
      requestId: request.requestId,
      result: [{ id: 'account' }],
    });
  });
  const options = {
    serverURL: 'https://money.example/actual/',
    token: 'private-token',
    budgetId: 'budget',
    fetch,
  };
  return { fetch, options };
}

describe('read-only remote UI session transport', () => {
  it('cancels queued reads after a connection failure and allows an explicit later retry', async () => {
    const { fetch, options } = createServer();
    const session = await RemoteReadonlySession.open(options);
    fetch.mockRejectedValueOnce(new Error('offline'));
    await Promise.all([
      expect(session.read('accounts.list')).rejects.toMatchObject({
        code: 'network-failure',
      }),
      expect(session.read('payees.list')).rejects.toMatchObject({
        code: 'request-cancelled',
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await session.read('accounts.list')).toEqual([{ id: 'account' }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('opens a server-enforced read-only session and uses bearer-authenticated reads', async () => {
    const { fetch, options } = createServer();
    const session = await RemoteReadonlySession.open(options);
    expect(await session.read('accounts.list')).toEqual([{ id: 'account' }]);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://money.example/actual/remote/session/open',
    );
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      protocolVersion: 1,
      budgetId: 'budget',
      readOnly: true,
    });
    expect(fetch.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
      cache: 'no-store',
      redirect: 'error',
    });
    await session.close();
    await expect(session.read('accounts.list')).rejects.toMatchObject({
      code: 'session-closed',
    });
  });

  it('rejects mutations before dispatch and never retries a failed request', async () => {
    const { fetch, options } = createServer();
    const session = await RemoteReadonlySession.open(options);
    await expect(
      session.read('account.create', { account: { name: 'Denied' } }),
    ).rejects.toMatchObject({ code: 'read-only-session' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(session.read('accounts.list')).rejects.toMatchObject({
      code: 'network-failure',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a server that did not confirm a read-only session', async () => {
    const { fetch, options } = createServer();
    fetch.mockResolvedValueOnce(
      Response.json({
        protocolVersion: 1,
        budgetId: 'budget',
        sessionId: 'session',
        readOnly: false,
      }),
    );
    await expect(RemoteReadonlySession.open(options)).rejects.toMatchObject({
      code: 'invalid-session-response',
    });
  });

  it('rejects a response for a different request instead of showing its data', async () => {
    const { fetch, options } = createServer();
    const session = await RemoteReadonlySession.open(options);
    fetch.mockResolvedValueOnce(
      Response.json({ protocolVersion: 1, requestId: 'other', result: [] }),
    );
    await expect(session.read('accounts.list')).rejects.toMatchObject({
      code: 'invalid-rpc-response',
    });
  });

  it('closes locally even when releasing the server session fails', async () => {
    const { fetch, options } = createServer();
    const session = await RemoteReadonlySession.open(options);
    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(session.close()).rejects.toMatchObject({
      code: 'network-failure',
    });
    await expect(session.read('accounts.list')).rejects.toMatchObject({
      code: 'session-closed',
    });
    await session.close();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
