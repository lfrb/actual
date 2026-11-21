# Remote budget v1 contracts

This document records the server-owned mode metadata, protocol/bootstrap shape,
worker/session lifecycle, bounded financial RPC, durable operation journal, and
transaction creation outbox.
SDK remote activation is not implemented here.

The web app can open existing remote budgets read-only using its normal server
login. It reuses the account registers and transaction table, with explicit
Refresh and Close actions. Choose **Enable limited editing** to edit existing
transaction notes or clear and unclear transactions. **Switch to read-only**
removes those controls. Reconciled transactions stay locked. Reopening a budget from the picker starts in read-only mode. Other edits,
reports, the budget worksheet, schedules,
mobile/Electron remote UI, and live cross-client updates are deferred. Browser
query results and view preferences are transient; no local budget database or
conventional file download is created for the remote budget.

To try this without touching an existing installation, run from the repository
root:

```sh
yarn workspace @actual-app/sync-server build
yarn workspace @actual-app/web generate:i18n
yarn workspace @actual-app/web build:browser
node packages/sync-server/test-support/launch-remote-ui.mjs
```

Open `http://127.0.0.1:21306`, sign in with `remote-ui-demo`, and choose
**Remote UI demo**. The launcher clears inherited `ACTUAL_*` configuration and
creates a fresh temporary data directory with synthetic accounts and transactions.
Stop it with Ctrl+C to remove that directory. An optional port argument changes
the listening port. The automated browser check uses the same fixture:

```sh
yarn workspace @actual-app/web exec playwright test -c playwright.remote.config.ts
```

## Protocol

The web UI opens sessions with optional `readOnly: true`; the server echoes the
flag and rejects every write operation for that session with
`read-only-session` (403). Omitting the flag preserves writable RPC sessions.
The browser opens limited editing sessions with `writeScope: "transaction-details"`.
These sessions permit `ui.transaction-note.update` and
`ui.transaction-cleared.update`. The older `transaction-notes` scope still
permits only note writes. The server rejects writes outside the selected scope
with `write-outside-scope` (403).

Clearing takes a transaction ID and a boolean. A split parent and its children
change in one batch. A reconciled transaction or a split child targeted directly
returns a refusal and leaves all rows unchanged. Each side of a transfer keeps
its own clearing status. The browser refreshes visible data after confirmation.
If the result is unknown, it asks the user to refresh before retrying.

The `ui.*` registry contains native account/category/payee/tag reads, bounded AQL,
notes, and spreadsheet cells. It does not accept arbitrary engine handler names.
Generated spreadsheet queries remain private to each browser session, rather
than replacing named queries inside the shared hosted worker.

Financial RPC uses HTTPS JSON and bearer authentication. Requests carry
`protocolVersion: 1`, a client-generated `requestId` (1 to 128 characters), an
operation from the static `REMOTE_OPERATION_REGISTRY`, and its operation-specific
payload. Responses echo the protocol version and request ID with either `result`
or a stable error code. A session is bound to `sessionId`, `budgetId`, `ownerId`,
credential identity, and protocol version; the session handle does not replace
bearer authentication. Authentication, ownership, current remote mode, enabled
user/key, key grant, and session binding are rechecked immediately before a
queued operation is sent to the worker.

## Hosted worker lifecycle

The server exposes session lifecycle and financial RPC routes:

| Route                                             | Request                                       | Result                                                            |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `POST /remote/session/open`                       | `{ "protocolVersion": 1, "budgetId": "..." }` | `201` with the protocol version, opaque session ID, and budget ID |
| `GET /remote/session/:budgetId/:sessionId`        | No body                                       | `200` while the authenticated session remains valid               |
| `POST /remote/session/:budgetId/:sessionId/close` | No body                                       | `204` after releasing that session                                |
| `POST /remote/:budgetId/:sessionId/rpc`           | Versioned operation envelope                  | Versioned result/error envelope                                   |
| `GET /remote/:budgetId/operations/:requestId`     | No body                                       | Credential-scoped durable operation status and saved result       |

All routes require the usual bearer/session token or a budget API key granted to
that budget. The server checks the credential, key grant, remote mode, and exact
catalog owner on every call. A server administrator does not gain engine access
unless that identity owns the budget. Sessions bind to both owner and credential;
revocation and disabled accounts stop later calls. The session ID is never an
authentication credential.

The server keeps runtime state in `remote_budget_runtime`. Engine directories
live under `userFiles/remote-budgets` and are addressed only by server-generated
IDs. Each active budget uses one isolated process running the built
`@actual-app/api/hosted-worker` entry. The server build compiles that entry before
building the sync server; it is not loaded from TypeScript source at runtime.
Workers use offline local-apply mode, preserving migrations, CRDT application,
spreadsheet state, and schedule mapping listeners while suppressing cloud sync,
uploads, backups, and automatic scheduled transaction production. A private
worker-only command creates a genuinely empty budget without the sample data used
by test fixtures.

No public budget-creation route is exposed. Disposable
integration setup can call the internal `provisionEmptyRemoteBudget(ownerId,
name)` helper, then open a session with a test credential. Provisioning remains
unlisted until the engine database is initialized and the worker has closed.
This helper is internal server code, not a user-facing admin endpoint or SDK
method. Runtime sessions are in memory and expire after 30 minutes of inactivity;
after a server restart, clients must authenticate again and open a new session.

Worker starts are serialized per budget and guarded by server-owned lock files;
the lock records both manager and child PIDs so a new server rejects a live
writer and can recover a confirmed-dead worker. Malformed locks fail closed.
The manager bounds each budget to 32 live sessions and the process to 128 active
workers. Idle sessions expire after 30 minutes. Startup and shutdown are bounded
to 20 seconds and 3 seconds graceful shutdown; if escalation is needed, the
manager allows up to another 3 seconds for `SIGKILL` exit. It only releases the
database lock after confirmed process exit. A manager restart starts a new
worker from the persisted directory mapping and existing SQLite file.
PID checks assume a shared host PID namespace and can be confused by PID reuse;
malformed lock metadata and abandoned guard files fail closed. Remove a stale
guard or lock only after stopping every server manager and confirming no worker
uses the database. This does not provide shared-filesystem or multi-instance
locking.

The typed registry and validators live in the pure shared module
`@actual-app/core/shared/remote-v1-contract`; the sync server and compiled worker
use that same operation set. The step 4 registry supports:

- Reads: accounts and account balance; account groups; categories and category
  groups; payees; tags; rules; budget months and one month; synced preferences;
  transactions by account/date range; and bounded serialized AQL queries.
- Writes: account and account-group create/edit/close/reopen; category and
  category-group create/edit/delete; payee and tag create/edit/delete; rule
  create/edit/delete; synced preference updates; month amount/carryover changes;
  and transaction add/update/delete/import through existing domain handlers.

Every operation has an explicit payload allowlist. Nested financial objects
reject unknown fields, prototype-pollution keys, invalid dates/IDs, unsafe
integers, and invalid field types. Transaction objects cannot set engine-owned
IDs, transfer links, tombstones, split-parent markers, schedules, or sync
internals. Split children are represented by the supported `subtransactions`
field and validated recursively. The worker maps symbolic operation names to
fixed engine handler names; caller-supplied handler names are never accepted.

Serialized AQL permits only transactions, accounts, account groups, categories,
category groups, payees, and rules. It bounds expressions and rows, validates
fields against each resource's public schema, forces `rawMode=false`,
`withDead=false`, `validateRefs=true`, and `calculation=false`, and replaces `*`
with a safe field projection. Raw database tables, preferences through AQL, SQL,
arbitrary AQL functions, regexp operators, and executable code are rejected.
Transaction lists issue grouped-split AQL with a SQL limit of 1,001 and reject
results above 1,000; the returned shape matches the SDK transaction API.

Limits are 1 MiB per JSON request, 500 transactions per add/import batch, 1,000
AQL rows, 1,000 rows in any returned array, 4 MiB per result, 32 active/queued
RPCs per worker, and 30 seconds per operation. JSON parsing is mounted before
the server's larger upload parser; oversized and malformed JSON receive bounded
JSON errors. Results exceeding row, node, depth, or byte limits fail closed.
AQL and transaction queries have a SQL row limit. Other domain reads are checked
for at most 1,000 array entries and the response byte/node limit before IPC
serialization, after their engine handler returns. These response checks do not
preflight every existing resource handler. The 30-second timeout kills and
quarantines a worker that cannot complete. The budget database itself remains
loaded in worker memory.

RPCs are serialized in each worker. If a read times out, the worker is stopped
and the response is `operation-timeout`. A write timeout or lost worker response
returns `operation-indeterminate`; clients must query its durable status before
deciding what to do next. Caught handler errors and response-size failures use
the journal to distinguish a failed command from an interrupted command with
committed changes. Requests rejected before dispatch return
`operation-not-dispatched`.

Every write RPC is journaled in a server-only `remote_operations` table in that
budget's SQLite database. The client `requestId` remains stable across retries
and is separate from the worker IPC correlation ID. The payload hash covers the
validated operation and canonical payload; the key is scoped to the budget and
credential. Repeating the same key and payload returns the saved result or
terminal status. Reusing the key with a different payload returns
`request-id-conflict`. A status lookup requires current owner access and the same
credential, and returns `operation-not-found` for an unknown key. Read RPCs do
not create journal rows. The budget owner can inspect an operation only through
the credential that issued it; each lookup rechecks current access and status
reads count toward worker session and queue limits.

Writes begin as `running`. The commit count and affected dataset/row identifiers
are updated inside the same SQLite transaction as the financial messages.
After the engine handler returns, the bounded result is saved as `succeeded`.
On worker startup, any leftover `running` rows become `interrupted`; the budget
lock ensures no prior worker can still be executing. A caught error before any
financial commit is saved as `failed`; an error after one or more commits is
saved as `interrupted`. Neither state is automatically replayed. Results are
bounded to the RPC result limit; request ID/hash/status records are
retained so an old request ID is never silently reused. Responses up to 64 KiB
are retained, with at most the latest 16 per budget; older bodies are cleared.
Larger results are marked expired when success is recorded, before the original
response is sent. Status returns `resultExpired: true`, and retrying an expired
response returns `operation-result-expired` without rerunning the mutation.

`operation-indeterminate` reports a worker timeout or lost worker response after
dispatch, where a commit may or may not have happened; clients must query status
and must not retry automatically. `operation-interrupted` reports that durable
commit evidence exists or startup recovered a still-running journal row. It
also never triggers a retry.

## Transaction creation outbox

Creation candidates are recorded in `remote_event_candidates` inside the same
SQLite transaction as financial writes and journal commit evidence. Candidate
storage failure rolls back that financial commit. Bootstrap emits no events;
after bootstrap, hosted writes without an operation context are rejected.
Conventional local and synced budgets do not initialize these tables.

At operation completion, the worker rereads live rows and atomically stores
immutable `transactions.created` payloads in `remote_outbox` with the journal's
terminal status. Startup recovery does the same for interrupted operations. If
final event storage fails, the terminal state is not committed; candidates remain
available for recovery. Unknown transaction shapes fail closed rather than
discarding candidates. A caught postcommit exception quarantines the worker so
subsequent requests use a newly loaded engine.

Updates, restoration of an existing tombstoned row, matching import replays, old
or deferred messages, and rows created then removed within the operation emit
no creation. A rule-created split emits its parent; a rule-deleted row emits
nothing. When merging, only a surviving newly created root can emit an event.

Payloads contain newly created logical root IDs. Split children normalize to
their parent. Transfer-linked new roots share an event: a simple new transfer
has two IDs; a new split with multiple transfer legs can have its parent plus
several counterpart IDs. A preexisting linked root is not announced as new.
Missing or nonreciprocal transfer legs appear in `unpairedTransferIds`, using
the logical root ID even when the incomplete leg is a split child. This marker
describes the committed relationship, including when the caller disabled
automatic transfer creation.

```json
{
  "version": 1,
  "eventId": "evt_<sha256>",
  "type": "transactions.created",
  "budgetId": "opaque-budget-id",
  "operationId": "client-request-id",
  "operationStatus": "interrupted",
  "occurredAt": "2026-11-14T20:00:00.000Z",
  "transactionIds": ["committed-source-id"],
  "unpairedTransferIds": ["committed-source-id"]
}
```

Event IDs include the budget, credential identity, request ID, and sorted logical
root IDs. They remain stable across retries and restarts; consumers deduplicate
by `eventId`. Payloads remain unchanged after later edits or deletion of their
transactions. They contain IDs rather than transaction amounts or payees.

The tables are server-only and excluded from CRDT sync. Each outbox record starts
as `pending` with zero attempts and nullable retry, last-attempt, and delivery
timestamps. Internal worker IPC can inspect up to 100 records in a page bounded
to 3 MiB; each event payload is limited to 256 KiB. There is no public outbox RPC,
delivery scheduler, acknowledgment handler, or event purge in this step. HTTP
delivery, retries, retention, and webhook configuration are deferred to Step 7.

## Errors

Errors use stable codes: `unsupported-protocol-version`, `unsupported-operation`,
`invalid-request`, `unauthorized`, `forbidden`, `budget-not-found`,
`operation-mode-mismatch`, `operation-in-progress`, `operation-result-expired`,
`operation-interrupted`, `operation-indeterminate`, `operation-timeout`,
`operation-not-dispatched`, `request-id-conflict`, `request-too-large`, `result-too-large`,
`queue-full`, and `operation-failed`.

## Capability matrix

| Area            | v1 capability in this step                                                                       | Excluded                                               |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Reads           | Accounts, categories/groups, payees, tags, rules, budget months, preferences, serialized AQL     | Raw SQL/database internals                             |
| Writes          | Allowlisted financial object edits, month amount/carryover, transaction add/update/delete/import | File lifecycle, sync, encryption, server URL changes   |
| Session         | Open and release an owner/budget/protocol-bound session                                          | Session handle as authentication, shared budgets       |
| Local callbacks | None                                                                                             | Callback serialization, remote batch spanning requests |
| Undo            | None                                                                                             | Engine-global undo/redo                                |

Only operations in the registry are reachable. More engine or SDK operations
remain unsupported until they receive an explicit schema and built-worker test.

## Mode metadata and lifecycle

`files.operation_mode` is server-owned and constrained to `synced` or `remote`.
Migration default is `synced`, preserving every existing budget. The mode is
read into `File`, exposed in file list/info metadata, and cannot be changed by
`FilesService.update`. Remote records cannot carry encryption metadata. Remote
budgets are owner-only; server administrators retain catalog administration.
Sharing grants do not reveal remote budgets to other users. Owner rename and
server-admin catalog operations remain allowed.

Bootstrap accepts only an unencrypted backup and a new destination identity.
Encrypted input must be decrypted and re-exported first. An existing synced
budget cannot be converted in place, and bootstrap must strip inherited cloud
identity/encryption metadata before the destination is published. Lifecycle
states are `draft -> importing -> validating -> published`, with failure
transitions from each unpublished state. The destination remains unpublished
until validation succeeds. Empty-budget worker provisioning is implemented as
an internal helper; backup bootstrap remains a later step.

## Legacy route behavior

After authentication and file access checks, remote budgets reject conventional
sync, full upload/replacement, download, reset, encryption-key, and deletion
routes with HTTP 409 `{ "status": "error", "reason": "remote-budget" }`.
The check occurs after authorization so unauthorized callers cannot infer mode.
The `synced` default keeps these routes unchanged for existing budgets.
