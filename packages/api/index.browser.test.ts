import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from './index.browser';

const state = vi.hoisted(() => ({
  start: vi.fn(),
  send: vi.fn(),
  worker: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('@actual-app/core/platform/client/backend-worker', () => ({
  startBackendWorker: state.start,
}));
vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: state.send,
}));
vi.mock('./browser-worker?worker&inline', () => ({
  default: class MockInlineWorker {
    constructor() {
      state.worker();
    }
    terminate() {
      state.terminate();
    }
  },
}));

afterEach(async () => {
  await api.shutdown();
  vi.clearAllMocks();
});

describe('browser SDK transport lifecycle', () => {
  it('starts the local worker and delegates SDK calls', async () => {
    state.start.mockResolvedValue(undefined);
    state.send.mockResolvedValue([]);

    await api.init({ mode: 'local' });
    await expect(api.getBudgets()).resolves.toEqual([]);
    await expect(
      api.init({
        mode: 'remote',
        serverURL: 'https://example.test',
        token: 'token',
      }),
    ).rejects.toMatchObject({ code: 'remote-mode-unavailable' });
    await expect(api.getBudgets()).resolves.toEqual([]);
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send).toHaveBeenLastCalledWith(
      'api/get-budgets',
      undefined,
      undefined,
    );
  });

  it('rejects remote init without creating a worker', async () => {
    await expect(
      api.init({
        mode: 'remote',
        serverURL: 'https://example.test',
        token: 'token',
      }),
    ).rejects.toMatchObject({ code: 'remote-mode-unavailable' });
    expect(state.worker).not.toHaveBeenCalled();
  });

  it('terminates a worker when local startup fails and clears the dispatcher', async () => {
    state.start.mockRejectedValue(new Error('start failed'));

    await expect(api.init()).rejects.toThrow('start failed');
    expect(state.terminate).toHaveBeenCalledTimes(1);
    await expect(api.getBudgets()).rejects.toMatchObject({
      code: 'sdk-not-initialized',
    });
  });
});
