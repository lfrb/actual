import type { lib } from '@actual-app/core/server/main';

import type { SDKInitConfig } from './init-config';
import {
  clearDispatcher,
  RemoteModeUnavailableError,
  setDispatcher,
} from './transport';
import { validateNodeVersion } from './validateNodeVersion';

export * from './methods';
export * as utils from './utils';

/** @deprecated Please use return value of `init` instead */
export let internal: typeof lib | null = null;

let ownsSession = false;

export type { SDKInitConfig } from './init-config';

export async function init(config: SDKInitConfig = {}) {
  if (config.mode === 'remote') {
    // Do this before importing the engine. Step 2 defines the lifecycle seam;
    // the authenticated RPC adapter is intentionally not implemented yet.
    throw new RemoteModeUnavailableError();
  }

  validateNodeVersion();

  const { init: initLootCore } = await import('@actual-app/core/server/main');
  const localConfig = config;
  internal = await initLootCore(localConfig);
  const connection =
    await import('@actual-app/core/platform/client/connection');
  setDispatcher(async (type, args, options) => {
    return connection.send(type, args, options);
  });
  ownsSession = Boolean(localConfig.serverURL && localConfig.password);
  return internal;
}

export async function shutdown() {
  if (internal) {
    try {
      await internal.send('sync');
    } catch {
      // most likely that no budget is loaded, so the sync failed
    }

    try {
      await internal.send('close-budget');
    } finally {
      try {
        if (ownsSession) {
          await internal.send('subscribe-sign-out');
        }
      } finally {
        ownsSession = false;
        internal = null;
        clearDispatcher();
      }
    }
  }
}
