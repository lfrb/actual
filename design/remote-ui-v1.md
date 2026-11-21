# Remote web UI: read-only first milestone

Webhook delivery (implementation step 7) is deferred. The durable creation outbox
remains in place. The next milestone is opening a server-owned budget in the
existing web account and transaction screens, read-only. It is not a new viewer
or a copy of the budget into browser storage.

## Boundaries found

- `platform/client/connection/index.ts` is the UI's typed `send`/`listen` bridge
  to the browser worker. The SDK's separate dispatcher is not used by the UI.
- `platform/server/connection/index.ts` dispatches browser-worker messages to
  engine handlers. This is the place to select local execution or an explicit
  remote UI adapter while keeping authentication in the worker.
- `budgetfiles/budgetfilesSlice.ts` and `BudgetFileSelection.tsx` currently
  download every cloud-only file. Server-owned files need a separate open path,
  keyed by `operationMode`, without calling download or load-local-budget.
- `queries/aqlQuery.ts` and `queries/liveQuery.ts` rely on engine query results
  and `sync` invalidations. Account balances additionally use spreadsheet
  bindings. Simply replacing SDK calls will not make these screens work.
- `Account.tsx`, `TransactionList.tsx`, and the sidebar currently expose mutations
  and assume local calls rarely fail. Read-only must be explicit in the UI and
  enforced at the remote session/adapter boundary.

## Implementation order

1. Add a read-only remote UI session and a bounded allowlist of UI reads. Reuse
   normal server-session authentication, ownership checks, queue limits, and the
   existing hosted worker. Do not expose arbitrary handlers or raw SQLite.
2. Route server-owned budget selection to that session. Keep browser preferences
   local and budget metadata ephemeral; never create a local budget database or
   upload/download/sync a remote budget through conventional file routes.
3. Adapt existing account/transaction queries, categories/payees, and spreadsheet
   balance reads, preserving the UI's current result shapes and pagination.
4. Render the existing account/transaction screens with mutations unavailable.
   Hide unsupported navigation/actions and reject writes even if invoked through
   a shortcut or a stale component. No server-global undo.
5. Provide explicit refresh, loading, connection errors, and session cleanup.
   Refresh invalidates existing query/balance caches. Live cross-client polling
   or subscriptions can follow after this read-only milestone.
6. Verify against a synthetic hosted budget: open, browse accounts, page through
   transactions and splits, display balances, refresh after another client's
   write, revoke access, close/reopen, and switch back to a conventional budget.
   Keep local/synced modes operational. Run repository checks and browser tests.

Editing, imports, the budget worksheet, reports, schedules, mobile/Electron remote
support, offline operation queues, and webhook delivery are outside this first
read-only milestone. The server remains the authoritative budget store; browser
query caches are transient display state.
