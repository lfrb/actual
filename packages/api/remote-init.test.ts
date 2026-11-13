import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('remote initialization', () => {
  it('requires initialization before dispatch', async () => {
    await expect(api.getBudgets()).rejects.toMatchObject({
      code: 'sdk-not-initialized',
    });
  });

  it('rejects before starting the local engine with a stable error code', async () => {
    await expect(
      api.init({
        mode: 'remote',
        serverURL: 'https://example.test',
        token: 'token',
      }),
    ).rejects.toMatchObject({
      name: 'RemoteModeUnavailableError',
      code: 'remote-mode-unavailable',
    });
    expect(api.internal).toBeNull();
  });

  it('does not alter an already initialized local session when remote init is rejected', async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'actual-api-remote-init-'),
    );
    try {
      const local = await api.init({ dataDir });
      await expect(
        api.init({
          mode: 'remote',
          serverURL: 'https://example.test',
          token: 'token',
        }),
      ).rejects.toMatchObject({ code: 'remote-mode-unavailable' });
      expect(api.internal).toBe(local);
      await expect(api.getBudgets()).resolves.toEqual([]);
    } finally {
      await api.shutdown();
      await expect(api.getBudgets()).rejects.toMatchObject({
        code: 'sdk-not-initialized',
      });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
