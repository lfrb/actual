# Remote budget operation: functional specification and implementation plan

Status: proposed implementation contract; no remote-mode implementation yet.

Inspected base: `81804f03fadab5fd64c54f264fadd19754d2e5ad` on
`ai/oauth2-authorization-v1`. Branch: `remote-v1`.
This base includes the fork's OAuth authorization work. Authentication references
below must be reconciled with upstream if that work has not landed.

## Outcome and scope

Allow an SDK client to query and modify a budget hosted by Actual without loading
a client-side budget database. Preserve existing SDK behavior by default. Keep
conventional local/synced budgets operational on the same installation, with a
server-enforced mode per budget. Do not support both modes for the same budget.

The PoC includes owner-authorized SDK access, persistent server budgets, queries,
transaction creation/editing/import, and HTTP notifications for newly created
transactions. The initial implementation excluded the Actual UI; the follow-up
[read-only web UI milestone](remote-ui-v1.md) now adapts the existing account and
transaction screens. Multiple sessions and integrations
of one owner are allowed; sharing a remote budget between different users is not.
End-to-end encrypted budgets cannot use remote mode. Session-local undo is the
future contract; remote undo/redo is explicitly unsupported in the PoC.

Remote operation means the client receives query results, not a SQLite replica.
It cannot prevent an authorized client from saving results it has already received.
Revocation prevents future service access; it cannot erase previously returned data.

## Verified boundaries in the current code

Paths below are relative to the repository root. Function names are the durable
anchors; line numbers will change during implementation.

| Boundary                  | Current implementation                                                                                                                   | Consequence                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK initialization        | `packages/api/index.ts`, `init`, `shutdown`                                                                                              | Imports and initializes the local engine; shutdown attempts sync and closes the budget. Remote mode needs a separate initialization/lifecycle path.                                                               |
| SDK request dispatch      | `packages/api/methods.ts`; `packages/loot-core/src/platform/client/connection/index.api.ts`, `send`                                      | Methods send named requests; Node transport directly calls `lib.send`. This is a useful transport seam, but changing only UI dispatch will not change the SDK.                                                    |
| Engine dispatch           | `packages/loot-core/src/server/main.ts`, `lib.send`; `server/mutators.ts`, `runHandler`, `runMutator`                                    | Mutations are queued sequentially with process-global context. Serialization does not make an entire command a SQLite transaction.                                                                                |
| Queries                   | `packages/desktop-client/src/queries/aqlQuery.ts`; `packages/loot-core/src/server/aql/index.ts`, `aqlQuery`                              | UI sends serialized AQL; engine compiles and executes it. Transport serialized query data, never executable code or raw SQL.                                                                                      |
| Transaction commands      | `packages/loot-core/src/server/transactions/app.ts`; `server/api.ts`                                                                     | UI batch operations and SDK API handlers reach shared transaction logic. Preserve those domain handlers.                                                                                                          |
| Transaction processing    | `packages/loot-core/src/server/transactions/index.ts`, `batchUpdateTransactions`                                                         | Initial writes and transfer post-processing use separate `batchMessages` calls; learning rules can add work. One logical command can commit multiple batches.                                                     |
| Database writes           | `packages/loot-core/src/server/db/index.ts`, `insertTransaction`, `updateTransaction`, `insertWithSchema`, `updateWithSchema`, `delete_` | Ordinary domain writes produce messages through `sendMessages`. Do not substitute arbitrary SQL writes for domain operations.                                                                                     |
| Batching                  | `packages/loot-core/src/server/sync/index.ts`, `batchMessages`, `_sendMessages`                                                          | Batching accumulates messages, then applies them and schedules network sync. It is not a general async SQLite transaction wrapper.                                                                                |
| Actual commit boundary    | Same file, `_applyMessages`, `applyInTransaction`                                                                                        | Affected rows are read before/after inside a synchronous SQLite transaction, together with writes and enabled CRDT bookkeeping. This is the candidate atomic outbox boundary.                                     |
| Post-commit effects       | Same file, after `db.transaction(...)`                                                                                                   | Undo history, spreadsheet invalidation, listeners, and `app.events.emit('sync', {type: 'applied', ...})` happen after commit. They can fail after data has committed. A rejected command does not prove rollback. |
| Special import path       | Same file, `applyMessagesForImport`                                                                                                      | Syncing mode `import` bypasses the normal before/after snapshots and listeners. Whole-budget import must be treated separately from transaction import.                                                           |
| Network scheduling        | Same file, `scheduleFullSync`; `server/budgetfiles/app.ts`, `_loadBudget`, `syncBudget`                                                  | Ordinary writes schedule sync; budget loading chooses sync mode based on `getServer()` and calls `cloudStorage.possiblyUpload()`. Remote hosting needs explicit lifecycle policy.                                 |
| Engine-to-client events   | `packages/loot-core/src/platform/server/connection/index.api.ts`                                                                         | Node SDK transport discards most events, logging only selected sync warnings. A remote event adapter is required for future live UI support.                                                                      |
| Undo                      | `packages/loot-core/src/server/undo.ts`, `MESSAGE_HISTORY`, `CURSOR`; `server/mutators.ts`, `currentContext`                             | History/context are process-global. An undo tag is not an authorization or session-isolation boundary. Do not expose existing undo to shared workers.                                                             |
| Existing server file APIs | `packages/sync-server/src/app-sync.ts`                                                                                                   | Sync, upload, download, reset, encryption-key, listing, and deletion routes require mode-aware handling. Blocking only `/sync` is insufficient.                                                                   |

### Verified transaction import and direct-add paths

SDK `importTransactions` sends `api/transactions-import` in `server/api.ts`, which
calls `transactions-import` in `server/accounts/app.ts`. That handler invokes
`reconcileTransactions` in `server/accounts/sync.ts`. Reconciliation separates added
and updated rows; outside preview mode it creates new payees and calls
`batchUpdateTransactions({ added, updated })`. This reaches normal message application,
not the special whole-budget import mode. Preview must produce no notifications.

SDK `addTransactions` defaults both transfer processing and category learning to
false. The corresponding add path in `server/accounts/sync.ts` can bypass
`batchUpdateTransactions`, calling `batchMessages` and `db.insertTransaction`
directly. Therefore a hook only in `batchUpdateTransactions` would miss a normal
SDK creation path. Both paths converge at normal `_applyMessages` commits.

### Commit events versus finished operations

Use `_applyMessages` to record durable changes in the same transaction as the
budget writes. Use the outer command boundary to establish when the logical
operation has finished. Neither alone is sufficient:

- A post-commit in-memory listener can lose events if the process dies.
- A transaction-create endpoint misses other creation paths.
- An event from the first commit may precede creation of a transfer counterpart.
- A command can fail after an earlier batch committed; do not report that nothing
  happened or blindly replay the command.

For the PoC retain the existing financial mutation behavior. Do not attempt to
wrap arbitrary async engine operations in the synchronous SQLite transaction
helper. Introduce an operation journal and commit-level outbox, described below.

## Architecture and ownership

Host the authenticated remote routes in `packages/sync-server`. Run the engine in
an isolated child process per active remote budget, launched with the Node platform
build. The server owns routing, authorization, worker lifecycle, and webhook
configuration. Workers own loaded budget state and SQLite access.

Use one server instance for v1. Enforce a single worker per budget, including
concurrent opens, and a process/filesystem lock so a second server process cannot
open the same working database. Do not describe this as horizontal-scale support.

The worker manager uses server-resolved paths under a dedicated remote-budget
storage directory. Requests contain opaque budget IDs, never filesystem paths.
Keep the server's file/catalog identity distinct from engine-local directory IDs
and conventional sync group IDs. Store explicit mappings.

Keep owner and mode in server metadata, outside client-editable budget preferences.
New records default to the existing synced mode for backward compatibility. Remote
creation is explicit. No in-place conversion of a live synced budget in v1: import
an unencrypted backup as a new remote budget with a new identity, or create an empty
one. Existing disconnected replicas cannot be remotely erased.

An administrative bootstrap import may run without webhooks while the budget is
unpublished. Strip inherited cloud identity and encryption metadata; never allow
bootstrap to upload to the source budget. Publish only after validation succeeds.
Whole-budget bootstrap is not a transaction import notification. Reject encrypted
archives with an actionable error rather than trying to bypass their encryption.

## SDK and wire contract

Illustrative API, to finalize before implementation:

```ts
await actual.init({ mode: 'remote', serverURL, token });
await actual.openBudget(budgetId);
await actual.getTransactions(accountId, startDate, endDate);
await actual.importTransactions(accountId, transactions);
await actual.shutdown();
```

Default initialization remains local. Remote initialization must not initialize
SQLite, create a data directory, download a budget, or initialize local sync. Avoid
a static engine dependency in the remote entry path; preserve platform exports and
verify the published package build, not only TypeScript source execution.

Use authenticated HTTPS JSON requests for v1; live subscriptions/WebSocket are a
later extension. Opening returns a server-side session handle bound to the owner,
budget, credential, and protocol version. A handle never replaces authentication.
Shutdown releases this client's session; it does not close a worker used by others.
Bound request sizes, query result sizes, command concurrency, and queued work.

Allowlist reads for accounts, categories/groups, payees, tags, rules, budget months,
preferences, and serialized AQL. Allowlist financial writes needed for creating and
editing those objects and transaction add/update/delete/import. Keep file lifecycle,
server URL changes, sync, encryption, arbitrary handlers, and raw database internals
outside the financial RPC registry. Specify individual operation schemas and error
codes. Existing IDs, integer amount units, and public return shapes should match
local mode. Reject unsupported methods explicitly.

Client-side callback helpers such as `runImport` and `batchBudgetUpdates` cannot
be serialized across HTTP. Do not forward a function or keep a global batch open
across independent network requests. Mark them unsupported initially; a future
explicit bulk command may supply equivalent semantics.

`downloadBudget`, `loadBudget` with a local ID, `sync`, and `internal` need documented
mode-specific errors. Do not silently repurpose them. The SDK switch preserves
normal financial operations, not access to a local database that no longer exists.

Reuse the fork's validated budget credential/authentication plumbing where
appropriate, enforcing owner, budget, and read/write scope on every request. An
authenticated owner cannot access another budget by substituting an ID. Catalog
operations need separate authorization from a budget-scoped token. Credential
revocation must affect existing sessions and queued requests before execution.
Never expose the engine's complete `Handlers` registry over the network.

## Persistence, retries, and webhook delivery

### Operation journal

Assign each write a client-generated request ID; persist it scoped to credential
identity and budget with a canonical command/payload hash. Reject reuse with a
different payload. Store operation states such as running, succeeded, and interrupted,
plus a bounded persisted result or status reference. A retry returns the stored
result/status rather than invoking the mutation again. Publish retention/expiry
semantics; an expired key must not silently imply indefinite deduplication.

Pass operation context into every commit. Atomically associate outbox rows with
that operation. If the process dies mid-command, mark it interrupted on recovery;
return an explicit indeterminate/partial-result status and expose committed IDs.
Do not automatically replay interrupted operations. A durable operation status is
required even if subsequent in-memory recalculation fails after a commit.

### Creation detection

Inside the normal commit transaction, compare old/new transaction rows and record
new logical transaction IDs. Emit for newly materialized, live top-level transactions;
exclude tombstones and split children. Splits report their parent. Restoration of
an existing tombstoned row is not a creation. Updates, categorization, matching
existing transactions during import, and no-op reimports do not emit creations.

Treat a transfer pair as one logical creation, containing both transaction IDs;
canonicalize the pair deterministically. Since counterpart creation can be a later
commit, persist candidates at commit time and finalize/coalesce at operation
completion. An import may produce multiple commit events internally but a bounded
notification batch after completion. Never promise one HTTP delivery per input row.

Interrupted operations still have real committed changes. Recovery must finalize
and deliver their recorded candidates with an `operationStatus: interrupted` marker,
including unmatched transfer sides if necessary. Fetch current rows before finalizing,
and exclude candidates created then removed in the same operation. Establish how
rule-created replacements/merges are represented with tests against real engine
behavior. Fail closed on an unknown transaction shape rather than guessing a parent.

Whole-budget `import` mode bypasses normal listeners. Bootstrap deliberately suppresses
events. Transaction import through the SDK must exercise the normal persistence path;
trace and test the actual import/reconciliation handler rather than assuming its name
implies the special whole-budget mode. Any background schedules enabled in remote
mode must receive their own operation context; disable automatic background producers
in v1 until their lifecycle and attribution have been verified.

### Outbox

Store event candidates and delivery state in non-synced tables in the working budget
SQLite database, inserted atomically with budget changes. Never put durable outbox
inserts only in `sync: applied` listeners. Keep HTTP sends outside all SQLite
transactions. Introduce schema management for server-only tables without making
legacy budgets depend on them. Outbox failure must fail the corresponding commit.

The dispatcher can drain a worker's outbox through its internal IPC; do not open a
second unmanaged SQLite writer. Pending deliveries keep that worker active or cause
the manager to reopen it. Persist enough catalog scheduling metadata to discover
pending work after a server restart. Delivery attempt timestamps, retry times, and
acknowledgments survive restart. Bound retention and define an exhausted/dead-letter
state with an administrator retry mechanism.

### Webhook configuration and contract

One administrator-configured webhook per remote budget is enough for v1. Configure
URL, signing-secret reference, timeout, retry limit, and enabled state. No per-user
setup UI. Permit explicitly configured local/private destinations for installations
like Octo; configuration must not be writable by ordinary RPC callers. Disable
redirect following and require explicit opt-in for development HTTP URLs.

Example payload:

```json
{
  "version": 1,
  "eventId": "stable-delivery-id",
  "type": "transactions.created",
  "budgetId": "opaque-budget-id",
  "operationId": "request-id",
  "operationStatus": "succeeded",
  "occurredAt": "2026-11-13T15:00:00Z",
  "transactionIds": ["transaction-id"]
}
```

Use JSON POST, acknowledge only 2xx, sign timestamp plus exact body bytes with
HMAC-SHA256, and document header names and verification. Retry timeout/network/5xx
and rate-limit failures with bounded backoff; classify other 4xx as permanent.
Deliver at least once with a stable event ID and immutable payload on retries.
Recipients deduplicate. Do not promise strict delivery order. Event data contains
IDs rather than payees or amounts; authorized recipients query details with the SDK.
Deletion of a budget cancels delivery and removes its runtime state.

## Sync and lifecycle dependencies to change

1. `_loadBudget` currently enables sync based on a configured server, starts main
   services, and calls `possiblyUpload`. Add an explicit hosted-engine policy that
   suppresses remote sync/upload without skipping rules, spreadsheet, or mappings.
2. `_sendMessages` schedules full sync after local application. Separate local
   persistence/change processing from network replication policy. Keep existing
   `disabled`/`offline`/`import` meanings; do not use `import` as server mode because
   it bypasses projections and listeners. Validate disabled-mode persistence before
   selecting it; server operation mode is distinct from this internal syncing flag.
3. SDK shutdown currently tries sync, close, and possibly sign-out. Remote shutdown
   releases a session; actual worker shutdown drains mutators, closes SQLite, and
   preserves pending delivery state. Bound draining and report unfinished commands.
4. Audit startup services (including schedules and backups), focus handlers, cloud
   reset/upload/download, and sync migration listeners for implicit network work.
   Whitelist hosted services rather than inheriting browser lifecycle assumptions.
5. Guard legacy file routes using mode metadata: sync, full upload/replacement,
   download, reset, and encryption-key operations. Apply owner checks to listing,
   metadata, rename, and deletion. Do not block legitimate backup/export implemented
   through a dedicated authorized remote operation.
6. Server-owned SQLite plus metadata and outbox are the recoverable budget. Use a
   consistent SQLite snapshot/backup procedure including WAL handling. Restore
   identity deliberately; prevent replaying old webhook deliveries accidentally.

## Implementation sequence and acceptance gates

| Step | Work                                                                               | Required evidence                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Define protocol, capability matrix, mode metadata, migrations, bootstrap lifecycle | Existing budgets retain behavior; remote modes reject encrypted input and conventional replication routes.                                                                              |
| 2    | Refactor SDK dispatcher with local default and separate remote initialization      | Local SDK regression tests pass; remote package loads without initializing SQLite or reading/writing a budget cache.                                                                    |
| 3    | Add worker manager, hosted policy, ownership enforcement, session lifecycle        | Concurrent opens share one worker; different budgets are isolated; restart preserves data; revoked access stops working; shutdown of one session leaves others usable.                  |
| 4    | Add bounded AQL/read RPC and financial write allowlist                             | Synthetic local/remote parity for queries, categories, tags, rules, transactions, splits, and transfers; scoped credentials and malformed requests tested.                              |
| 5    | Add operation journal and interrupted-operation recovery                           | Lost response after success yields no duplicate write; payload mismatch rejected; crash between transfer batches returns explicit interrupted status, never blindly replays.            |
| 6    | Add commit candidate hook and durable outbox                                       | Rollback produces neither rows nor events; process death after commit retains events; match-only reimport produces no creation; transfer/split normalization tested.                    |
| 7    | Add webhook dispatcher and administration config                                   | Local recording receiver receives signed POST for creation and import; failed delivery retries after restart; duplicate delivery retains event ID; failures never undo committed data.  |
| 8    | Package and document disposable PoC                                                | Published SDK entry point works; standard local/synced regression suite passes; documented bootstrap, credentials, sample query/write/import, receiver, restart, and cleanup procedure. |

Step 7 is deferred by request. Work proceeds with the read-only web UI milestone
before webhook delivery or completion of the public remote SDK packaging.

Use synthetic/disposable budgets only during implementation. Cover additions through
SDK handlers and lower-level domain paths, not only mocked endpoint responses.
Exercise post-commit exceptions, disk-full/outbox failure, and worker termination
at the known multi-commit boundary. Test remote query execution after mutations to
verify spreadsheet and rule projections remain consistent with the database.

Run repository-required typecheck, formatting/lint, relevant core/API/server tests,
and actual built-package smoke checks. Record exact commands and outcomes. Keep
protocol, schema changes, tests, and documentation with each implementation commit.

## Deferred iterations

- UI editing, live event transport/reconnect, import/export file streaming, and
  network-latency audits. Initial read-only selection, manual refresh, and
  connection failure states are covered by the web UI milestone.
- Session-scoped undo/redo with conflict checks: never undo another session's edits;
  refuse/reconcile inversions if another session changed the affected fields.
- Safe conversion between synced and remote modes, explicit exports for leaving
  remote mode, and administrator tooling.
- More event types, user-facing webhook configuration, background schedules/bank
  imports, and multi-instance hosting.

## Decisions an implementer must not silently change

No multi-user budget sharing; no same-budget mixed remote/sync operation; no E2E
encryption in remote mode; no engine-global undo exposed remotely; no network retry
that can rerun an interrupted mutation; no callback-only webhook queue; no direct
access to sync-server snapshot files as if they were the working engine database.

The largest implementation risks are operation-level partial commits and engine
startup side effects. Resolve those with explicit contracts and crash tests before
claiming reliable notifications. A remote AQL endpoint alone is not this feature.
