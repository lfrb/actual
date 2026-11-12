import { getAccountDb } from '../src/account-db';

export async function up() {
  getAccountDb().exec(`
    ALTER TABLE oauth_issued_tokens ADD COLUMN code_hash TEXT;
    CREATE UNIQUE INDEX oauth_issued_tokens_code_hash
      ON oauth_issued_tokens (code_hash) WHERE code_hash IS NOT NULL;
  `);
}

export async function down() {
  getAccountDb().exec(`
    DROP INDEX oauth_issued_tokens_code_hash;
    ALTER TABLE oauth_issued_tokens DROP COLUMN code_hash;
  `);
}
