import { q } from '@actual-app/core/shared/query';
import { beforeEach, expect, it, vi } from 'vitest';

import { aqlQuery } from './aqlQuery';
import { RegisterQuery } from './registerQuery';

vi.mock('./aqlQuery', () => ({ aqlQuery: vi.fn() }));
vi.mock('@actual-app/core/platform/client/connection', () => ({
  listen: () => vi.fn(),
}));

const requestedOffsets: number[] = [];
const mockRows = Array.from({ length: 2400 }, (_, index) => ({
  id: String(index),
  subtransactions: [],
}));
let rows = mockRows;

beforeEach(() => {
  requestedOffsets.length = 0;
  rows = mockRows;
  vi.mocked(aqlQuery).mockImplementation(async query => {
    const { offset, limit } = query.serialize();
    if (offset != null) requestedOffsets.push(offset);
    return {
      data: limit ? rows.slice(offset ?? 0, (offset ?? 0) + limit) : rows,
      dependencies: ['transactions'],
    };
  });
});

it('loads the page containing a jump and evicts old transaction payloads', async () => {
  const register = new RegisterQuery(q('transactions').select('*'), vi.fn());
  await register.run();
  expect(register.rows).toHaveLength(2400);
  register.requestRange([2399]);
  await vi.waitFor(() => expect(register.data.at(-1)?.id).toBe('2399'));
  expect(requestedOffsets).toEqual([0, 2250]);

  for (let offset = 150; offset <= 1650; offset += 150) {
    register.requestRange([offset]);
    await vi.waitFor(() =>
      expect(register.data.some(row => row.id === String(offset + 149))).toBe(
        true,
      ),
    );
  }
  expect(register.data.length).toBeLessThanOrEqual(1500);
  expect(register.data.some(row => row.id === '0')).toBe(false);

  register.requestRange([0]);
  await vi.waitFor(() => expect(register.data[0]?.id).toBe('0'));
  expect(requestedOffsets.at(-1)).toBe(0);
  register.unsubscribe();
});

it('replaces cached pages on a query refresh after a change in ordering', async () => {
  const register = new RegisterQuery(q('transactions').select('*'), vi.fn());
  await register.run();
  register.requestRange([1650]);
  await vi.waitFor(() => expect(register.data.at(-1)?.id).toBe('1799'));
  rows = [...mockRows].reverse();

  await register.run();
  expect(register.rows[1650].id).toBe('749');
  expect(register.data[0].id).toBe('749');
  expect(register.data).toHaveLength(150);
  register.unsubscribe();
});
