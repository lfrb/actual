import { expect, it, vi } from 'vitest';

import { init } from './index';

vi.mock('@actual-app/core/server/main', () => {
  throw new Error('local engine module was imported');
});

it('does not import the local engine for remote initialization', async () => {
  await expect(
    init({ mode: 'remote', serverURL: 'https://example.test', token: 'token' }),
  ).rejects.toMatchObject({ code: 'remote-mode-unavailable' });
});
