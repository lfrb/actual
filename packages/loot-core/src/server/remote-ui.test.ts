import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '#platform/server/asyncStorage';
import { send as push } from '#platform/server/connection';
import * as cloudStorage from '#server/cloud-storage';
import * as db from '#server/db';
import { openRemoteBudget, remoteUiHandler } from '#server/remote-ui';

const file: cloudStorage.RemoteFile = {
  fileId: 'budget',
  groupId: 'group',
  name: 'Disposable remote',
  operationMode: 'remote',
  deleted: false,
  encryptKeyId: '',
  hasKey: false,
  owner: 'owner',
  usersWithAccess: [],
};

beforeEach(() => {
  vi.spyOn(db, 'getDatabase').mockReturnValue(null);
  vi.spyOn(db, 'openDatabase').mockRejectedValue(
    new Error('local-budget-must-not-open'),
  );
  vi.spyOn(asyncStorage, 'getItem').mockResolvedValue('test-token');
  vi.spyOn(cloudStorage, 'listRemoteFiles').mockResolvedValue([file]);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/session/open')) {
        return Response.json({
          protocolVersion: 1,
          budgetId: 'budget',
          sessionId: 'session',
          readOnly: true,
        });
      }
      if (String(url).endsWith('/close')) {
        return new Response(null, { status: 204 });
      }
      const request = JSON.parse(String(init?.body));
      return Response.json({
        protocolVersion: 1,
        requestId: request.requestId,
        result: [],
      });
    }),
  );
});

afterEach(async () => {
  await remoteUiHandler('close-budget', undefined)?.(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('browser worker remote budget routing', () => {
  it('opens without a local database and restores local routing after close', async () => {
    await openRemoteBudget({ id: 'budget' });
    const native = vi.fn(() => {
      throw new Error('must-not-run-locally');
    });
    expect(await remoteUiHandler('load-prefs', native)?.(undefined)).toEqual({
      id: 'budget',
      budgetName: file.name,
      remoteReadOnly: true,
    });
    expect(await remoteUiHandler('accounts-get', native)?.(undefined)).toEqual(
      [],
    );
    expect(native).not.toHaveBeenCalled();
    expect(db.openDatabase).not.toHaveBeenCalled();
    await remoteUiHandler('close-budget', undefined)?.(undefined);
    expect(remoteUiHandler('accounts-get', native)).toBeNull();
  });

  it('never falls back to a local mutation for an unsupported command', async () => {
    await openRemoteBudget({ id: 'budget' });
    const native = vi.fn();
    await expect(
      remoteUiHandler('transactions-batch-update', native)?.({ added: [] }),
    ).rejects.toMatchObject({ code: 'remote-ui-operation-unavailable' });
    expect(native).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('remote-ui-error', {
      code: 'remote-ui-operation-unavailable',
    });
  });

  it('refuses conventional or encrypted budgets instead of downloading them', async () => {
    vi.mocked(cloudStorage.listRemoteFiles).mockResolvedValueOnce([
      { ...file, operationMode: 'synced' },
    ]);
    await expect(openRemoteBudget({ id: 'budget' })).rejects.toThrow(
      'remote-budget-unavailable',
    );
    vi.mocked(cloudStorage.listRemoteFiles).mockResolvedValueOnce([
      { ...file, encryptKeyId: 'encrypted' },
    ]);
    await expect(openRemoteBudget({ id: 'budget' })).rejects.toThrow(
      'remote-budget-unavailable',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(db.openDatabase).not.toHaveBeenCalled();
  });

  it('never enables the network UI adapter in a hosted server worker', async () => {
    vi.stubEnv('ACTUAL_HOSTED_RUNTIME', '1');
    await expect(openRemoteBudget({ id: 'budget' })).rejects.toThrow(
      'hosted-runtime-network-forbidden',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
