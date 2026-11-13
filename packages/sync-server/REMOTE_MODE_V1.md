# Remote budget v1 contracts

This is the step 1 contract. It defines server-owned mode metadata and the
versioned protocol/bootstrap shape; it does not start a worker or expose remote
RPC routes yet.

## Protocol

The protocol uses HTTPS JSON and bearer authentication. Every request carries
`protocolVersion: 1` and a client-generated `requestId` (1 to 128 characters).
Every response echoes the protocol version and request ID and contains either
`result` or `{ code, message }`. A session is bound to `sessionId`, `budgetId`,
`ownerId`, and protocol version; the session handle does not replace bearer
authentication.

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

| Area | v1 planned capability | Excluded |
| --- | --- | --- |
| Reads | Accounts, categories/groups, payees, tags, rules, budget months, preferences, serialized AQL | Raw SQL/database internals |
| Writes | Financial object creation/editing and transaction add/update/delete/import | File lifecycle, sync, encryption, server URL changes |
| Session | Open and release an owner/budget/protocol-bound session | Session handle as authentication, shared budgets |
| Local callbacks | None | Callback serialization, remote batch spanning requests |
| Undo | None | Engine-global undo/redo |

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
until validation succeeds. These are validation/state contracts only; worker
loading and bootstrap execution are later steps.

## Legacy route behavior

After authentication and file access checks, remote budgets reject conventional
sync, full upload/replacement, download, reset, encryption-key, and deletion
routes with HTTP 409 `{ "status": "error", "reason": "remote-budget" }`.
The check occurs after authorization so unauthorized callers cannot infer mode.
The `synced` default keeps these routes unchanged for existing budgets.
