import path from 'node:path';

import { peggyLoader } from '@actual-app/vite-plugin-peggy';
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: true,
    external: ['better-sqlite3'],
    resolve: { conditions: ['api'] },
  },
  build: {
    ssr: true,
    target: 'node20',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'hosted-worker.ts'),
      formats: ['cjs'],
      fileName: () => 'hosted-worker.js',
    },
  },
  resolve: { conditions: ['api'] },
  plugins: [peggyLoader()],
});
