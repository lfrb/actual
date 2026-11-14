import { describe, expect, it } from 'vitest';

import {
  assertRemoteBootstrapInput,
  assertRemoteBootstrapTransition,
  parseRemoteCalendarDate,
  parseRemoteV1Request,
  REMOTE_CAPABILITIES,
  REMOTE_OPERATION_REGISTRY,
  REMOTE_PROTOCOL_CONTRACT,
  RemoteProtocolError,
} from './remote-v1-contract';

describe('remote v1 protocol contract', () => {
  it('declares a versioned JSON capability and error contract', () => {
    expect(REMOTE_PROTOCOL_CONTRACT.version).toBe(1);
    expect(REMOTE_PROTOCOL_CONTRACT.transport).toBe('https-json');
    expect(REMOTE_CAPABILITIES.unsupported).toContain('sync');
    expect(REMOTE_CAPABILITIES.unsupported).toContain('encryption');
    expect(REMOTE_CAPABILITIES.writes).toContain('transactions-import');
    expect(REMOTE_PROTOCOL_CONTRACT.errorCodes).toContain(
      'unsupported-operation',
    );
  });

  it('accepts one valid payload for every registered operation and rejects unknown envelope keys', () => {
    const validPayloads: Record<string, Record<string, unknown>> = {
      'accounts.list': {},
      'account.balance': { id: 'account-1' },
      'account-groups.list': {},
      'categories.list': {},
      'category-groups.list': {},
      'payees.list': {},
      'tags.list': {},
      'rules.list': {},
      'budget-months.list': {},
      'budget-month.get': { month: '2026-01' },
      'preferences.get': {},
      'aql.query': {
        query: {
          table: 'accounts',
          tableOptions: {},
          filterExpressions: [],
          selectExpressions: [],
          groupExpressions: [],
          orderExpressions: [],
          calculation: false,
          rawMode: false,
          withDead: false,
          validateRefs: true,
          limit: null,
          offset: null,
        },
      },
      'account.create': {
        account: { name: 'Checking', offbudget: false, closed: false },
      },
      'account.update': { id: 'account-1', fields: { name: 'New name' } },
      'account.close': { id: 'account-1' },
      'account.reopen': { id: 'account-1' },
      'account-group.create': { name: 'Cash' },
      'account-group.update': { id: 'group-1', name: 'Cash' },
      'account-group.delete': { id: 'group-1' },
      'category-group.create': { group: { name: 'Food' } },
      'category-group.update': { id: 'group-1', fields: { name: 'Food' } },
      'category-group.delete': { id: 'group-1' },
      'category.create': {
        category: { name: 'Groceries', group_id: 'group-1' },
      },
      'category.update': { id: 'category-1', fields: { hidden: true } },
      'category.delete': { id: 'category-1' },
      'payee.create': { payee: { name: 'Market' } },
      'payee.update': { id: 'payee-1', fields: { name: 'Market' } },
      'payee.delete': { id: 'payee-1' },
      'tag.create': { tag: { tag: 'travel' } },
      'tag.update': { id: 'tag-1', fields: { hidden: true } },
      'tag.delete': { id: 'tag-1' },
      'rule.add': {
        rule: { conditionsOp: 'and', conditions: [], actions: [] },
      },
      'rule.update': {
        rule: {
          id: 'rule-1',
          conditionsOp: 'and',
          conditions: [],
          actions: [],
        },
      },
      'rule.delete': { id: 'rule-1' },
      'preferences.save': { id: 'numberFormat', value: 'comma-dot' },
      'budget-month.set-amount': {
        month: '2026-01',
        categoryId: 'category-1',
        amount: 25000,
      },
      'budget-month.set-carryover': {
        month: '2026-01',
        categoryId: 'category-1',
        flag: true,
      },
      'transactions.list': {
        accountId: 'account-1',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      },
      'transactions.add': {
        accountId: 'account-1',
        transactions: [{ date: '2026-01-01', amount: -100, payee: 'payee-1' }],
      },
      'transactions.update': {
        id: 'transaction-1',
        fields: { notes: 'updated' },
      },
      'transactions.delete': { id: 'transaction-1' },
      'transactions.import': {
        accountId: 'account-1',
        transactions: [{ date: '2026-01-01', amount: -100 }],
      },
    };
    for (const operation of Object.keys(REMOTE_OPERATION_REGISTRY)) {
      expect(
        Object.prototype.hasOwnProperty.call(validPayloads, operation),
        `${operation} has a fixture`,
      ).toBe(true);
      expect(() =>
        parseRemoteV1Request({
          protocolVersion: 1,
          requestId: 'valid-1',
          operation,
          payload: validPayloads[operation],
        }),
      ).not.toThrow();
      expect(() =>
        parseRemoteV1Request({
          protocolVersion: 1,
          requestId: 'invalid-1',
          operation,
          payload: { ...validPayloads[operation], extra: true },
        }),
      ).toThrowError(/Invalid payload/);
    }
  });

  it('rejects malformed nested financial fields and unsafe AQL flags/structures', () => {
    const rejects = (operation: string, payload: Record<string, unknown>) =>
      expect(() =>
        parseRemoteV1Request({
          protocolVersion: 1,
          requestId: 'bad-1',
          operation,
          payload,
        }),
      ).toThrowError(RemoteProtocolError);
    rejects('account.update', { id: 'account-1', fields: { name: 5 } });
    rejects('account.update', {
      id: 'account-1',
      fields: { account_group_id: {} },
    });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [
        {
          date: '2026-01-01',
          amount: Number.MAX_SAFE_INTEGER + 1,
          raw_synced_data: 'internal',
        },
      ],
    });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [{ date: '2026-01-01', amount: 1, cleared: 'false' }],
    });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [
        { date: '2026-01-01', amount: 1, transfer_id: 'other-budget' },
      ],
    });
    rejects('transactions.add', { accountId: 'account-1', transactions: [{}] });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [{ date: '2026-01-01', amount: 1, notes: {} }],
    });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [
        {
          date: '2026-01-01',
          amount: 10,
          subtransactions: [{ category: 'category-1' }],
        },
      ],
    });
    rejects('transactions.update', {
      id: 'transaction-1',
      fields: { id: 'other-transaction' },
    });
    rejects('transactions.add', {
      accountId: 'account-1',
      transactions: [
        JSON.parse(
          '{"date":"2026-01-01","amount":1,"notes":{"__proto__":{"polluted":true}}}',
        ),
      ],
    });
    rejects('rule.add', {
      rule: {
        conditionsOp: 'and',
        conditions: [],
        actions: [{ op: 'set-server-url', value: 'https://attacker.invalid' }],
      },
    });
    rejects('preferences.save', { id: 'cloudFileId', value: 'other-budget' });
    for (const flags of [
      { rawMode: 'yes' },
      { withDead: 1 },
      { validateRefs: 0 },
      { calculation: true },
    ]) {
      rejects('aql.query', { query: { table: 'accounts', ...flags } });
    }
    rejects('aql.query', { query: { table: 'preferences' } });
    rejects('aql.query', {
      query: { table: 'accounts', tableOptions: { splits: 'grouped' } },
    });
  });

  it('keeps account-balance cutoff dates on the requested local calendar day', () => {
    const oldTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const cutoff = parseRemoteCalendarDate('2026-01-12');
      expect(cutoff.getFullYear()).toBe(2026);
      expect(cutoff.getMonth()).toBe(0);
      expect(cutoff.getDate()).toBe(12);
      expect(parseRemoteCalendarDate('0099-01-12').getFullYear()).toBe(99);
    } finally {
      if (oldTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = oldTimezone;
    }
  });

  it('parses a bounded request and rejects malformed or unsupported operations', () => {
    expect(
      parseRemoteV1Request({
        protocolVersion: 1,
        requestId: 'request-1',
        operation: 'transactions.list',
        payload: {
          accountId: 'account-1',
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        },
      }).operation,
    ).toBe('transactions.list');

    expect(() =>
      parseRemoteV1Request({
        protocolVersion: 2,
        requestId: 'request-1',
        operation: 'accounts.list',
        payload: {},
      }),
    ).toThrowError(RemoteProtocolError);
    expect(() =>
      parseRemoteV1Request({
        protocolVersion: 1,
        requestId: 'request-1',
        operation: 'arbitrary.handler',
        payload: {},
      }),
    ).toThrowError(/Unsupported operation/);
    expect(() =>
      parseRemoteV1Request({
        protocolVersion: 1,
        requestId: 'request-1',
        operation: 'transactions.list',
        payload: {
          accountId: 'account-1',
          query: 'SELECT * FROM transactions',
        },
      }),
    ).toThrowError(/Invalid payload/);
  });
});

describe('remote bootstrap contract', () => {
  it('allows an unencrypted backup into a new identity', () => {
    expect(() =>
      assertRemoteBootstrapInput({
        encrypted: false,
        destinationExists: false,
      }),
    ).not.toThrow();
  });

  it.each([
    [{ encrypted: true, destinationExists: false }, /Encrypted backups/],
    [{ encrypted: false, destinationExists: true }, /new budget identity/],
  ])('rejects invalid bootstrap input %#', (input, expected) => {
    expect(() => assertRemoteBootstrapInput(input)).toThrow(expected);
  });

  it('permits a remote backup only as a new identity', () => {
    expect(() =>
      assertRemoteBootstrapInput({
        sourceMode: 'remote',
        encrypted: false,
        destinationExists: false,
      }),
    ).not.toThrow();
  });

  it('only publishes after import and validation', () => {
    expect(() =>
      assertRemoteBootstrapTransition('draft', 'importing'),
    ).not.toThrow();
    expect(() => assertRemoteBootstrapTransition('draft', 'published')).toThrow(
      /Invalid remote bootstrap transition/,
    );
    expect(() =>
      assertRemoteBootstrapTransition('validating', 'published'),
    ).not.toThrow();
    expect(() =>
      assertRemoteBootstrapTransition('published', 'importing'),
    ).toThrow(/Invalid remote bootstrap transition/);
  });
});
