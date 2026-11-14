# Remote budget v1 contracts

This document records the server-owned mode metadata, protocol/bootstrap shape,
and the step 3 worker/session lifecycle. Financial RPC and SDK remote activation
are not implemented here.

## Protocol

The planned financial RPC protocol uses HTTPS JSON and bearer authentication.
Those requests carry `protocolVersion: 1` and a client-generated `requestId` (1
to 128 characters), and responses echo both fields with either `result` or an
error object. The implemented lifecycle routes below have their own small
request/response schemas and do not yet use the financial RPC envelope. A
session is bound to `sessionId`, `budgetId`, `ownerId`, and protocol version;
the session handle does not replace bearer authentication.

## Hosted worker lifecycle

The server exposes only session lifecycle routes in this step:

| Route                                             | Request                                       | Result                                                            |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `POST /remote/session/open`                       | `{ "protocolVersion": 1, "budgetId": "..." }` | `201` with the protocol version, opaque session ID, and budget ID |
| `GET /remote/session/:budgetId/:sessionId`        | No body                                       | `200` while the authenticated session remains valid               |
| `POST /remote/session/:budgetId/:sessionId/close` | No body                                       | `204` after releasing that session                                |

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

No public budget-creation route or financial RPC is exposed yet. Disposable
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

The initial typed request schemas in `src/remote-v1-contract.ts` cover
`accounts.list`, `transactions.list`, and `transactions.import`. Payloads reject
unknown keys and malformed dates. The later financial RPC registry may add
individual schemas for the resources in the capability matrix. AQL must be
transported as a serialized query structure under its own schema; SQL strings,
executable code, and arbitrary handler names are never protocol operations.
`transactions.import` accepts JSON transaction objects; operation-size and
transaction-field validation belong to the RPC implementation stage.

Errors use stable codes: `unsupported-protocol-version`, `unsupported-operation`,
`invalid-request`, `unauthorized`, `forbidden`, `budget-not-found`,
`operation-mode-mismatch`, `operation-in-progress`, and
`operation-interrupted`.

## Capability matrix

| Area            | v1 planned capability                                                                        | Excluded                                               |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Reads           | Accounts, categories/groups, payees, tags, rules, budget months, preferences, serialized AQL | Raw SQL/database internals                             |
| Writes          | Financial object creation/editing and transaction add/update/delete/import                   | File lifecycle, sync, encryption, server URL changes   |
| Session         | Open and release an owner/budget/protocol-bound session                                      | Session handle as authentication, shared budgets       |
| Local callbacks | None                                                                                         | Callback serialization, remote batch spanning requests |
| Undo            | None                                                                                         | Engine-global undo/redo                                |

The matrix describes the intended resource capability, not the set of handlers
implemented in this step. The exported schemas are the narrow initial wire
surface; later handlers must add one schema at a time.

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
