import { getAccountDb } from '../src/account-db';

/** Adds server-owned operation mode metadata; existing files remain synced. */
export async function up(): Promise<void> {
  await getAccountDb().exec(
    "ALTER TABLE files ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'synced' CHECK (operation_mode IN ('synced', 'remote'))",
  );
}

export async function down(): Promise<void> {
  await getAccountDb().exec('ALTER TABLE files DROP COLUMN operation_mode');
}
