import { randomUUID } from 'node:crypto';

import { bootstrap, getAccountDb } from '../src/account-db';
import { run as runServer } from '../src/app';
import { config } from '../src/load-config';
import { run as runMigrations } from '../src/migrations';
import {
  provisionEmptyRemoteBudget,
  remoteWorkerManager,
} from '../src/remote-mode';

await runMigrations();
const login = await bootstrap({ password: 'remote-ui-demo' });
if (!login?.token) throw new Error('Demo bootstrap failed');
const owner = getAccountDb().first(
  'SELECT user_id FROM sessions WHERE token = ?',
  [login.token],
);
const budget = await provisionEmptyRemoteBudget(
  owner.user_id,
  'Remote UI demo',
);
const session = await remoteWorkerManager.openSession(
  budget.id,
  budget.id,
  owner.user_id,
  'demo-seed',
);
const write = <T>(operation: string, payload: unknown) =>
  remoteWorkerManager.dispatch<T>(
    budget.id,
    session.id,
    () => true,
    operation,
    payload,
    true,
    randomUUID(),
  );
const checking = await write<string>('account.create', {
  account: { name: 'Checking', offbudget: false },
  initialBalance: 250000,
});
const savings = await write<string>('account.create', {
  account: { name: 'Savings', offbudget: false },
  initialBalance: 500000,
});
await write('transactions.add', {
  accountId: checking,
  transactions: [
    {
      date: '2026-01-12',
      amount: -4250,
      payee_name: 'Fruiterie Vert Pomme',
      notes: 'Weekly groceries #household',
    },
    {
      date: '2026-01-13',
      amount: -7500,
      payee_name: 'Shared expense',
      subtransactions: [
        { amount: -5000, notes: 'My share' },
        { amount: -2500, notes: 'Reimbursement' },
      ],
    },
  ],
});
await write('transactions.add', {
  accountId: savings,
  transactions: [{ date: '2026-01-11', amount: 1250, payee_name: 'Interest' }],
});
await remoteWorkerManager.closeSession(budget.id, session.id);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void remoteWorkerManager.closeAll().finally(() => {
      getAccountDb().close();
      process.exit(0);
    });
  });
}
await runServer();
console.log(
  `Remote UI demo: http://127.0.0.1:${config.get('port')} — password: remote-ui-demo`,
);
