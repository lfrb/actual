/** Stable wire contract for the first remote budget protocol. */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

/** Parse a validated date-only value as a local calendar date (no UTC rollover). */
export function parseRemoteCalendarDate(value: string): Date {
  if (!isDate(value)) {
    throw new RemoteProtocolError('invalid-request', 'Invalid calendar date');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

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

export const REMOTE_OPERATION_REGISTRY = {
  'ui.accounts': { handler: 'accounts-get', write: false, payload: [] },
  'ui.categories': { handler: 'get-categories', write: false, payload: [] },
  'ui.payees': { handler: 'payees-get', write: false, payload: [] },
  'ui.tags': { handler: 'tags-get', write: false, payload: [] },
  'ui.account-groups': {
    handler: 'account-groups-get',
    write: false,
    payload: [],
  },
  'ui.bounds': { handler: 'get-budget-bounds', write: false, payload: [] },
  'ui.cell': {
    handler: 'get-cell',
    write: false,
    payload: ['sheetName', 'name'],
  },
  'ui.note': { handler: 'notes-get', write: false, payload: ['id'] },
  'ui.query': { handler: 'query', write: false, payload: ['query'] },
  'accounts.list': { handler: 'api/accounts-get', write: false, payload: [] },
  'account.balance': {
    handler: 'api/account-balance',
    write: false,
    payload: ['id', 'cutoff'],
  },
  'account-groups.list': {
    handler: 'api/account-groups-get',
    write: false,
    payload: [],
  },
  'categories.list': {
    handler: 'api/categories-get',
    write: false,
    payload: ['hidden'],
  },
  'category-groups.list': {
    handler: 'api/category-groups-get',
    write: false,
    payload: ['hidden'],
  },
  'payees.list': { handler: 'api/payees-get', write: false, payload: [] },
  'tags.list': { handler: 'api/tags-get', write: false, payload: [] },
  'rules.list': { handler: 'api/rules-get', write: false, payload: [] },
  'budget-months.list': {
    handler: 'api/budget-months',
    write: false,
    payload: [],
  },
  'budget-month.get': {
    handler: 'api/budget-month',
    write: false,
    payload: ['month'],
  },
  'preferences.get': { handler: 'preferences/get', write: false, payload: [] },
  'budget-month.set-amount': {
    handler: 'api/budget-set-amount',
    write: true,
    payload: ['month', 'categoryId', 'amount'],
  },
  'budget-month.set-carryover': {
    handler: 'api/budget-set-carryover',
    write: true,
    payload: ['month', 'categoryId', 'flag'],
  },
  'aql.query': { handler: 'query', write: false, payload: ['query'] },
  'account.create': {
    handler: 'api/account-create',
    write: true,
    payload: ['account', 'initialBalance'],
  },
  'account.update': {
    handler: 'api/account-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'account.close': {
    handler: 'api/account-close',
    write: true,
    payload: ['id'],
  },
  'account.reopen': {
    handler: 'api/account-reopen',
    write: true,
    payload: ['id'],
  },
  'account-group.create': {
    handler: 'account-group-create',
    write: true,
    payload: ['name'],
  },
  'account-group.update': {
    handler: 'account-group-update',
    write: true,
    payload: ['id', 'name'],
  },
  'account-group.delete': {
    handler: 'account-group-delete',
    write: true,
    payload: ['id'],
  },
  'category-group.create': {
    handler: 'api/category-group-create',
    write: true,
    payload: ['group'],
  },
  'category-group.update': {
    handler: 'api/category-group-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'category-group.delete': {
    handler: 'api/category-group-delete',
    write: true,
    payload: ['id'],
  },
  'category.create': {
    handler: 'api/category-create',
    write: true,
    payload: ['category'],
  },
  'category.update': {
    handler: 'api/category-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'category.delete': {
    handler: 'api/category-delete',
    write: true,
    payload: ['id'],
  },
  'payee.create': {
    handler: 'api/payee-create',
    write: true,
    payload: ['payee'],
  },
  'payee.update': {
    handler: 'api/payee-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'payee.delete': { handler: 'api/payee-delete', write: true, payload: ['id'] },
  'tag.create': { handler: 'api/tag-create', write: true, payload: ['tag'] },
  'tag.update': {
    handler: 'api/tag-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'tag.delete': { handler: 'api/tag-delete', write: true, payload: ['id'] },
  'rule.add': { handler: 'api/rule-create', write: true, payload: ['rule'] },
  'rule.update': { handler: 'api/rule-update', write: true, payload: ['rule'] },
  'rule.delete': { handler: 'api/rule-delete', write: true, payload: ['id'] },
  'preferences.save': {
    handler: 'preferences/save',
    write: true,
    payload: ['id', 'value'],
  },
  'transactions.list': {
    handler: 'api/transactions-get',
    write: false,
    payload: ['accountId', 'startDate', 'endDate'],
  },
  'transactions.add': {
    handler: 'api/transactions-add',
    write: true,
    payload: ['accountId', 'transactions', 'runTransfers', 'learnCategories'],
  },
  'transactions.update': {
    handler: 'api/transaction-update',
    write: true,
    payload: ['id', 'fields'],
  },
  'transactions.delete': {
    handler: 'api/transaction-delete',
    write: true,
    payload: ['id'],
  },
  'transactions.import': {
    handler: 'api/transactions-import',
    write: true,
    payload: ['accountId', 'transactions'],
  },
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
    'operation-indeterminate',
    'operation-timeout',
    'operation-not-dispatched',
    'request-too-large',
    'result-too-large',
    'queue-full',
    'operation-failed',
  ],
  operationSchemas: Object.fromEntries(
    Object.entries(REMOTE_OPERATION_REGISTRY).map(([operation, schema]) => [
      operation,
      { payload: schema.payload, write: schema.write },
    ]),
  ),
} as const;

export type RemoteV1Operation = keyof typeof REMOTE_OPERATION_REGISTRY;

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

  if (!validateJson(input.payload, 0)) {
    throw new RemoteProtocolError(
      'invalid-request',
      'Payload is not bounded JSON data',
    );
  }
  const payload = JSON.parse(JSON.stringify(input.payload)) as Record<
    string,
    unknown
  >;
  const schema = REMOTE_OPERATION_REGISTRY[input.operation];
  if (
    hasOnlyKeys(payload, schema.payload) &&
    validatePayload(input.operation, payload)
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
  return Object.hasOwn(REMOTE_OPERATION_REGISTRY, value);
}

const MAX_TRANSACTIONS = 500;
const SAFE_AQL_TABLES = new Set([
  'transactions',
  'accounts',
  'account_groups',
  'categories',
  'category_groups',
  'payees',
  'rules',
]);
const SAFE_AQL_COLUMNS: Record<string, readonly string[]> = {
  transactions: [
    'id',
    'is_parent',
    'is_child',
    'parent_id',
    'account',
    'category',
    'amount',
    'payee',
    'notes',
    'date',
    'imported_id',
    'imported_payee',
    'starting_balance_flag',
    'transfer_id',
    'sort_order',
    'cleared',
    'reconciled',
    'tombstone',
    'schedule',
  ],
  accounts: [
    'id',
    'name',
    'offbudget',
    'closed',
    'sort_order',
    'tombstone',
    'account_id',
    'official_name',
    'account_sync_source',
    'last_reconciled',
    'last_sync',
    'bank_sync_status',
    'account_group_id',
  ],
  account_groups: ['id', 'name', 'sort_order', 'tombstone'],
  categories: [
    'id',
    'name',
    'is_income',
    'hidden',
    'group',
    'goal_def',
    'cleanup_def',
    'template_settings',
    'sort_order',
    'tombstone',
  ],
  category_groups: [
    'id',
    'name',
    'is_income',
    'hidden',
    'sort_order',
    'tombstone',
  ],
  payees: [
    'id',
    'name',
    'transfer_acct',
    'tombstone',
    'favorite',
    'learn_categories',
  ],
  rules: ['id', 'stage', 'conditions', 'actions', 'conditions_op', 'tombstone'],
};
function validatePayload(
  operation: RemoteV1Operation,
  payload: Record<string, unknown>,
) {
  if (
    [
      'ui.accounts',
      'ui.categories',
      'ui.payees',
      'ui.tags',
      'ui.account-groups',
      'ui.bounds',
    ].includes(operation)
  ) {
    return Object.keys(payload).length === 0;
  }
  if (operation === 'ui.note') return validId(payload.id);
  if (operation === 'ui.cell') {
    return [payload.sheetName, payload.name].every(
      value =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        /^[\w.:-]+$/.test(value),
    );
  }
  if (operation === 'ui.query') return validateAql(payload.query, true);
  if (operation === 'transactions.list') {
    return (
      optionalId(payload.accountId) &&
      optionalDate(payload.startDate) &&
      optionalDate(payload.endDate)
    );
  }
  if (operation === 'categories.list' || operation === 'category-groups.list') {
    return payload.hidden === undefined || typeof payload.hidden === 'boolean';
  }
  if (operation === 'budget-months.list') return true;
  if (operation === 'budget-month.get') return validMonth(payload.month);
  if (operation === 'account.balance') {
    return (
      validId(payload.id) &&
      (payload.cutoff === undefined || isDate(payload.cutoff))
    );
  }
  if (
    operation === 'accounts.list' ||
    operation === 'account-groups.list' ||
    operation === 'payees.list' ||
    operation === 'tags.list' ||
    operation === 'rules.list' ||
    operation === 'preferences.get'
  ) {
    return Object.keys(payload).length === 0;
  }
  if (operation === 'aql.query') return validateAql(payload.query);
  if (operation === 'transactions.import') {
    return (
      validId(payload.accountId) && validTransactions(payload.transactions)
    );
  }
  if (operation === 'transactions.add') {
    return (
      validId(payload.accountId) &&
      validTransactions(payload.transactions) &&
      (payload.runTransfers === undefined ||
        typeof payload.runTransfers === 'boolean') &&
      (payload.learnCategories === undefined ||
        typeof payload.learnCategories === 'boolean')
    );
  }
  if (operation === 'transactions.delete') return validId(payload.id);
  if (operation === 'preferences.save') {
    return (
      typeof payload.id === 'string' &&
      [
        'numberFormat',
        'hideFraction',
        'defaultCurrencyCode',
        'currencySymbolPosition',
        'currencySpaceBetweenAmountAndSymbol',
      ].includes(payload.id) &&
      (payload.value === undefined || typeof payload.value === 'string')
    );
  }
  if (operation === 'budget-month.set-amount') {
    return (
      validMonth(payload.month) &&
      validId(payload.categoryId) &&
      Number.isSafeInteger(payload.amount)
    );
  }
  if (operation === 'budget-month.set-carryover') {
    return (
      validMonth(payload.month) &&
      validId(payload.categoryId) &&
      typeof payload.flag === 'boolean'
    );
  }
  if (operation === 'account.create') {
    return (
      isRecord(payload.account) &&
      hasOnlyKeys(payload.account, ['name', 'offbudget', 'closed']) &&
      typeof payload.account.name === 'string' &&
      payload.account.name.length <= 256 &&
      (payload.account.offbudget === undefined ||
        typeof payload.account.offbudget === 'boolean') &&
      (payload.account.closed === undefined ||
        typeof payload.account.closed === 'boolean') &&
      (payload.initialBalance === undefined ||
        payload.initialBalance === null ||
        Number.isSafeInteger(payload.initialBalance))
    );
  }
  if (
    operation === 'account.close' ||
    operation === 'account.reopen' ||
    operation === 'account-group.delete' ||
    operation === 'category.delete' ||
    operation === 'category-group.delete' ||
    operation === 'payee.delete' ||
    operation === 'tag.delete' ||
    operation === 'rule.delete'
  ) {
    return validId(payload.id);
  }
  if (operation === 'account-group.create') {
    return typeof payload.name === 'string' && payload.name.length <= 256;
  }
  if (operation === 'account-group.update') {
    return (
      validId(payload.id) &&
      typeof payload.name === 'string' &&
      payload.name.length <= 256
    );
  }
  if (operation === 'account.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      hasOnlyKeys(payload.fields, [
        'name',
        'offbudget',
        'closed',
        'sort_order',
        'last_reconciled',
        'account_group_id',
      ]) &&
      validObjectFields(payload.fields, {
        name: 'string',
        offbudget: 'boolean',
        closed: 'boolean',
        sort_order: 'number',
        last_reconciled: 'string-null',
        account_group_id: 'id-null',
      })
    );
  }
  if (operation === 'transactions.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      validTransaction(payload.fields, true)
    );
  }
  if (operation === 'category.create') {
    return (
      isRecord(payload.category) &&
      hasOnlyKeys(payload.category, [
        'name',
        'is_income',
        'group_id',
        'hidden',
      ]) &&
      typeof payload.category.name === 'string' &&
      validObjectFields(payload.category, {
        name: 'string',
        is_income: 'boolean',
        group_id: 'id-null',
        hidden: 'boolean',
      })
    );
  }
  if (operation === 'category.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      hasOnlyKeys(payload.fields, [
        'name',
        'is_income',
        'group_id',
        'hidden',
        'goal_def',
        'cleanup_def',
        'sort_order',
      ]) &&
      validObjectFields(payload.fields, {
        name: 'string',
        is_income: 'boolean',
        group_id: 'id-null',
        hidden: 'boolean',
        goal_def: 'string-null',
        cleanup_def: 'string-null',
        sort_order: 'number',
      })
    );
  }
  if (operation === 'category-group.create') {
    return (
      isRecord(payload.group) &&
      hasOnlyKeys(payload.group, ['name', 'hidden', 'is_income']) &&
      typeof payload.group.name === 'string' &&
      validObjectFields(payload.group, {
        name: 'string',
        hidden: 'boolean',
        is_income: 'boolean',
      })
    );
  }
  if (operation === 'category-group.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      hasOnlyKeys(payload.fields, [
        'name',
        'hidden',
        'is_income',
        'sort_order',
      ]) &&
      validObjectFields(payload.fields, {
        name: 'string',
        hidden: 'boolean',
        is_income: 'boolean',
        sort_order: 'number',
      })
    );
  }
  if (operation === 'payee.create') {
    return (
      isRecord(payload.payee) &&
      hasOnlyKeys(payload.payee, ['name']) &&
      typeof payload.payee.name === 'string' &&
      payload.payee.name.length <= 256
    );
  }
  if (operation === 'payee.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      hasOnlyKeys(payload.fields, [
        'name',
        'favorite',
        'learn_categories',
        'transfer_acct',
      ]) &&
      validObjectFields(payload.fields, {
        name: 'string',
        favorite: 'boolean',
        learn_categories: 'boolean',
        transfer_acct: 'id-null',
      })
    );
  }
  if (operation === 'tag.create') {
    return (
      isRecord(payload.tag) &&
      hasOnlyKeys(payload.tag, ['tag', 'color', 'description']) &&
      typeof payload.tag.tag === 'string' &&
      validObjectFields(payload.tag, {
        tag: 'string',
        color: 'string-null',
        description: 'string-null',
      })
    );
  }
  if (operation === 'tag.update') {
    return (
      validId(payload.id) &&
      isRecord(payload.fields) &&
      hasOnlyKeys(payload.fields, ['tag', 'color', 'description', 'hidden']) &&
      validObjectFields(payload.fields, {
        tag: 'string',
        color: 'string-null',
        description: 'string-null',
        hidden: 'boolean',
      })
    );
  }
  if (operation === 'rule.add' || operation === 'rule.update') {
    return (
      isRecord(payload.rule) &&
      validateRule(payload.rule, operation === 'rule.update')
    );
  }
  return false;
}

function validTransactions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRANSACTIONS &&
    value.every(item => validTransaction(item, false, true))
  );
}

function validTransaction(
  item: unknown,
  partial = false,
  requireDateAndAmount = false,
): boolean {
  const allowed = [
    'account',
    'category',
    'amount',
    'payee',
    'payee_name',
    'notes',
    'date',
    'imported_id',
    'imported_payee',
    'starting_balance_flag',
    'cleared',
    'reconciled',
    'subtransactions',
  ];
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, allowed) ||
    !validateJson(item, 0)
  ) {
    return false;
  }
  if (!partial && !('amount' in item && Number.isSafeInteger(item.amount))) {
    return false;
  }
  if (requireDateAndAmount && !isDate(item.date)) return false;
  if ('amount' in item && !Number.isSafeInteger(item.amount)) return false;
  if ('date' in item && !isDate(item.date)) return false;
  for (const key of ['account', 'category', 'payee'] as const) {
    if (key in item && item[key] !== null && !validId(item[key])) return false;
  }
  for (const key of ['payee_name', 'notes', 'imported_payee'] as const) {
    if (
      key in item &&
      item[key] !== null &&
      (typeof item[key] !== 'string' || item[key].length > 8192)
    ) {
      return false;
    }
  }
  if (
    'imported_id' in item &&
    item.imported_id !== null &&
    (typeof item.imported_id !== 'string' || item.imported_id.length > 512)
  ) {
    return false;
  }
  if ('cleared' in item && typeof item.cleared !== 'boolean') return false;
  if ('reconciled' in item && typeof item.reconciled !== 'boolean') {
    return false;
  }
  if (
    'starting_balance_flag' in item &&
    typeof item.starting_balance_flag !== 'boolean'
  ) {
    return false;
  }
  if (
    'subtransactions' in item &&
    (!Array.isArray(item.subtransactions) ||
      item.subtransactions.length > 100 ||
      !item.subtransactions.every(child => validTransaction(child)))
  ) {
    return false;
  }
  return true;
}

function validateAql(value: unknown, ui = false): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'table',
      'tableOptions',
      'filterExpressions',
      'selectExpressions',
      'groupExpressions',
      'orderExpressions',
      'calculation',
      'rawMode',
      'withDead',
      'validateRefs',
      'limit',
      'offset',
    ])
  ) {
    return false;
  }
  const uiColumns: Record<string, readonly string[]> = {
    transaction_filters: [
      'id',
      'name',
      'conditions',
      'conditions_op',
      'tombstone',
    ],
  };
  if (
    typeof value.table !== 'string' ||
    (!SAFE_AQL_TABLES.has(value.table) &&
      !(ui && Object.hasOwn(uiColumns, value.table)))
  ) {
    return false;
  }
  if (
    (value.rawMode !== undefined && value.rawMode !== false) ||
    (value.withDead !== undefined && value.withDead !== false) ||
    (value.validateRefs !== undefined && value.validateRefs !== true) ||
    (!ui && value.calculation !== undefined && value.calculation !== false)
  ) {
    return false;
  }
  const calculation = value.calculation ?? false;
  if (typeof calculation !== 'boolean') return false;
  if (calculation) {
    if (
      !ui ||
      !Array.isArray(value.selectExpressions) ||
      value.selectExpressions.length !== 1
    ) {
      return false;
    }
    const selected = value.selectExpressions[0];
    if (
      !isRecord(selected) ||
      Object.keys(selected).length !== 1 ||
      !isRecord(selected.result) ||
      Object.keys(selected.result).length !== 1
    ) {
      return false;
    }
    if (
      !(
        selected.result.$count === '*' ||
        (value.table === 'transactions' && selected.result.$sum === '$amount')
      )
    ) {
      return false;
    }
  }
  if (
    value.tableOptions !== undefined &&
    (!isRecord(value.tableOptions) ||
      Object.keys(value.tableOptions).some(key => key !== 'splits') ||
      (value.tableOptions.splits !== undefined &&
        value.tableOptions.splits !== 'grouped' &&
        value.tableOptions.splits !== 'none' &&
        !(ui && ['inline', 'all'].includes(String(value.tableOptions.splits)))))
  ) {
    return false;
  }
  if (
    isRecord(value.tableOptions) &&
    Object.hasOwn(value.tableOptions, 'splits') &&
    value.table !== 'transactions'
  ) {
    return false;
  }
  if (
    value.limit !== undefined &&
    value.limit !== null &&
    (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 0 ||
      (value.limit as number) > 1000)
  ) {
    return false;
  }
  if (
    value.offset !== undefined &&
    value.offset !== null &&
    (!Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      (value.offset as number) > 100000)
  ) {
    return false;
  }
  const columns = SAFE_AQL_COLUMNS[value.table] ?? uiColumns[value.table];
  const fields =
    ui && value.table === 'transactions'
      ? [
          ...columns,
          'account.closed',
          'account.offbudget',
          'account.name',
          'account.account_group_id',
          'payee.name',
          'payee.transfer_acct',
          'payee.transfer_acct.name',
          'payee.transfer_acct.offbudget',
          'category.name',
        ]
      : columns;
  if (
    !calculation &&
    value.selectExpressions !== undefined &&
    (!Array.isArray(value.selectExpressions) ||
      !value.selectExpressions.every(
        field =>
          field === '*' ||
          (typeof field === 'string' && fields.includes(field)),
      ))
  ) {
    return false;
  }
  let nodes = 0;
  if (
    !['filterExpressions', 'groupExpressions', 'orderExpressions'].every(
      key =>
        value[key] === undefined ||
        (Array.isArray(value[key]) &&
          (value[key] as unknown[]).length <= 64 &&
          (value[key] as unknown[]).every(item =>
            validateAqlExpression(item, 0, fields, () => ++nodes <= 500, ui),
          )),
    )
  ) {
    return false;
  }
  if (nodes > 500) return false;
  const query = value as Record<string, unknown>;
  query.limit = query.limit == null ? 1000 : query.limit;
  query.offset = query.offset == null ? 0 : query.offset;
  query.tableOptions = query.tableOptions ?? {};
  query.filterExpressions = query.filterExpressions ?? [];
  query.selectExpressions = calculation
    ? value.selectExpressions
    : (query.selectExpressions as unknown[] | undefined)?.includes('*') ||
        !(query.selectExpressions as unknown[] | undefined)?.length
      ? columns.filter(
          field => field !== 'raw_synced_data' && (ui || field !== 'error'),
        )
      : query.selectExpressions;
  query.groupExpressions = query.groupExpressions ?? [];
  query.orderExpressions = query.orderExpressions ?? [];
  query.rawMode = false;
  query.withDead = false;
  query.validateRefs = true;
  query.calculation = calculation;
  return true;
}

function validateAqlExpression(
  value: unknown,
  depth: number,
  fields: readonly string[],
  spend: () => boolean,
  ui = false,
): boolean {
  if (depth > 8 || !spend()) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'string' || value.length <= 512;
  }
  if (typeof value === 'number') {
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 100 &&
      value.every(item =>
        validateAqlExpression(item, depth + 1, fields, spend, ui),
      )
    );
  }
  if (!isRecord(value)) return false;
  const ops = new Set([
    ...(ui ? ['$transform'] : []),
    '$and',
    '$or',
    '$eq',
    '$ne',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$oneof',
    '$like',
    '$notlike',
  ]);
  return Object.entries(value).every(([key, item]) =>
    ui && key === '$transform'
      ? validUiTransform(item)
      : !['__proto__', 'prototype', 'constructor'].includes(key) &&
        (key.startsWith('$') ? ops.has(key) : fields.includes(key)) &&
        validateAqlExpression(item, depth + 1, fields, spend, ui),
  );
}

function validUiTransform(value: unknown): boolean {
  if (value === '$abs') return true;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !isRecord(value.$abs) ||
    Object.keys(value.$abs).length !== 1
  ) {
    return false;
  }
  const division = value.$abs.$idiv;
  return (
    Array.isArray(division) &&
    division.length === 2 &&
    division[0] === '$' &&
    division[1] === 100
  );
}

function validateJson(
  value: unknown,
  depth: number,
  budget = { count: 0 },
): boolean {
  if (depth > 12 || ++budget.count > 10_000) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'string' || value.length <= 8192;
  }
  if (typeof value === 'number') {
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 1000 &&
      value.every(item => validateJson(item, depth + 1, budget))
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      !['__proto__', 'prototype', 'constructor'].includes(key) &&
      key.length <= 128 &&
      validateJson(item, depth + 1, budget),
  );
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}
function optionalId(value: unknown) {
  return value === undefined || value === null || validId(value);
}
function optionalDate(value: unknown) {
  return value === undefined || value === null || isDate(value);
}
function validMonth(value: unknown) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}$/.test(value) &&
    Number(value.slice(5)) >= 1 &&
    Number(value.slice(5)) <= 12
  );
}
function validObjectFields(
  value: Record<string, unknown>,
  types: Record<string, string>,
) {
  return Object.entries(value).every(([key, field]) => {
    const type = types[key];
    if (type === 'string') {
      return typeof field === 'string' && field.length <= 8192;
    }
    if (type === 'string-null') {
      return (
        field === null || (typeof field === 'string' && field.length <= 8192)
      );
    }
    if (type === 'boolean') return typeof field === 'boolean';
    if (type === 'number') {
      return typeof field === 'number' && Number.isFinite(field);
    }
    if (type === 'id-null') return field === null || validId(field);
    return type === 'json' && validateJson(field, 0);
  });
}
function validateRule(value: Record<string, unknown>, update: boolean) {
  if (
    !hasOnlyKeys(value, [
      ...(update ? ['id'] : []),
      'conditionsOp',
      'conditions',
      'actions',
      'stage',
    ])
  ) {
    return false;
  }
  if (update && !validId(value.id)) return false;
  if (value.conditionsOp !== 'and' && value.conditionsOp !== 'or') return false;
  if (
    value.stage !== undefined &&
    value.stage !== null &&
    value.stage !== 'pre' &&
    value.stage !== 'post' &&
    value.stage !== 'default'
  ) {
    return false;
  }
  if (
    !Array.isArray(value.conditions) ||
    value.conditions.length > 64 ||
    !Array.isArray(value.actions) ||
    value.actions.length > 64
  ) {
    return false;
  }
  return (
    value.conditions.every(item => {
      const fields = [
        'account',
        'amount',
        'category',
        'category_group',
        'date',
        'notes',
        'payee',
        'payee_name',
        'imported_payee',
        'saved',
        'transfer',
        'parent',
        'cleared',
        'reconciled',
      ];
      const ops = [
        'is',
        'isNot',
        'oneOf',
        'notOneOf',
        'contains',
        'doesNotContain',
        'matches',
        'onBudget',
        'offBudget',
        'isapprox',
        'isbetween',
        'gt',
        'gte',
        'lt',
        'lte',
        'hasTags',
        'hasAnyTag',
      ];
      if (
        !isRecord(item) ||
        !hasOnlyKeys(item, [
          'field',
          'op',
          'value',
          'options',
          'conditionsOp',
          'type',
          'customName',
        ]) ||
        typeof item.field !== 'string' ||
        !fields.includes(item.field) ||
        typeof item.op !== 'string' ||
        !ops.includes(item.op) ||
        !validateJson(item.value, 0)
      ) {
        return false;
      }
      if (
        item.conditionsOp !== undefined &&
        item.conditionsOp !== 'and' &&
        item.conditionsOp !== 'or'
      ) {
        return false;
      }
      if (
        item.options !== undefined &&
        (!isRecord(item.options) ||
          !hasOnlyKeys(item.options, ['inflow', 'outflow', 'month', 'year']) ||
          Object.values(item.options).some(flag => typeof flag !== 'boolean'))
      ) {
        return false;
      }
      return true;
    }) &&
    value.actions.every(item => {
      if (
        !isRecord(item) ||
        !hasOnlyKeys(item, ['op', 'field', 'value', 'options', 'type']) ||
        typeof item.op !== 'string' ||
        ![
          'set',
          'set-split-amount',
          'link-schedule',
          'prepend-notes',
          'append-notes',
          'delete-transaction',
        ].includes(item.op) ||
        !validateJson(item.value, 0) ||
        ('field' in item && typeof item.field !== 'string') ||
        ('type' in item && typeof item.type !== 'string')
      ) {
        return false;
      }
      if (item.options !== undefined && !isRecord(item.options)) return false;
      if (isRecord(item.options)) {
        const optionKeys =
          item.op === 'set'
            ? ['template', 'formula', 'splitIndex']
            : ['method', 'formula', 'splitIndex'];
        if (!hasOnlyKeys(item.options, optionKeys)) return false;
        if (
          'splitIndex' in item.options &&
          !Number.isSafeInteger(item.options.splitIndex)
        ) {
          return false;
        }
        if (
          'formula' in item.options &&
          typeof item.options.formula !== 'string'
        ) {
          return false;
        }
        if (
          'template' in item.options &&
          typeof item.options.template !== 'string'
        ) {
          return false;
        }
        if (
          'method' in item.options &&
          !['fixed-amount', 'fixed-percent', 'formula', 'remainder'].includes(
            String(item.options.method),
          )
        ) {
          return false;
        }
      }
      return true;
    })
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
