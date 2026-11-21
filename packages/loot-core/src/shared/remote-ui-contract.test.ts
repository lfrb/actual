import { describe, expect, it } from 'vitest';

import { q } from './query';
import { parseRemoteV1Request } from './remote-v1-contract';

function request(operation: string, payload: object) {
  return parseRemoteV1Request({
    protocolVersion: 1,
    requestId: 'ui-read',
    operation,
    payload,
  });
}

describe('bounded existing-UI read contract', () => {
  it('permits balance/count calculations and joined account reads only through UI queries', () => {
    const query = q('transactions')
      .filter({ 'account.closed': false })
      .calculate({ $sum: '$amount' })
      .serialize();
    expect(request('ui.query', { query }).payload.query).toMatchObject({
      calculation: true,
      selectExpressions: [{ result: { $sum: '$amount' } }],
      limit: 1000,
    });
    expect(() => request('aql.query', { query })).toThrow();
    expect(
      request('ui.query', {
        query: q('transactions').calculate({ $count: '*' }).serialize(),
      }),
    ).toBeTruthy();
  });

  it('keeps arbitrary handlers, SQL internals, unsafe calculations, and raw results inaccessible', () => {
    for (const query of [
      {
        ...q('transactions').serialize(),
        calculation: { $execute: 'DELETE FROM transactions' },
      },
      { ...q('transactions').serialize(), rawMode: true },
      { ...q('transactions').serialize(), withDead: true },
      { ...q('transactions').serialize(), table: 'remote_operations' },
      {
        ...q('transactions').serialize(),
        filterExpressions: [{ amount: { $transform: '$eval', $eq: 1 } }],
      },
    ]) {
      expect(() => request('ui.query', { query })).toThrow();
    }
    expect(() => request('ui.handler', { name: 'delete-budget' })).toThrow();
    expect(() =>
      request('ui.cell', { sheetName: '../../private', name: 'balance' }),
    ).toThrow();
  });
});
