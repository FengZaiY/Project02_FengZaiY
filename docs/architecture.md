# Architecture

## Process boundaries

`src/core` is independent of Electron. Each device owns one SQLite database with WAL journaling. The Windows renderer has no Node integration. A sandboxed preload exposes only a bounded RPC entry point; the main process checks the sending frame. Windows secrets use `safeStorage`. The browser development adapter binds only to loopback, checks Host and Origin, and requires a random per-process token on mutation requests.

The desktop installer preserves application data and uses a stable application ID. Updates currently use an explicit replacement installer, not a network updater. The default app is not a network server.

## Versions

Every shared entity has a stable UUID. Revisions contain a distinct UUID, origin device UUID, device sequence, parent revision IDs, timestamp, deletion flag, schema version, allowlisted data and a canonical SHA-256 checksum.

The `heads` table is a materialized frontier of the revision DAG. Child revisions wait in `pending` until their parents exist. Parent/entity/type validation prevents cross-entity ancestry. Concurrent heads are preserved. User edits require the base heads they saw; stale editors cannot silently rebase. Explicit branch save and conflict resolution create new revisions.

Deletes are tombstone revisions, not file absence. Historical recovery creates another revision. Restoring an independent backup merges histories rather than replacing a database.

Shared entity kinds: note, draft, conversation, source, annotation, relation, proposal, workspace, asset, model, usage, task. Proposal acceptance validates target bases and commits selected items with the proposal revision in a single transaction.

## Folder transport

The transport directory is disjoint from the local database directory. A 256-bit pairing key creates a channel fingerprint. Transfer envelopes use AES-256-GCM with authenticated schema/kind/sender/packet metadata. They are written through a uniquely named temporary file, flushed and renamed to `.ssync`; readers ignore partial files, verify authenticated payloads and content checksums, and deduplicate packet/revision IDs.

Large notes are batched by byte size. A received parent may unlock pending children. Receipts acknowledge only committed revisions, not unseen or pending children. Recipients create encrypted receipt packets; their eventual arrival supplies the only remote-received status.

No lock files, global mutable manifests or online coordinator are required. No operation assumes both computers are online. No cloud upload success is inferred. The unofficial expectation that a folder client eventually transports complete immutable files must be verified using the real Baidu client.

Local states: `local` = committed revision not yet published, `waiting` = an encrypted record was written to the configured directory, `received` = a different device acknowledged it (or this is an imported revision). Attachment availability and backup completeness are separate.

## Attachments

Shared metadata uses a stable asset UUID, SHA-256, byte length, media type and original filename. Local bindings never travel. Imported files are copied into managed content-addressed storage and verified. Small attachments (<=16 MiB) travel in authenticated packets; large attachments travel out-of-band through the official client and can be rebound only after hashing. Missing attachments never delete notes.

Pinned means the application should keep the local object. There is currently no automatic object eviction, so unpinned files are not automatically deleted either.

## Models, jobs and money

Provider connection addresses, keys, Ollama discoveries and local UI state are local configuration. Shared model records contain the display name, provider ID, actual model ID and user-supplied prices, not credentials. Local model availability is refreshed before execution; an Ollama cloud entry is not treated as local.

Text requests use one explicitly selected model. Cloud calls need a cost preview; unknown or larger estimated costs need confirmation. An attempt ledger is written before the network call. No retries or provider fallback are automatic. Imported tasks do not execute; interrupted local tasks are labeled cost-unknown on restart. If a long response arrives after a conversation has changed, its result is preserved in a separate conversation rather than overwriting updates.

Usage reports record request IDs, actual returned token counts when present, and calculated cost. Billed cost remains unavailable without a billing API. Cross-device totals are eventually consistent, currency-separated and not a global realtime budget lock.

## Backups

A backup directory contains `revisions.json`, `manifest.json` and content-addressed original files. It excludes local databases, device identities, pairing secrets and API credentials. Revisions and files are verified before restore; the attachment files are staged before committing database history. Missing or deferred originals stay explicit in the manifest.

Backup content is currently plaintext. Upload to the official cloud client remains an independently observed operation. `localComplete` does not imply `cloudVerified`.

## Verification

Node tests simulate separate profiles and transfer directories, reversal of directions, concurrent edits, dependencies, replay, corrupt transfers, deletes/restores, small/large files, partial approvals, backups, model mismatch, privacy boundaries, request deduplication and workspace adoption.

Playwright browser tests cover real editing and task navigation. Native tests additionally cover packaged Electron startup, preload IPC, SQLite and Windows encryption. All test material is generated under `artifacts` and does not use a personal cloud account or a paid model.
