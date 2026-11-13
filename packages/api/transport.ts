/** SDK-owned seam between the public methods and their execution transport. */
import type { send as Send } from '@actual-app/core/platform/client/connection';

export type Dispatcher = typeof Send;

let activeDispatcher: Dispatcher | null = null;

export function setDispatcher(dispatcher: Dispatcher | null) {
  activeDispatcher = dispatcher;
}

export const send: Dispatcher = async (type, args, options) => {
  if (activeDispatcher) return activeDispatcher(type, args, options);
  throw new SDKNotInitializedError();
};

export function clearDispatcher() {
  activeDispatcher = null;
}

export class RemoteModeUnavailableError extends Error {
  readonly code = 'remote-mode-unavailable';

  constructor() {
    super('Remote mode is not available in this SDK version.');
    this.name = 'RemoteModeUnavailableError';
  }
}

export class SDKNotInitializedError extends Error {
  readonly code = 'sdk-not-initialized';

  constructor() {
    super('The SDK has not been initialized.');
    this.name = 'SDKNotInitializedError';
  }
}
