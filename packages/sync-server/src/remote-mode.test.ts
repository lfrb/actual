import crypto from 'node:crypto';

import { create, SyncRequestSchema, toBinary } from '@actual-app/crdt';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { getAccountDb } from './account-db';
import { handlers as app } from './app-sync';
import { File, FilesService } from './app-sync/services/files-service';
import { isValidFileId } from './util/paths';
import type { FileId } from './util/paths';

const fileIds: string[] = [];

afterEach(() => {
  for (const id of fileIds.splice(0)) {
    getAccountDb().mutate('DELETE FROM user_access WHERE file_id = ?', [id]);
    getAccountDb().mutate('DELETE FROM files WHERE id = ?', [id]);
  }
});

function createRemoteFile(overrides: Record<string, unknown> = {}) {
  const id = createFileId();
  fileIds.push(id);
  getAccountDb().mutate(
    "INSERT INTO files (id, owner, group_id, operation_mode, encrypt_meta) VALUES (?, 'genericAdmin', NULL, 'remote', NULL)",
    [id],
  );
  return { id, ...overrides };
}

function createFileId(): FileId {
  const id = crypto.randomBytes(16).toString('hex');
  if (!isValidFileId(id)) {
    throw new Error('Generated file id is invalid');
  }
  return id;
}

describe('remote mode metadata and legacy route guards', () => {
  it('preserves synced as the default and reports explicit remote mode', () => {
    const id = createFileId();
    fileIds.push(id);
    getAccountDb().mutate('INSERT INTO files (id, owner) VALUES (?, ?)', [
      id,
      'genericAdmin',
    ]);

    const files = new FilesService(getAccountDb());
    expect(files.get(id).operationMode).toBe('synced');
    expect(files.get(createRemoteFile().id).operationMode).toBe('remote');
  });

  it('rejects encryption metadata at remote file creation and update boundaries', () => {
    const files = new FilesService(getAccountDb());
    expect(() =>
      files.set(
        new File({
          id: createFileId(),
          name: 'encrypted',
          groupId: null,
          encryptMeta: '{"keyId":"k"}',
          syncVersion: null,
          owner: 'genericAdmin',
          operationMode: 'remote',
        }),
      ),
    ).toThrow(/Remote budgets cannot use encryption or sync metadata/);

    const { id } = createRemoteFile();
    expect(() => files.update(id, { encryptSalt: 'salt' })).toThrow(
      /Remote budgets cannot use encryption or sync metadata/,
    );
    expect(() =>
      Reflect.apply(files.update, files, [id, { operationMode: 'synced' }]),
    ).toThrow(/operation mode is immutable/);
    expect(() => files.update(id, { groupId: null })).toThrow(
      /cannot use sync group metadata/,
    );
    files.update(id, { name: 'renamed' });
    expect(files.get(id).operationMode).toBe('remote');
  });

  it('rejects legacy reset and encryption-key routes after ownership checks', async () => {
    const { id } = createRemoteFile();
    for (const result of [
      await request(app)
        .post('/reset-user-file')
        .set('x-actual-token', 'valid-token')
        .send({ fileId: id }),
      await request(app)
        .post('/user-get-key')
        .set('x-actual-token', 'valid-token')
        .send({ fileId: id }),
      await request(app)
        .post('/user-create-key')
        .set('x-actual-token', 'valid-token')
        .send({ fileId: id, keyId: 'key', keySalt: 'salt' }),
    ]) {
      expect(result.statusCode).toBe(409);
      expect(result.body).toEqual({ status: 'error', reason: 'remote-budget' });
    }

    expect(
      getAccountDb().first('SELECT group_id FROM files WHERE id = ?', [id])
        .group_id,
    ).toBeNull();
  });

  it('does not reveal remote mode to an unauthorized caller', async () => {
    const { id } = createRemoteFile();
    const result = await request(app)
      .post('/reset-user-file')
      .set('x-actual-token', 'valid-token-user')
      .send({ fileId: id });

    expect(result.statusCode).toBe(403);
    expect(result.text).toBe('file-access-not-allowed');
  });

  it('keeps remote budgets owner-only despite legacy sharing grants', () => {
    const { id } = createRemoteFile();
    getAccountDb().mutate(
      'INSERT INTO user_access (file_id, user_id) VALUES (?, ?)',
      [id, 'genericUser'],
    );

    const visibleFiles = new FilesService(getAccountDb()).find({
      userId: 'genericUser',
    });
    expect(visibleFiles.some((file: { id: string }) => file.id === id)).toBe(
      false,
    );
  });

  it('enforces the mode constraint and exposes mode in authorized file info', async () => {
    const { id } = createRemoteFile();
    expect(() =>
      getAccountDb().mutate(
        "UPDATE files SET operation_mode = 'invalid' WHERE id = ?",
        [id],
      ),
    ).toThrow();

    const result = await request(app)
      .get('/get-user-file-info')
      .set('x-actual-token', 'valid-token')
      .set('x-actual-file-id', id);

    expect(result.statusCode).toBe(200);
    expect(result.body.data.operationMode).toBe('remote');
  });

  it('rejects legacy sync, upload, download, and delete for remote budgets', async () => {
    const { id } = createRemoteFile();
    const syncRequest = create(SyncRequestSchema, {
      fileId: id,
      groupId: 'remote-group',
      since: '2026-01-01T00:00:00.000Z',
    });
    const responseList = await Promise.all([
      request(app)
        .post('/sync')
        .set('x-actual-token', 'valid-token')
        .set('Content-Type', 'application/actual-sync')
        .send(Buffer.from(toBinary(SyncRequestSchema, syncRequest))),
      request(app)
        .post('/upload-user-file')
        .set('Content-Type', 'application/encrypted-file')
        .set('x-actual-token', 'valid-token')
        .set('x-actual-name', 'remote.bud')
        .set('x-actual-file-id', id)
        .set('x-actual-format', '2')
        .send(Buffer.from('replacement')),
      request(app)
        .get('/download-user-file')
        .set('x-actual-token', 'valid-token')
        .set('x-actual-file-id', id),
      request(app)
        .post('/delete-user-file')
        .set('x-actual-token', 'valid-token')
        .send({ fileId: id }),
    ]);

    for (const result of responseList) {
      expect(result.statusCode).toBe(409);
      expect(result.body).toEqual({ status: 'error', reason: 'remote-budget' });
    }
    expect(
      getAccountDb().first('SELECT deleted FROM files WHERE id = ?', [id])
        .deleted,
    ).toBe(0);
  });
});
