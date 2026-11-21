import type { send as Push } from '#platform/server/connection';
import type { RemoteV1Operation } from '#shared/remote-v1-contract';
import type { MetadataPrefs } from '#types/prefs';

import { RemoteSessionError } from './remote-session';
import type { RemoteUiSession } from './remote-session';

const reads: Record<string, RemoteV1Operation> = {
  'accounts-get': 'ui.accounts',
  'get-categories': 'ui.categories',
  'payees-get': 'ui.payees',
  'tags-get': 'ui.tags',
  'account-groups-get': 'ui.account-groups',
  'get-budget-bounds': 'ui.bounds',
  'notes-get': 'ui.note',
};

/** Adapts existing UI reads while keeping generated queries private to this tab. */
export class RemoteUiBridge {
  private readonly queries = new Map<string, Record<string, unknown>>();
  private readonly cells = new Map<
    string,
    { sheetName: string; name: string }
  >();
  private readonly inflight = new Map<
    string,
    Promise<{ name: string; value: unknown }>
  >();
  private readonly viewPrefs: Record<string, unknown> = {};
  private closed = false;

  constructor(
    private readonly session: Pick<RemoteUiSession, 'read' | 'close'> &
      Partial<Pick<RemoteUiSession, 'writeNote' | 'writeCleared'>>,
    readonly metadata: MetadataPrefs,
    private readonly push: typeof Push,
  ) {}

  async send(name: string, input?: unknown): Promise<unknown> {
    if (this.closed) throw new RemoteSessionError('session-closed');
    const args = isRecord(input) ? input : {};
    if (Object.hasOwn(reads, name)) return this.session.read(reads[name], args);
    if (name === 'query') return this.query(args);
    if (name === 'remote-ui/update-transaction-note') {
      if (!this.session.writeNote) {
        throw new RemoteSessionError('read-only-session');
      }
      if (typeof args.id !== 'string' || typeof args.notes !== 'string') {
        throw new RemoteSessionError('invalid-request');
      }
      const updated = await this.session.writeNote(args.id, args.notes);
      if (updated !== true) {
        throw new RemoteSessionError('transaction-not-found');
      }
      this.push('sync-event', { type: 'success', tables: ['transactions'] });
      return;
    }
    if (name === 'remote-ui/update-transaction-cleared') {
      if (!this.session.writeCleared) {
        throw new RemoteSessionError('read-only-session');
      }
      if (typeof args.id !== 'string' || typeof args.cleared !== 'boolean') {
        throw new RemoteSessionError('invalid-request');
      }
      const result = await this.session.writeCleared(args.id, args.cleared);
      if (result === 'updated') {
        this.push('sync-event', { type: 'success', tables: ['transactions'] });
        // Balance cells are independent of the transaction list subscription.
        // A failed refresh cannot turn a confirmed write into an unknown save.
        try {
          await this.refreshCells();
        } catch (error) {
          if (!this.closed) {
            this.push('remote-ui-error', {
              code:
                error instanceof RemoteSessionError
                  ? error.code
                  : 'request-failed',
            });
          }
        }
      }
      if (
        result !== 'updated' &&
        result !== 'not-found' &&
        result !== 'reconciled' &&
        result !== 'split-child'
      ) {
        throw new RemoteSessionError('invalid-rpc-response');
      }
      return result;
    }
    if (name === 'remote-ui/release-cell') {
      if (typeof args.sheetName !== 'string' || typeof args.name !== 'string') {
        throw new RemoteSessionError('invalid-request');
      }
      const key = `${args.sheetName}!${args.name}`;
      this.queries.delete(key);
      this.cells.delete(key);
      this.inflight.delete(key);
      return;
    }
    if (name === 'load-prefs') return this.metadata;
    if (name === 'preferences/get') {
      const prefs = await this.session.read('preferences.get');
      if (!isRecord(prefs)) {
        throw new RemoteSessionError('invalid-rpc-response');
      }
      // The account-history chart is outside this first read-only milestone.
      return {
        ...Object.fromEntries(
          Object.entries(prefs).map(([key, value]) => [
            key,
            /^show-account-.+-net-worth-chart$/.test(key) ? 'false' : value,
          ]),
        ),
        ...this.viewPrefs,
      };
    }
    if (name === 'preferences/save') {
      if (
        typeof args.id !== 'string' ||
        !/^(show-|hide-|transaction-column|account-|expand-)/.test(args.id)
      ) {
        throw new RemoteSessionError('read-only-session');
      }
      this.viewPrefs[args.id] = args.value;
      return;
    }
    if (name === 'create-query') {
      if (
        typeof args.sheetName !== 'string' ||
        typeof args.name !== 'string' ||
        !isRecord(args.query)
      ) {
        throw new RemoteSessionError('invalid-request');
      }
      const key = `${args.sheetName}!${args.name}`;
      if (this.queries.size >= 500 && !this.queries.has(key)) {
        throw new RemoteSessionError('query-limit');
      }
      this.queries.set(key, args.query);
      this.inflight.delete(key);
      const cell = await this.cell(args.sheetName, args.name);
      if (this.queries.get(key) === args.query) this.publishCell(cell);
      return 'ok';
    }
    if (name === 'get-cell') {
      if (typeof args.sheetName !== 'string' || typeof args.name !== 'string') {
        throw new RemoteSessionError('invalid-request');
      }
      return this.cell(args.sheetName, args.name);
    }
    if (name === 'sync') {
      await this.refreshCells();
      this.push('sync-event', {
        // Registers optimistically handle local writes and listen only for
        // completed syncs. An explicit remote refresh must reach those too.
        type: 'success',
        tables: [
          'transactions',
          'accounts',
          'account_groups',
          'categories',
          'category_groups',
          'payees',
          'preferences',
          'transaction_filters',
        ],
      });
      return {};
    }
    throw new RemoteSessionError('remote-ui-operation-unavailable');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queries.clear();
    this.cells.clear();
    await this.session.close();
  }

  private async refreshCells() {
    for (const cell of this.cells.values()) {
      this.publishCell(await this.cell(cell.sheetName, cell.name));
    }
  }

  private cell(
    sheetName: string,
    name: string,
  ): Promise<{ name: string; value: unknown }> {
    const key = `${sheetName}!${name}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = this.readCell(sheetName, name).finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  private async readCell(sheetName: string, name: string) {
    const key = `${sheetName}!${name}`;
    if (this.cells.size >= 500 && !this.cells.has(key)) {
      throw new RemoteSessionError('query-limit');
    }
    this.cells.set(key, { sheetName, name });
    const query = this.queries.get(key);
    if (query) {
      const result = await this.query(query);
      return { name: key, value: result.data };
    }
    const result = await this.session.read('ui.cell', { sheetName, name });
    if (!isRecord(result) || result.name !== key) {
      throw new RemoteSessionError('invalid-rpc-response');
    }
    return { name: key, value: result.value };
  }

  private publishCell(cell: { name: string; value: unknown }) {
    if (!this.closed) this.push('cells-changed', [cell]);
  }

  private async query(
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (query.calculation && query.calculation !== false) {
      const result = await this.session.read('ui.query', { query });
      if (!isRecord(result)) {
        throw new RemoteSessionError('invalid-rpc-response');
      }
      return result;
    }
    const requested = query.limit == null ? 100_000 : query.limit;
    const offset = query.offset ?? 0;
    if (
      !Number.isSafeInteger(requested) ||
      !Number.isSafeInteger(offset) ||
      (requested as number) < 0 ||
      (requested as number) > 100_000 ||
      (offset as number) < 0
    ) {
      throw new RemoteSessionError('query-limit');
    }
    let reply: Record<string, unknown> = {};
    const data: unknown[] = [];
    do {
      const limit = Math.min(1000, (requested as number) - data.length);
      const result = await this.session.read('ui.query', {
        query: { ...query, limit, offset: (offset as number) + data.length },
      });
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new RemoteSessionError('invalid-rpc-response');
      }
      reply = result;
      data.push(...result.data);
      if (result.data.length < limit || data.length === requested) {
        if (query.limit == null && data.length === requested) {
          throw new RemoteSessionError('query-limit');
        }
        break;
      }
    } while (data.length < (requested as number));
    return { ...reply, data };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
