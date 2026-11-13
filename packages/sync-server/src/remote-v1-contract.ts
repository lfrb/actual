/** Stable wire contract for the first remote budget protocol. */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const REMOTE_CAPABILITIES = {
  reads: [
    'accounts',
    'categories',
    'payees',
    'tags',
    'rules',
    'budget-months',
    'preferences',
    'aql',
  ],
  writes: [
    'accounts',
    'categories',
    'payees',
    'tags',
    'rules',
    'budget-months',
    'preferences',
    'transactions-add',
    'transactions-update',
    'transactions-delete',
    'transactions-import',
  ],
  unsupported: [
    'sync',
    'download-budget',
    'local-load-budget',
    'encryption',
    'raw-database',
    'arbitrary-handler',
    'callback-batching',
    'undo',
  ],
} as const;

export const REMOTE_PROTOCOL_CONTRACT = {
  version: REMOTE_PROTOCOL_VERSION,
  transport: 'https-json',
  authentication: 'bearer',
  capabilities: REMOTE_CAPABILITIES,
  errorCodes: [
    'unsupported-protocol-version',
    'unsupported-operation',
    'invalid-request',
    'unauthorized',
    'forbidden',
    'budget-not-found',
    'operation-mode-mismatch',
    'operation-in-progress',
    'operation-interrupted',
  ],
  operationSchemas: {
    'accounts.list': { payload: 'empty-object' },
    'transactions.list': {
      payload: [
        'accountId: string',
        'startDate: YYYY-MM-DD',
        'endDate: YYYY-MM-DD',
      ],
    },
    'transactions.import': {
      payload: ['accountId: string', 'transactions: JSON object[]'],
    },
  },
} as const;

export type RemoteV1Operation =
  | 'accounts.list'
  | 'transactions.list'
  | 'transactions.import';

export type RemoteV1Request = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  requestId: string;
  operation: RemoteV1Operation;
  payload: Record<string, unknown>;
};

export type RemoteV1Response =
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      requestId: string;
      result: unknown;
    }
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      requestId: string;
      error: { code: string; message: string };
    };

export type RemoteV1Session = {
  sessionId: string;
  budgetId: string;
  ownerId: string;
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
};

export class RemoteProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteProtocolError';
  }
}

/** Validates the request envelope and the initial read/import payload schemas. */
export function parseRemoteV1Request(input: unknown): RemoteV1Request {
  if (!isRecord(input)) {
    throw new RemoteProtocolError(
      'invalid-request',
      'Request must be an object',
    );
  }
  if (
    !hasOnlyKeys(input, [
      'protocolVersion',
      'requestId',
      'operation',
      'payload',
    ])
  ) {
    throw new RemoteProtocolError('invalid-request', 'Unknown request field');
  }
  if (input.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    throw new RemoteProtocolError(
      'unsupported-protocol-version',
      'Unsupported remote protocol version',
    );
  }
  if (
    typeof input.requestId !== 'string' ||
    input.requestId.length < 1 ||
    input.requestId.length > 128
  ) {
    throw new RemoteProtocolError('invalid-request', 'Invalid requestId');
  }
  if (typeof input.operation !== 'string') {
    throw new RemoteProtocolError('invalid-request', 'Invalid operation');
  }
  if (!isRemoteV1Operation(input.operation)) {
    throw new RemoteProtocolError(
      'unsupported-operation',
      'Unsupported operation',
    );
  }
  if (!isRecord(input.payload)) {
    throw new RemoteProtocolError(
      'invalid-request',
      'Payload must be an object',
    );
  }

  const payload = input.payload;
  if (input.operation === 'accounts.list' && hasOnlyKeys(payload, [])) {
    return toRequest(input.requestId, input.operation, payload);
  }
  if (
    input.operation === 'transactions.list' &&
    hasOnlyKeys(payload, ['accountId', 'startDate', 'endDate']) &&
    typeof payload.accountId === 'string' &&
    isDate(payload.startDate) &&
    isDate(payload.endDate)
  ) {
    return toRequest(input.requestId, input.operation, payload);
  }
  if (
    input.operation === 'transactions.import' &&
    hasOnlyKeys(payload, ['accountId', 'transactions']) &&
    typeof payload.accountId === 'string' &&
    Array.isArray(payload.transactions) &&
    payload.transactions.every(isRecord)
  ) {
    return toRequest(input.requestId, input.operation, payload);
  }
  throw new RemoteProtocolError(
    'invalid-request',
    `Invalid payload for ${input.operation}`,
  );
}

function toRequest(
  requestId: string,
  operation: RemoteV1Operation,
  payload: Record<string, unknown>,
): RemoteV1Request {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    requestId,
    operation,
    payload,
  };
}

function isRemoteV1Operation(value: string): value is RemoteV1Operation {
  return (
    value === 'accounts.list' ||
    value === 'transactions.list' ||
    value === 'transactions.import'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export type RemoteCapability =
  | (typeof REMOTE_CAPABILITIES.reads)[number]
  | (typeof REMOTE_CAPABILITIES.writes)[number]
  | (typeof REMOTE_CAPABILITIES.unsupported)[number];

export type RemoteBootstrapState =
  | 'draft'
  | 'importing'
  | 'validating'
  | 'published'
  | 'failed';

const bootstrapTransitions: Record<
  RemoteBootstrapState,
  readonly RemoteBootstrapState[]
> = {
  draft: ['importing', 'failed'],
  importing: ['validating', 'failed'],
  validating: ['published', 'failed'],
  published: [],
  failed: [],
};

export function assertRemoteBootstrapTransition(
  from: RemoteBootstrapState,
  to: RemoteBootstrapState,
): void {
  if (!bootstrapTransitions[from].includes(to)) {
    throw new Error(`Invalid remote bootstrap transition: ${from} -> ${to}`);
  }
}

export function assertRemoteBootstrapInput(input: {
  sourceMode?: 'synced' | 'remote';
  encrypted: boolean;
  destinationExists: boolean;
}): void {
  if (input.destinationExists) {
    throw new Error(
      'In-place mode conversion is unsupported; remote bootstrap requires a new budget identity',
    );
  }
  if (input.encrypted) {
    throw new Error(
      'Encrypted backups cannot be bootstrapped as remote budgets; decrypt and export an unencrypted backup first',
    );
  }
}
