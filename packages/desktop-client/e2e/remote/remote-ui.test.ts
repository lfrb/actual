import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openDemo(page: Page) {
  await page.goto('/');
  await page
    .getByPlaceholder('Password', { exact: true })
    .fill('remote-ui-demo');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('Remote UI demo', { exact: true }).click();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Fruiterie Vert Pomme', { exact: true }),
  ).toBeVisible();
}

test('reads existing screens without downloads or writes, refreshes external changes, and edits a note on demand', async ({
  page,
  request,
}) => {
  const downloads: string[] = [];
  const mutations: string[] = [];
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  page.on('request', request => {
    if (request.url().includes('/download-user-file')) {
      downloads.push(request.url());
    }
    if (request.url().endsWith('/rpc')) {
      const operation = request.postDataJSON()?.operation;
      if (
        operation &&
        (!operation.startsWith('ui.') ||
          operation === 'ui.transaction-note.update') &&
        operation !== 'preferences.get'
      ) {
        mutations.push(operation);
      }
    }
  });
  await openDemo(page);
  await expect(
    page.getByRole('button', { name: 'Add New', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Import', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Reconcile', exact: true }),
  ).toHaveCount(0);
  await page.getByText('Fruiterie Vert Pomme', { exact: true }).dblclick();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.evaluate(() => window.Actual.setTheme('light'));
  await page.screenshot({
    path: 'test-results/remote-ui-light.png',
    animations: 'disabled',
  });
  await page.evaluate(() => window.Actual.setTheme('dark'));
  await page.screenshot({
    path: 'test-results/remote-ui-dark.png',
    animations: 'disabled',
  });
  await page.getByRole('link', { name: /Savings/ }).click();
  await expect(page.getByText('Interest', { exact: true })).toBeVisible();

  // Another client writes to the shared worker. This browser only reads.
  const login = await request.post('/account/login', {
    data: { password: 'remote-ui-demo' },
  });
  const {
    data: { token },
  } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const listing = await request.get('/sync/list-user-files', { headers });
  const { data: files } = await listing.json();
  const budgetId = files.find(
    (file: { name: string }) => file.name === 'Remote UI demo',
  ).fileId;
  const opened = await request.post('/remote/session/open', {
    headers,
    data: { protocolVersion: 1, budgetId },
  });
  const { sessionId } = await opened.json();
  const rpc = async (operation: string, payload: object) => {
    const response = await request.post(
      `/remote/${budgetId}/${sessionId}/rpc`,
      {
        headers,
        data: {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation,
          payload,
        },
      },
    );
    expect(response.ok()).toBe(true);
    return (await response.json()).result;
  };
  const accounts = await rpc('accounts.list', {});
  const savings = accounts.find(
    (account: { name: string }) => account.name === 'Savings',
  );
  await rpc('transactions.add', {
    accountId: savings.id,
    transactions: [
      { date: '2026-01-14', amount: 500, payee_name: 'External update' },
    ],
  });
  await expect(page.getByText('External update', { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('External update', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Savings 5,017.50/ }),
  ).toBeVisible();
  await request.post(`/remote/session/${budgetId}/${sessionId}/close`, {
    headers,
  });
  expect(downloads).toEqual([]);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Enable note editing' }).click();
  await expect(page.getByText('Notes editable', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: /Edit transaction note: Weekly groceries/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Transaction note' });
  await dialog
    .getByRole('textbox', { name: 'Transaction note' })
    .fill('Paid for weekly groceries');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Edit transaction note: Paid for weekly groceries',
    }),
  ).toBeVisible();
  expect(mutations).toEqual(['ui.transaction-note.update']);
  await page.getByRole('button', { name: 'Switch to read-only' }).click();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Paid for weekly groceries', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByText('Read-only server budget', { exact: true }),
  ).toBeVisible();
});

test('handles revocation and still lets the user close the budget', async ({
  page,
  request,
}) => {
  let authorization = '';
  page.on('request', req => {
    if (req.url().endsWith('/rpc')) authorization = req.headers().authorization;
  });
  await openDemo(page);
  expect(authorization).toMatch(/^Bearer /);
  const logout = await request.post('/account/logout', {
    data: { token: authorization.slice('Bearer '.length) },
  });
  expect(logout.ok()).toBe(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Access to this budget ended',
  );
  await expect(page.getByTestId('transaction-table')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Accounts' })).toHaveCount(
    0,
  );
  await page.screenshot({ path: 'test-results/remote-ui-revoked.png' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
});

test('explains the desktop-width requirement and can switch to local mode', async ({
  page,
}) => {
  await openDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText(
      'Open this budget in a wider window to view accounts and transactions.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Close', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/remote-ui-narrow.png' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByText('Read-only server budget', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Create new file', exact: true })
    .click();
  await expect(page.getByTestId('budget-table')).toBeVisible();
  await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
});
