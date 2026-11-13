import { describe, expect, it } from 'vitest';

import {
  assertRemoteBootstrapInput,
  assertRemoteBootstrapTransition,
  parseRemoteV1Request,
  REMOTE_CAPABILITIES,
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
