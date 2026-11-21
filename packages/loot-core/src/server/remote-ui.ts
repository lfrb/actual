import {
  RemoteSessionError,
  RemoteUiSession,
} from '#platform/client/remote-session';
import { RemoteUiBridge } from '#platform/client/remote-ui-bridge';
import * as asyncStorage from '#platform/server/asyncStorage';
import { send as push } from '#platform/server/connection';
import { listRemoteFiles } from '#server/cloud-storage';
import * as db from '#server/db';
import { getServer } from '#server/server-config';

let bridge: RemoteUiBridge | null = null;
let opening = false;

/** No-op outside a remote UI session; the bridge owns these transient cells. */
export async function releaseRemoteUiCell(_args: {
  sheetName: string;
  name: string;
}) {
  // Generated cells only exist while a remote bridge is active.
}

export async function updateRemoteTransactionNote(_args: {
  id: string;
  notes: string;
}) {
  throw new RemoteSessionError('remote-ui-operation-unavailable');
}

export async function openRemoteBudget({
  id,
  editNotes = false,
}: {
  id: string;
  editNotes?: boolean;
}) {
  if (process.env.ACTUAL_HOSTED_RUNTIME === '1') {
    throw new Error('hosted-runtime-network-forbidden');
  }
  if (opening || bridge || db.getDatabase()) {
    throw new Error('budget-already-open');
  }
  opening = true;
  try {
    const server = getServer();
    const token: unknown = await asyncStorage.getItem('user-token');
    if (!server || typeof token !== 'string') {
      throw new Error('not-authenticated');
    }
    const files = await listRemoteFiles();
    const file = files?.find(file => file.fileId === id && !file.deleted);
    if (!file || file.operationMode !== 'remote' || file.encryptKeyId) {
      throw new Error('remote-budget-unavailable');
    }
    const session = await RemoteUiSession.open({
      serverURL: server.BASE_SERVER,
      token,
      budgetId: id,
      editNotes,
    });
    bridge = new RemoteUiBridge(
      session,
      {
        id,
        budgetName: file.name,
        remoteReadOnly: true,
        ...(editNotes ? { remoteTransactionNotes: true } : {}),
      },
      push,
      editNotes ? (id, notes) => session.writeNote(id, notes) : undefined,
    );
    return {};
  } finally {
    opening = false;
  }
}

const localMethods = new Set([
  'get-budgets',
  'get-remote-files',
  'load-global-prefs',
  'save-global-prefs',
  'get-user-data',
  'get-server-url',
  'get-server-version',
  'get-server-info',
  'get-server-prefs',
  'get-current-user',
]);

/** Browser UI demultiplexer. Unknown budget operations never fall back to SQLite. */
export function remoteUiHandler(
  name: string,
  local: ((args: unknown) => unknown) | undefined,
): ((args: unknown) => Promise<unknown>) | null {
  const current = bridge;
  if (!current || localMethods.has(name)) return null;
  if (name === 'close-budget' || name === 'sign-out') {
    return async args => {
      bridge = null;
      try {
        await current.close();
      } catch {
        // Closing the UI still succeeds offline; the server session expires.
      }
      if (name === 'sign-out') return local?.(args);
    };
  }
  return args =>
    current.send(name, args).catch(error => {
      if (
        bridge === current &&
        (name !== 'remote-ui/update-transaction-note' ||
          (error instanceof RemoteSessionError &&
            ['access-lost', 'budget-not-found'].includes(error.code))) &&
        !(
          error instanceof RemoteSessionError && error.code === 'session-closed'
        )
      ) {
        push('remote-ui-error', {
          code:
            error instanceof RemoteSessionError ? error.code : 'request-failed',
        });
      }
      throw error;
    });
}
