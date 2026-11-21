import { describe, expect, it, vi } from 'vitest';

import type { send as Push } from '#platform/server/connection';
import { q } from '#shared/query';

import type { RemoteUiSession } from './remote-session';
import { RemoteUiBridge } from './remote-ui-bridge';

function createBridge() {
  const read = vi.fn<RemoteUiSession['read']>();
  const close = vi.fn<RemoteUiSession['close']>().mockResolvedValue();
  const push = vi.fn<typeof Push>();
  const bridge = new RemoteUiBridge(
    { read, close },
    { id: 'budget', budgetName: 'Remote', remoteReadOnly: true },
    push,
  );
  return { bridge, read, close, push };
}

describe('existing UI to remote reads adapter', () => {
  it('routes native UI reads and rejects mutations without touching the network', async () => {
    const { bridge, read } = createBridge();
    read.mockResolvedValueOnce([{ id: 'account', name: 'Checking' }]);
    expect(await bridge.send('accounts-get')).toEqual([
      { id: 'account', name: 'Checking' },
    ]);
    expect(read).toHaveBeenCalledWith('ui.accounts', {});
    await expect(
      bridge.send('transactions-batch-update', {
        deleted: [{ id: 'transaction' }],
      }),
    ).rejects.toMatchObject({ code: 'remote-ui-operation-unavailable' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps generated balance queries separate between two browser sessions', async () => {
    const first = createBridge();
    const second = createBridge();
    first.read.mockResolvedValue({ data: 100 });
    second.read.mockResolvedValue({ data: 200 });
    const queryA = q('transactions')
      .filter({ account: 'account-a' })
      .calculate({ $sum: '$amount' })
      .serialize();
    const queryB = q('transactions')
      .filter({ account: 'account-b' })
      .calculate({ $sum: '$amount' })
      .serialize();
    await Promise.all([
      first.bridge.send('create-query', {
        sheetName: '__global',
        name: 'same-cell',
        query: queryA,
      }),
      second.bridge.send('create-query', {
        sheetName: '__global',
        name: 'same-cell',
        query: queryB,
      }),
    ]);
    expect(
      await first.bridge.send('get-cell', {
        sheetName: '__global',
        name: 'same-cell',
      }),
    ).toEqual({ name: '__global!same-cell', value: 100 });
    expect(
      await second.bridge.send('get-cell', {
        sheetName: '__global',
        name: 'same-cell',
      }),
    ).toEqual({ name: '__global!same-cell', value: 200 });
    expect(first.read).toHaveBeenLastCalledWith('ui.query', { query: queryA });
    expect(second.read).toHaveBeenLastCalledWith('ui.query', { query: queryB });
  });

  it('pages a large existing-UI request through bounded server queries without dropping rows', async () => {
    const { bridge, read } = createBridge();
    read.mockImplementation(async (_operation, payload) => {
      const query = payload?.query as { offset: number; limit: number };
      return {
        dependencies: ['transactions'],
        data: Array.from({ length: query.limit }, (_, index) => ({
          id: query.offset + index,
        })),
      };
    });
    const result = await bridge.send(
      'query',
      q('transactions').select('*').limit(1500).serialize(),
    );
    expect(result).toMatchObject({
      dependencies: ['transactions'],
      data: expect.arrayContaining([{ id: 0 }, { id: 1499 }]),
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][1]).toMatchObject({
      query: { offset: 0, limit: 1000 },
    });
    expect(read.mock.calls[1][1]).toMatchObject({
      query: { offset: 1000, limit: 500 },
    });
  });

  it('releases unused cells so refresh does not refetch old view bindings', async () => {
    const { bridge, read, push } = createBridge();
    read.mockResolvedValue({ data: 100 });
    await bridge.send('create-query', {
      sheetName: '__global',
      name: 'old-cell',
      query: q('transactions').calculate({ $sum: '$amount' }).serialize(),
    });
    await bridge.send('remote-ui/release-cell', {
      sheetName: '__global',
      name: 'old-cell',
    });
    read.mockClear();
    await bridge.send('sync');
    expect(read).not.toHaveBeenCalled();
    expect(push).toHaveBeenLastCalledWith(
      'sync-event',
      expect.objectContaining({
        type: 'success',
        tables: expect.arrayContaining(['transactions']),
      }),
    );
  });

  it('never publishes an obsolete generated-query result after replacement', async () => {
    const { bridge, read, push } = createBridge();
    let finishOld!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve;
        }),
    );
    const old = bridge.send('create-query', {
      sheetName: '__global',
      name: 'balance',
      query: q('transactions')
        .filter({ account: 'old' })
        .calculate({ $sum: '$amount' })
        .serialize(),
    });
    read.mockResolvedValueOnce({ data: 200 });
    await bridge.send('create-query', {
      sheetName: '__global',
      name: 'balance',
      query: q('transactions')
        .filter({ account: 'new' })
        .calculate({ $sum: '$amount' })
        .serialize(),
    });
    finishOld({ data: 100 });
    await old;
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('cells-changed', [
      { name: '__global!balance', value: 200 },
    ]);
  });
});
