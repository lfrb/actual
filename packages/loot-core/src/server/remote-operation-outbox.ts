import type { DbTransaction } from '#server/db';
import * as db from '#server/db';

export type RemoteOperationTerminalStatus = 'succeeded' | 'interrupted';

export type RemoteTransactionCreatedEvent = {
  version: 1;
  eventId: string;
  type: 'transactions.created';
  budgetId: string;
  operationId: string;
  operationStatus: RemoteOperationTerminalStatus;
  occurredAt: string;
  transactionIds: string[];
  unpairedTransferIds: string[];
};

export type RemoteTransactionChange = {
  id: string;
  previous: unknown;
  next: unknown;
};

export type RemoteOutboxItem = {
  eventId: string;
  operationId: string;
  operationStatus: RemoteOperationTerminalStatus;
  payload: RemoteTransactionCreatedEvent;
  status: 'pending' | 'delivered' | 'dead';
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

type RawTransactionShape = Pick<
  DbTransaction,
  | 'id'
  | 'isParent'
  | 'isChild'
  | 'date'
  | 'acct'
  | 'amount'
  | 'starting_balance_flag'
  | 'tombstone'
  | 'transferred_id'
> & {
  parent_id?: string | null;
  description?: string | null;
};

type CandidateRow = {
  root_id: string;
  created_at: string;
};

type TransactionLinkRow = {
  id: string;
  isParent: number;
  isChild: number;
  parent_id: string | null;
  transferred_id: string | null;
  tombstone: number;
  description: string | null;
};

type EventIdFactory = (identity: string) => string;

let eventIdFactory: EventIdFactory | null = null;

export function setRemoteEventIdFactory(factory: EventIdFactory | null) {
  eventIdFactory = factory;
}

export function initializeRemoteEventOutbox() {
  db.execQuery(`CREATE TABLE IF NOT EXISTS remote_event_candidates (
    budget_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (budget_id, credential_id, request_id, root_id)
  )`);
  db.execQuery(`CREATE TABLE IF NOT EXISTS remote_outbox (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    operation_status TEXT NOT NULL CHECK (operation_status IN ('succeeded', 'interrupted')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead')) DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_attempt_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.execQuery(
    'CREATE INDEX IF NOT EXISTS remote_outbox_pending_idx ON remote_outbox (status, next_attempt_at, created_at)',
  );
}

/** Called inside the transaction that applies the financial messages. */
export function recordRemoteEventCandidates(
  scope: { budgetId: string; credentialId: string; requestId: string },
  changes: RemoteTransactionChange[],
) {
  const unique = new Map(changes.map(change => [change.id, change]));
  const rows = [...unique.values()].map(change => ({
    ...change,
    next:
      change.next === undefined
        ? undefined
        : parseRawTransaction(change.id, change.next),
  }));
  const candidates = new Set<string>();

  for (const change of rows) {
    if (change.previous !== undefined || !change.next) continue;
    const transaction = change.next;
    if (transaction.tombstone === 1) continue;
    if (transaction.isChild === 1) {
      if (!transaction.parent_id) {
        throw new Error('remote-event-unknown-split-shape');
      }
      const parent =
        rows.find(item => item.id === transaction.parent_id)?.next ??
        db.firstSync<RawTransactionShape>(
          'SELECT * FROM transactions WHERE id = ?',
          [transaction.parent_id],
        );
      if (
        !parent ||
        parent.id !== transaction.parent_id ||
        parent.isParent !== 1 ||
        parent.isChild !== 0 ||
        parent.tombstone !== 0
      ) {
        throw new Error('remote-event-unknown-split-shape');
      }
      const parentWasCreated = rows.some(
        item => item.id === parent.id && item.previous === undefined,
      );
      if (parentWasCreated) candidates.add(parent.id);
      continue;
    }
    if (
      transaction.parent_id != null ||
      (transaction.isParent !== 0 && transaction.isParent !== 1)
    ) {
      throw new Error('remote-event-unknown-transaction-shape');
    }
    candidates.add(transaction.id);
  }

  if (candidates.size > 1000) {
    throw new Error('remote-event-candidate-limit');
  }
  const now = new Date().toISOString();
  for (const rootId of candidates) {
    db.runQuery(
      `INSERT INTO remote_event_candidates
        (budget_id, credential_id, request_id, root_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(budget_id, credential_id, request_id, root_id)
       DO NOTHING`,
      [scope.budgetId, scope.credentialId, scope.requestId, rootId, now],
    );
  }
}

/** Must run in the same SQLite transaction as the operation's terminal state. */
export function finalizeRemoteOperationEvents(args: {
  budgetId: string;
  credentialId: string;
  requestId: string;
  operationStatus: RemoteOperationTerminalStatus;
}) {
  const candidates = db.runQuery<CandidateRow>(
    `SELECT root_id, created_at
       FROM remote_event_candidates
      WHERE budget_id = ? AND credential_id = ? AND request_id = ?
      ORDER BY root_id`,
    [args.budgetId, args.credentialId, args.requestId],
    true,
  );
  if (candidates.length === 0) return [];
  if (!eventIdFactory) throw new Error('remote-event-id-factory-missing');

  const rootIds = candidates.map(candidate => candidate.root_id);
  const placeholders = rootIds.map(() => '?').join(', ');
  const rows = db.runQuery<TransactionLinkRow>(
    `SELECT id, isParent, isChild, parent_id, transferred_id, tombstone,
            description
       FROM transactions
      WHERE id IN (${placeholders}) OR parent_id IN (${placeholders})`,
    [...rootIds, ...rootIds],
    true,
  );
  const rowById = new Map(rows.map(row => [row.id, validateLinkRow(row)]));
  const liveRoots = candidates.filter(candidate => {
    const row = rowById.get(candidate.root_id);
    if (!row || row.tombstone !== 0) return false;
    if (row.isChild !== 0 || row.parent_id !== null) {
      throw new Error('remote-event-unknown-candidate-root');
    }
    return row.isParent === 0 || row.isParent === 1;
  });
  const liveRootIds = new Set(liveRoots.map(row => row.root_id));
  const rootForTransaction = new Map<string, string>();
  for (const candidate of liveRoots) {
    rootForTransaction.set(candidate.root_id, candidate.root_id);
  }
  for (const row of rowById.values()) {
    if (row.tombstone !== 0 || row.isChild === 0) continue;
    if (!row.parent_id || !liveRootIds.has(row.parent_id)) continue;
    if (rowById.get(row.parent_id)?.isParent !== 1) {
      throw new Error('remote-event-unknown-split-shape');
    }
    rootForTransaction.set(row.id, row.parent_id);
  }

  const components = new DisjointSet([...liveRootIds]);
  const transferTargets = new Set<string>();
  for (const row of rowById.values()) {
    if (row.tombstone === 0 && row.transferred_id) {
      transferTargets.add(row.transferred_id);
      const sourceRoot = rootForTransaction.get(row.id);
      const targetRoot = rootForTransaction.get(row.transferred_id);
      if (sourceRoot && targetRoot) {
        components.union(sourceRoot, targetRoot);
      }
    }
  }
  const externalTargets = [...transferTargets].filter(
    targetId => !rowById.has(targetId),
  );
  const allRowsById = new Map(rowById);
  if (externalTargets.length > 0) {
    const targetPlaceholders = externalTargets.map(() => '?').join(', ');
    for (const target of db.runQuery<TransactionLinkRow>(
      `SELECT id, isParent, isChild, parent_id, transferred_id, tombstone,
              description
         FROM transactions WHERE id IN (${targetPlaceholders})`,
      externalTargets,
      true,
    )) {
      const validated = validateLinkRow(target);
      allRowsById.set(validated.id, validated);
    }
  }
  const expectedTransfers = new Map<string, number>();
  const matchedTransfers = new Map<string, number>();
  for (const row of rowById.values()) {
    if (row.tombstone !== 0 || row.isParent === 1) continue;
    const sourceRoot = rootForTransaction.get(row.id);
    if (!sourceRoot) continue;
    const hasIntent = hasTransferIntent(row);
    if (!hasIntent && !row.transferred_id) continue;
    expectedTransfers.set(
      sourceRoot,
      (expectedTransfers.get(sourceRoot) ?? 0) + 1,
    );
    const target = row.transferred_id
      ? allRowsById.get(row.transferred_id)
      : undefined;
    if (target?.tombstone === 0 && target.transferred_id === row.id) {
      matchedTransfers.set(
        sourceRoot,
        (matchedTransfers.get(sourceRoot) ?? 0) + 1,
      );
    }
  }

  const grouped = components.groups();
  const eventIds: string[] = [];
  const occurredAt = candidates.reduce(
    (earliest, candidate) =>
      candidate.created_at < earliest ? candidate.created_at : earliest,
    candidates[0].created_at,
  );
  for (const transactionIds of grouped) {
    const sortedIds = transactionIds.sort();
    const eventId = eventIdFactory(
      JSON.stringify([
        args.budgetId,
        args.credentialId,
        args.requestId,
        sortedIds,
      ]),
    );
    const unpairedTransferIds = sortedIds.filter(
      id => (expectedTransfers.get(id) ?? 0) > (matchedTransfers.get(id) ?? 0),
    );
    const payload: RemoteTransactionCreatedEvent = {
      version: 1,
      eventId,
      type: 'transactions.created',
      budgetId: args.budgetId,
      operationId: args.requestId,
      operationStatus: args.operationStatus,
      occurredAt,
      transactionIds: sortedIds,
      unpairedTransferIds,
    };
    const payloadJson = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadJson).byteLength > 256 * 1024) {
      throw new Error('remote-event-payload-limit');
    }
    const finalizedAt = new Date().toISOString();
    db.runQuery(
      `INSERT INTO remote_outbox
        (event_id, operation_id, operation_status, payload_json, status,
         attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      [
        eventId,
        args.requestId,
        args.operationStatus,
        payloadJson,
        occurredAt,
        finalizedAt,
      ],
    );
    eventIds.push(eventId);
  }

  db.runQuery(
    `DELETE FROM remote_event_candidates
      WHERE budget_id = ? AND credential_id = ? AND request_id = ?`,
    [args.budgetId, args.credentialId, args.requestId],
  );
  return eventIds;
}

export function inspectRemoteOutbox(limit = 100): RemoteOutboxItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('remote-outbox-limit');
  }
  return db
    .runQuery<{
      event_id: string;
      operation_id: string;
      operation_status: RemoteOperationTerminalStatus;
      payload_json: string;
      status: RemoteOutboxItem['status'];
      attempt_count: number;
      next_attempt_at: string | null;
      last_attempt_at: string | null;
      delivered_at: string | null;
      created_at: string;
    }>(
      `SELECT event_id, operation_id, operation_status, payload_json, status,
            attempt_count, next_attempt_at, last_attempt_at, delivered_at, created_at
       FROM remote_outbox
      ORDER BY created_at, event_id LIMIT ?`,
      [limit],
      true,
    )
    .map(row => ({
      eventId: row.event_id,
      operationId: row.operation_id,
      operationStatus: row.operation_status,
      payload: JSON.parse(row.payload_json) as RemoteTransactionCreatedEvent,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lastAttemptAt: row.last_attempt_at,
      deliveredAt: row.delivered_at,
      createdAt: row.created_at,
    }));
}

/** IPC-safe inspection page with a strict byte ceiling. */
export function inspectRemoteOutboxPage(limit = 100) {
  const items: RemoteOutboxItem[] = [];
  let bytes = 2;
  for (const item of inspectRemoteOutbox(limit)) {
    const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (itemBytes > 512 * 1024) {
      throw new Error('remote-outbox-item-too-large');
    }
    if (bytes + itemBytes + (items.length > 0 ? 1 : 0) > 3 * 1024 * 1024) {
      return { items, hasMore: true };
    }
    items.push(item);
    bytes += itemBytes + (items.length > 1 ? 1 : 0);
  }
  return { items, hasMore: items.length === limit };
}

function hasTransferIntent(
  transaction: Pick<RawTransactionShape, 'description'>,
) {
  if (transaction.description == null) return false;
  if (typeof transaction.description !== 'string') {
    throw new Error('remote-event-unknown-payee-mapping');
  }
  const mapping = db.firstSync<{ transfer_acct: string | null }>(
    `SELECT p.transfer_acct
       FROM payee_mapping AS pm
       JOIN payees AS p ON p.id = pm.targetId
      WHERE pm.id = ?`,
    [transaction.description],
  );
  return mapping?.transfer_acct != null;
}

function parseRawTransaction(id: string, value: unknown): RawTransactionShape {
  if (!value || typeof value !== 'object') {
    throw new Error('remote-event-unknown-transaction-shape');
  }
  const row = value as Partial<RawTransactionShape>;
  if (
    row.id !== id ||
    (row.isParent !== 0 && row.isParent !== 1) ||
    (row.isChild !== 0 && row.isChild !== 1) ||
    (row.isParent === 1 && row.isChild === 1) ||
    (row.tombstone !== 0 && row.tombstone !== 1) ||
    (row.parent_id != null && typeof row.parent_id !== 'string') ||
    (row.transferred_id != null && typeof row.transferred_id !== 'string') ||
    (row.description != null && typeof row.description !== 'string')
  ) {
    throw new Error('remote-event-unknown-transaction-shape');
  }
  return row as RawTransactionShape;
}

function validateLinkRow(row: TransactionLinkRow): TransactionLinkRow {
  if (
    typeof row.id !== 'string' ||
    (row.isParent !== 0 && row.isParent !== 1) ||
    (row.isChild !== 0 && row.isChild !== 1) ||
    (row.tombstone !== 0 && row.tombstone !== 1) ||
    (row.parent_id !== null && typeof row.parent_id !== 'string') ||
    (row.transferred_id !== null && typeof row.transferred_id !== 'string') ||
    (row.description !== null && typeof row.description !== 'string') ||
    (row.isParent === 1 && row.isChild === 1) ||
    (row.isChild === 1 && row.parent_id === null) ||
    (row.isChild === 0 && row.parent_id !== null)
  ) {
    throw new Error('remote-event-unknown-transaction-shape');
  }
  return row;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  constructor(values: string[]) {
    for (const value of values) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) throw new Error('remote-event-unknown-transfer-root');
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }

  groups() {
    const grouped = new Map<string, string[]>();
    for (const value of this.parent.keys()) {
      const root = this.find(value);
      const group = grouped.get(root);
      if (group) group.push(value);
      else grouped.set(root, [value]);
    }
    return [...grouped.values()];
  }
}
