import {
  parseRemoteV1Request,
  REMOTE_OPERATION_REGISTRY,
} from '#shared/remote-v1-contract';
import type { RemoteV1Operation } from '#shared/remote-v1-contract';

export class RemoteSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RemoteSessionError';
  }
}

type SessionOptions = {
  serverURL: string;
  token: string;
  budgetId: string;
  fetch?: typeof fetch;
  editTransactions?: boolean;
};

/** Network-only UI session. Never loads or stores a budget locally. */
export class RemoteUiSession {
  private sessionId: string | null = null;
  private readonly baseURL: string;
  private readonly fetch: typeof fetch;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private failureEpoch = 0;

  private constructor(private readonly options: SessionOptions) {
    this.options = { ...options };
    const url = new URL(options.serverURL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new RemoteSessionError('invalid-server-url');
    }
    url.search = '';
    url.hash = '';
    this.baseURL = url.href.replace(/\/$/, '') + '/remote';
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  static async open(options: SessionOptions): Promise<RemoteUiSession> {
    const session = new RemoteUiSession(options);
    const writeScope = options.editTransactions
      ? 'transaction-details'
      : undefined;
    const reply = await session.post('/session/open', {
      protocolVersion: 1,
      budgetId: options.budgetId,
      readOnly: !options.editTransactions,
      writeScope,
    });
    if (
      reply.protocolVersion !== 1 ||
      reply.budgetId !== options.budgetId ||
      reply.readOnly !== !options.editTransactions ||
      reply.writeScope !== writeScope ||
      typeof reply.sessionId !== 'string' ||
      reply.sessionId.length === 0
    ) {
      throw new RemoteSessionError('invalid-session-response');
    }
    session.sessionId = reply.sessionId;
    return session;
  }

  read(
    operation: RemoteV1Operation,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (REMOTE_OPERATION_REGISTRY[operation].write) {
      return Promise.reject(new RemoteSessionError('read-only-session'));
    }
    return this.enqueue(operation, payload);
  }

  writeNote(id: string, notes: string): Promise<unknown> {
    if (!this.options.editTransactions) {
      return Promise.reject(new RemoteSessionError('read-only-session'));
    }
    return this.enqueue('ui.transaction-note.update', {
      id,
      fields: { notes },
    });
  }

  writeCleared(id: string, cleared: boolean): Promise<unknown> {
    if (!this.options.editTransactions) {
      return Promise.reject(new RemoteSessionError('read-only-session'));
    }
    return this.enqueue('ui.transaction-cleared.update', { id, cleared });
  }

  private enqueue(
    operation: RemoteV1Operation,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.pending >= 512) {
      return Promise.reject(new RemoteSessionError('queue-full'));
    }
    this.pending++;
    const epoch = this.failureEpoch;
    const result = this.queue
      .then(() => {
        if (epoch !== this.failureEpoch) {
          throw new RemoteSessionError('request-cancelled');
        }
        return this.request(operation, payload);
      })
      .catch(error => {
        if (
          !(
            error instanceof RemoteSessionError &&
            [
              'request-cancelled',
              'session-closed',
              'read-only-session',
            ].includes(error.code)
          )
        ) {
          this.failureEpoch++;
        }
        throw error;
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async request(
    operation: RemoteV1Operation,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.sessionId) throw new RemoteSessionError('session-closed');
    const sessionId = this.sessionId;
    const request = parseRemoteV1Request({
      protocolVersion: 1,
      requestId: globalThis.crypto.randomUUID(),
      operation,
      payload,
    });
    const reply = await this.post(
      `/${encodeURIComponent(this.options.budgetId)}/${encodeURIComponent(sessionId)}/rpc`,
      request,
    );
    if (this.sessionId !== sessionId) {
      throw new RemoteSessionError('session-closed');
    }
    if (reply.protocolVersion !== 1 || reply.requestId !== request.requestId) {
      throw new RemoteSessionError('invalid-rpc-response');
    }
    if (isRecord(reply.error) && typeof reply.error.code === 'string') {
      throw new RemoteSessionError(reply.error.code);
    }
    if (!Object.hasOwn(reply, 'result')) {
      throw new RemoteSessionError('invalid-rpc-response');
    }
    return reply.result;
  }

  async close(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    if (!id) return;
    await this.post(
      `/session/${encodeURIComponent(this.options.budgetId)}/${encodeURIComponent(id)}/close`,
      {},
    );
  }

  private async post(
    path: string,
    body: object,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(this.baseURL + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new RemoteSessionError('network-failure');
    }
    if (response.status === 204) return {};
    if (response.status === 401 || response.status === 403) {
      throw new RemoteSessionError('access-lost');
    }
    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      throw new RemoteSessionError('invalid-server-response');
    }
    if (!isRecord(reply)) {
      throw new RemoteSessionError('invalid-server-response');
    }
    if (!response.ok) {
      const code = isRecord(reply.error) ? reply.error.code : reply.reason;
      throw new RemoteSessionError(
        typeof code === 'string' ? code : 'request-failed',
      );
    }
    return reply;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
