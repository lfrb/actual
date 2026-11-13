import { getAccountDb } from '../src/account-db';

export async function up() {
  getAccountDb().exec('ALTER TABLE files ADD COLUMN last_synced_at INTEGER');
}

export async function down() {
  getAccountDb().exec('ALTER TABLE files DROP COLUMN last_synced_at');
}
