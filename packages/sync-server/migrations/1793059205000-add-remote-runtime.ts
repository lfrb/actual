import { getAccountDb } from '../src/account-db';

/** Server-owned runtime identity; engine directory names never come from clients. */
export async function up(): Promise<void> {
  await getAccountDb().exec(`
    CREATE TABLE remote_budget_runtime (
      file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      engine_directory_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed')),
      created_at INTEGER NOT NULL
    )
  `);
}

export async function down(): Promise<void> {
  await getAccountDb().exec('DROP TABLE remote_budget_runtime');
}
