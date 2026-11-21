#!/usr/bin/env node
// Disposable remote-UI server. Always uses fresh synthetic data, never config.json.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const port = Number(process.argv[2] ?? 21306);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Expected an unprivileged TCP port');
}
const dataDir = await mkdtemp(path.join(tmpdir(), 'actual-remote-ui-'));
const output = path.join(root, `node_modules/.cache/actual-remote-ui-${port}`);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('ACTUAL_')),
);
Object.assign(env, {
  NODE_ENV: 'production',
  ACTUAL_DATA_DIR: dataDir,
  ACTUAL_CONFIG_PATH: path.join(dataDir, 'config.json'),
  ACTUAL_SERVER_FILES: path.join(dataDir, 'server-files'),
  ACTUAL_USER_FILES: path.join(dataDir, 'user-files'),
  ACTUAL_WEB_ROOT: path.join(root, 'packages/desktop-client/build'),
  ACTUAL_PORT: String(port),
  ACTUAL_HOSTNAME: '127.0.0.1',
});
try {
  await build({
    configFile: path.join(root, 'packages/sync-server/vite.config.mts'),
    build: {
      outDir: output,
      rollupOptions: {
        input: {
          demo: path.join(
            root,
            'packages/sync-server/test-support/remote-ui.ts',
          ),
        },
      },
    },
  });
  const child = spawn(process.execPath, [path.join(output, 'demo.js')], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  process.exitCode = await new Promise(resolve => {
    child.on('error', error => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', code => resolve(code ?? 0));
  });
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
