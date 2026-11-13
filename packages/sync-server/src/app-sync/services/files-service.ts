import { isAdmin } from '#account-db';
import { FileNotFound, GenericFileError } from '#app-sync/errors';
import type { WrappedDatabase } from '#db';
import { isValidFileId, isValidGroupId } from '#util/paths';
import type { FileId, GroupId } from '#util/paths';

export type OperationMode = 'synced' | 'remote';

class FileBase {
  name: string | null | undefined;
  groupId: GroupId | null | undefined;
  encryptSalt: string | null | undefined;
  encryptTest: string | null | undefined;
  encryptKeyId: string | null | undefined;
  encryptMeta: string | null | undefined;
  syncVersion: string | null | undefined;
  deleted: boolean;
  owner: string | null | undefined;
  operationMode: OperationMode | undefined;

  constructor(
    name: string | null | undefined,
    groupId: GroupId | null | undefined,
    encryptSalt: string | null | undefined,
    encryptTest: string | null | undefined,
    encryptKeyId: string | null | undefined,
    encryptMeta: string | null | undefined,
    syncVersion: string | null | undefined,
    deleted: number | boolean | undefined,
    owner: string | null | undefined,
    operationMode?: OperationMode,
  ) {
    this.name = name;
    this.groupId = groupId;
    this.encryptSalt = encryptSalt;
    this.encryptTest = encryptTest;
    this.encryptKeyId = encryptKeyId;
    this.encryptMeta = encryptMeta;
    this.syncVersion = syncVersion;
    this.deleted = typeof deleted === 'boolean' ? deleted : Boolean(deleted);
    this.owner = owner;
    this.operationMode = operationMode;
  }
}

type FileConstructorArgs = {
  id: FileId;
  name: string | null;
  groupId: GroupId | null;
  encryptSalt?: string | null;
  encryptTest?: string | null;
  encryptKeyId?: string | null;
  encryptMeta: string | null;
  syncVersion: string | null;
  deleted?: number | boolean;
  owner: string | null;
  operationMode?: OperationMode;
};

class File extends FileBase {
  id: FileId;
  declare operationMode: OperationMode;

  constructor({
    id,
    name = null,
    groupId = null,
    encryptSalt = null,
    encryptTest = null,
    encryptKeyId = null,
    encryptMeta = null,
    syncVersion = null,
    deleted = false,
    owner = null,
    operationMode = 'synced',
  }: FileConstructorArgs) {
    super(
      name,
      groupId,
      encryptSalt,
      encryptTest,
      encryptKeyId,
      encryptMeta,
      syncVersion,
      deleted,
      owner,
      operationMode,
    );
    this.id = id;
  }
}

/**
 * Represents a file update. Will only update the fields that are defined.
 * @class
 * @extends FileBase
 */
class FileUpdate extends FileBase {
  constructor(args: FileUpdateArgs) {
    const {
      name,
      groupId,
      encryptSalt,
      encryptTest,
      encryptKeyId,
      encryptMeta,
      syncVersion,
      deleted,
      owner,
    } = args;
    super(
      name,
      groupId,
      encryptSalt,
      encryptTest,
      encryptKeyId,
      encryptMeta,
      syncVersion,
      deleted,
      owner,
    );
  }
}

type FileUpdateArgs = Partial<
  Omit<FileConstructorArgs, 'id' | 'operationMode' | 'deleted'>
> & { deleted?: boolean };

const boolToInt = (bool: boolean) => {
  return bool ? 1 : 0;
};

type RawFile = {
  id: string;
  group_id: string | null;
  sync_version: string | null;
  name: string | null;
  encrypt_meta: string | null;
  encrypt_salt: string | null;
  encrypt_test: string | null;
  encrypt_keyid: string | null;
  deleted: number;
  owner: string | null;
  operation_mode: string;
};

type UserWithAccess = {
  userId: string;
  displayName: string | null;
  userName: string | null;
};

class FilesService {
  accountDb: WrappedDatabase;

  constructor(accountDb: WrappedDatabase) {
    this.accountDb = accountDb;
  }

  get(fileId: FileId) {
    const rawFile = this.getRaw(fileId);
    if (!rawFile || (rawFile && rawFile.deleted)) {
      throw new FileNotFound();
    }

    return this.validate(rawFile);
  }

  set(file: File) {
    assertRemoteFileMetadata(file.operationMode, file);
    const deletedInt = boolToInt(file.deleted);
    this.accountDb.mutate(
      'INSERT INTO files (id, group_id, sync_version, name, encrypt_meta, encrypt_salt, encrypt_test, encrypt_keyid, deleted, owner, operation_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ? ,?, ?, ?)',
      [
        file.id,
        file.groupId,
        file.syncVersion?.toString(),
        file.name,
        file.encryptMeta,
        file.encryptSalt,
        file.encryptTest,
        file.encryptKeyId,
        deletedInt,
        file.owner,
        file.operationMode,
      ],
    );
  }

  find({ userId, limit = 1000 }: { userId: string; limit?: number }) {
    const canSeeAll = isAdmin(userId);

    return (
      canSeeAll
        ? this.accountDb.all<RawFile>(
            'SELECT * FROM files WHERE deleted = 0 LIMIT ?',
            [limit],
          )
        : this.accountDb.all<RawFile>(
            `SELECT files.*
        FROM files
        WHERE files.owner = ? and deleted = 0
      UNION
       SELECT files.*
        FROM files
        JOIN user_access
          ON user_access.file_id = files.id
          AND user_access.user_id = ?
       WHERE files.deleted = 0 AND files.operation_mode = 'synced' LIMIT ?`,
            [userId, userId, limit],
          )
    )
      .filter(
        (item: RawFile) =>
          item.operation_mode !== 'remote' ||
          item.owner === userId ||
          canSeeAll,
      )
      .map((item: RawFile) => this.validate(item));
  }

  findUsersWithAccess(fileId: FileId) {
    const userAccess =
      this.accountDb.all<UserWithAccess>(
        `SELECT UA.user_id as userId, users.display_name displayName, users.user_name userName
              FROM files
                JOIN user_access UA ON UA.file_id = files.id
                JOIN users on users.id = UA.user_id
              WHERE files.id = ?
          UNION ALL
        SELECT users.id, users.display_name, users.user_name
              FROM files
                JOIN users on users.id = files.owner
              WHERE files.id = ?
          `,
        [fileId, fileId],
      ) || [];

    return userAccess;
  }

  update(id: FileId, fileUpdate: FileUpdateArgs) {
    if (
      'operationMode' in fileUpdate &&
      fileUpdate.operationMode !== undefined
    ) {
      throw new GenericFileError('File operation mode is immutable', { id });
    }
    const currentFile = this.getRaw(id);
    if (!currentFile) {
      throw new GenericFileError('File not found', { id });
    }
    this.validate(currentFile);
    if (currentFile.operation_mode === 'remote') {
      if (
        fileUpdate.groupId !== undefined ||
        fileUpdate.syncVersion !== undefined
      ) {
        throw new GenericFileError(
          'Remote budgets cannot use sync group metadata',
          { id },
        );
      }
      assertRemoteFileMetadata('remote', {
        owner: currentFile.owner,
        groupId: null,
        syncVersion: null,
        encryptMeta:
          fileUpdate.encryptMeta !== undefined
            ? fileUpdate.encryptMeta
            : currentFile.encrypt_meta,
        encryptSalt:
          fileUpdate.encryptSalt !== undefined
            ? fileUpdate.encryptSalt
            : currentFile.encrypt_salt,
        encryptTest:
          fileUpdate.encryptTest !== undefined
            ? fileUpdate.encryptTest
            : currentFile.encrypt_test,
        encryptKeyId:
          fileUpdate.encryptKeyId !== undefined
            ? fileUpdate.encryptKeyId
            : currentFile.encrypt_keyid,
      });
    }
    let query = 'UPDATE files SET';
    const params = [];
    const updates = [];

    if (fileUpdate.name !== undefined) {
      updates.push('name = ?');
      params.push(fileUpdate.name);
    }
    if (fileUpdate.groupId !== undefined) {
      updates.push('group_id = ?');
      params.push(fileUpdate.groupId);
    }
    if (fileUpdate.encryptSalt !== undefined) {
      updates.push('encrypt_salt = ?');
      params.push(fileUpdate.encryptSalt);
    }
    if (fileUpdate.encryptTest !== undefined) {
      updates.push('encrypt_test = ?');
      params.push(fileUpdate.encryptTest);
    }
    if (fileUpdate.encryptKeyId !== undefined) {
      updates.push('encrypt_keyid = ?');
      params.push(fileUpdate.encryptKeyId);
    }
    if (fileUpdate.encryptMeta !== undefined) {
      updates.push('encrypt_meta = ?');
      params.push(fileUpdate.encryptMeta);
    }
    if (fileUpdate.syncVersion !== undefined) {
      updates.push('sync_version = ?');
      params.push(fileUpdate.syncVersion);
    }
    if (fileUpdate.deleted !== undefined) {
      updates.push('deleted = ?');
      params.push(boolToInt(fileUpdate.deleted));
    }

    if (updates.length > 0) {
      query += ' ' + updates.join(', ') + ' WHERE id = ?';
      params.push(id);

      const res = this.accountDb.mutate(query, params);

      if (res.changes !== 1) {
        throw new GenericFileError('Could not update File', { id });
      }
    }

    // Return the modified object
    const rawFile = this.getRaw(id);
    if (!rawFile) {
      throw new GenericFileError('File not found', { id });
    }
    return this.validate(rawFile);
  }

  getRaw(fileId: FileId): RawFile | null {
    return this.accountDb.first(`SELECT * FROM files WHERE id = ?`, [fileId]);
  }

  validate(rawFile: RawFile) {
    const fileId = rawFile.id;
    if (!isValidFileId(fileId)) {
      throw new GenericFileError('Invalid file ID', { fileId });
    }

    if (
      rawFile.operation_mode !== 'synced' &&
      rawFile.operation_mode !== 'remote'
    ) {
      throw new GenericFileError('Invalid file operation mode', {
        fileId,
        operationMode: rawFile.operation_mode,
      });
    }
    let groupId: GroupId | null = null;
    if (rawFile.group_id !== null) {
      if (!isValidGroupId(rawFile.group_id)) {
        throw new GenericFileError('Invalid group ID', {
          groupId: rawFile.group_id,
        });
      }
      groupId = rawFile.group_id;
    }

    if (rawFile.operation_mode === 'remote') {
      assertRemoteFileMetadata('remote', {
        owner: rawFile.owner,
        groupId,
        syncVersion: rawFile.sync_version,
        encryptMeta: rawFile.encrypt_meta,
        encryptSalt: rawFile.encrypt_salt,
        encryptTest: rawFile.encrypt_test,
        encryptKeyId: rawFile.encrypt_keyid,
      });
    }

    return new File({
      id: fileId,
      name: rawFile.name,
      groupId,
      encryptSalt: rawFile.encrypt_salt,
      encryptTest: rawFile.encrypt_test,
      encryptKeyId: rawFile.encrypt_keyid,
      encryptMeta: rawFile.encrypt_meta,
      syncVersion: rawFile.sync_version,
      deleted: Boolean(rawFile.deleted),
      owner: rawFile.owner,
      operationMode: rawFile.operation_mode,
    });
  }
}

function assertRemoteFileMetadata(
  operationMode: OperationMode,
  file: {
    owner?: string | null;
    groupId?: GroupId | null;
    syncVersion?: string | null;
    encryptMeta?: string | null;
    encryptSalt?: string | null;
    encryptTest?: string | null;
    encryptKeyId?: string | null;
  },
) {
  if (
    operationMode === 'remote' &&
    (file.owner === null ||
      file.owner === undefined ||
      file.owner.length === 0 ||
      file.encryptMeta != null ||
      file.encryptSalt != null ||
      file.encryptTest != null ||
      file.encryptKeyId != null ||
      file.groupId != null ||
      file.syncVersion != null)
  ) {
    throw new GenericFileError(
      'Remote budgets cannot use encryption or sync metadata',
    );
  }
}

export { FilesService, File, FileUpdate };
