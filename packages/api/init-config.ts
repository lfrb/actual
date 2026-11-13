import type { InitConfig } from '@actual-app/core/server/main';

export type SDKInitConfig =
  | (InitConfig & { mode?: 'local' })
  | { mode: 'remote'; serverURL: string; token: string };
