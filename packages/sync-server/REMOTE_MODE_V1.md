# Remote budget v1 contracts

This document records the server-owned mode metadata, protocol/bootstrap shape,
worker/session lifecycle, and bounded step 4 financial RPC. SDK remote activation
and durable write deduplication are not implemented here.

## Protocol

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
and the response is `operation-timeout`. If a write times out or errors after
dispatch, the response is `operation-indeterminate`: the mutation may have
committed, and clients must not automatically retry. A response-size failure
after a write is also indeterminate. Requests rejected before dispatch return
`operation-not-dispatched`. This step has no durable operation journal, request
deduplication, or interrupted-operation status endpoint; those are step 5.

Errors use stable codes: `unsupported-protocol-version`, `unsupported-operation`,
`invalid-request`, `unauthorized`, `forbidden`, `budget-not-found`,
`operation-mode-mismatch`, `operation-in-progress`, and
`operation-interrupted`, `operation-indeterminate`, `operation-timeout`,
`operation-not-dispatched`, `request-too-large`, `result-too-large`,
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
