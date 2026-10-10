# Architecture

## Process boundaries

`src/core` is independent of Electron. Each device owns one SQLite database with WAL journaling. The Windows renderer has no Node integration. A sandboxed preload exposes only a bounded RPC entry point; the main process checks the sending frame. Windows secrets use `safeStorage`. The browser development adapter binds only to loopback, checks Host and Origin, and requires a random per-process token on mutation requests.

The desktop installer preserves application data and uses a stable application ID. Updates currently use an explicit replacement installer, not a network updater. The app exposes no public network server. An explicitly enabled Agent listener is loopback-only and exists in both desktop and development-preview processes.

## Local storage selection

`storage-location.mjs` resolves a device-local startup pointer next to the initial directory (`<anchor>.storage.json`). Existing launch arguments select the anchor; user-confirmed changes persist a pending action and apply at the next startup, not during editing. UI storage controls never enter external Agent RPC or shared revisions. Desktop can choose folders and restart; browser preview requires restarting its local server with the same anchor.

Windows preview implements `chooseDirectory` only in the authenticated UI adapter, outside Service and external Agent RPC. `src/preview/directory-picker.mjs` launches the system Windows PowerShell with a fixed, encoded STA script and no request-derived command arguments; the script returns a JSON path or null from a native folder dialog. The console is hidden, output and runtime are bounded, only one picker runs per server, and client disconnect/server shutdown abort the child. Desktop keeps Electron's native dialog. All root actions select first, then inspect and confirm; picking alone never schedules a storage change. Root and sync settings share the UI picker; independent backup and restore entries are retired.

`workspace-lock.mjs` gives each Service exclusive ownership using a PID/nonce file, with a separate anchor-configuration lock. An unchanged dead-process lock can be reclaimed; unknown/live owners fail closed. Legacy builds do not cooperate with this lock and must be closed before relocation. Missing databases in configured locations fail explicitly instead of initializing blank workspaces. Desktop and preview vault formats are not interchangeable.

Migration retains the source and requires an empty, disjoint local destination. Configured sync/backup overlaps, symbolic links and UNC paths are rejected. Startup rechecks identities and boundaries. A SQLite write reservation holds other writers while the SQLite backup API snapshots committed WAL content and managed files are copied, flushed and hashed. A second integrity check and asset hashes gate activation. Local asset/file-link paths within the old directory are rebased; stable IDs, events, preferences, grants and secrets are retained. Chromium cache, temporary uploads and opened-file copies are excluded. This is a same-device move, not cross-device synchronization or independent backup.

Incomplete destinations remain marked and cannot be opened. The startup pointer changes only after the new Service opens successfully; a migration or settings-write failure retains the original pointer. A crash before pointer commit may leave an unused completed copy, but never replaces or deletes source data. The old directory is a rollback snapshot and must not be used concurrently with the migrated copy. Source databases and startup metadata must not be uploaded through directory synchronization.

## Library directories under the root

The selected workspace directory is also the system root. The root picker resolves an empty destination to the existing migration workflow and an existing database to the open-workspace workflow. UI confirmation names the resolved action and submits that action, rather than silently changing its meaning if the directory later changes. Existing explicit migration/open controls remain available.

`library-directories.mjs` creates a direct child per library, with a small ownership marker and a relative-name map in `local_config.libraryDirectories`. Names are bounded and Windows-safe; unrelated folders, reserved names and sanitization collisions are never claimed. The stable library UUID remains independent of the directory name. Renaming library metadata, deleting or restoring a library does not rename or remove its folder. A missing mapped directory can be recreated, but a replaced marker or symlink is rejected. Filesystem failure during a new library save rolls back its knowledge revision and local mapping; partially created folders may remain but are never exposed as committed libraries.

Trusted UI state decorates libraries with local paths/errors and reconciles legacy/synchronized/restored library directories without rewriting events. External Agent library/record responses remain path-free. New UI and Agent attachment imports use the library's `attachments/<hash>` path; identical content in separate libraries may occupy separate files. Existing paths and shared sync/backup object staging remain readable. Migration preserves relative folder mappings and rebases attachment bindings under the new root.

The root SQLite database remains authoritative for notes, histories, authorization and shared consistency. Library folders are not standalone workspaces and do not enable filesystem auto-import. Ownership markers and local maps do not enter sync packets or independent backup revision data; another device derives its own safe directory layout.

## Versions

Every shared entity has a stable UUID. Revisions contain a distinct UUID, origin device UUID, device sequence, parent revision IDs, timestamp, deletion flag, schema version, allowlisted data and a canonical SHA-256 checksum.

The `heads` table is a materialized frontier of the revision DAG. Child revisions wait in `pending` until their parents exist. Parent/entity/type validation prevents cross-entity ancestry. Concurrent heads are preserved. User edits require the base heads they saw; stale editors cannot silently rebase. Explicit branch save and conflict resolution create new revisions.

Deletes are tombstone revisions, not file absence. Historical recovery creates another revision. Restoring an independent backup merges histories rather than replacing a database.

Shared entity kinds: note, draft, conversation, source, annotation, relation, proposal, workspace, asset, provider, model, usage, task, library, agentPreferences. Conversation/provider/model/usage/task remain recognized for historical compatibility only. Proposal acceptance validates target bases and commits selected items with the proposal revision in a single transaction.

## User-owned libraries

Version 0.1.1 adds explicit `library` revisions. A fresh workspace has no libraries. New libraries use their UUID as an immutable `domain` scope; the display title and description may change without rewriting notes, conversations or history. Library metadata uses the same encrypted transport, conflict and backup mechanisms as other entities. All participating applications must be upgraded: version 0.1.0 does not recognize the new entity type.

Historical content without library metadata is exposed as a legacy library projection with a deterministic ID derived from its existing domain. Reading this projection creates no revisions. The first user edit persists metadata with that same identity and original domain, allowing concurrent edits on different computers to converge as visible conflicts. Model, provider and workspace metadata do not create phantom libraries.

Deleting a library is allowed locally only when it contains no content, including recycled content. It never cascades. Content arriving concurrently with a remote library deletion remains discoverable under a recovery-marked library; the user may restore the library. Historical note/backup formats remain readable without destructive migration.

Workspace-local settings include selected library, tabs, unsaved note drafts and reading positions. Historical chat state is not automatically erased but has no running UI or worker. Outgoing publications and incoming adoptions allowlist only id, recordId, title, domain and scroll. The old `__all_libraries__` discussion domain remains excluded from legacy library discovery.

## Current content sync (v3)

`current-sync.mjs` replaces runtime Git and independent backup. SQLite retains the immutable per-record edit DAG, stale-save guards, conflicts and restorative edits. There is no commit step or application-wide local version catalogue. All libraries, preferences and public device policies travel together; secrets, local paths, database files and device authorizations never do.

Each device atomically replaces its own authenticated `current-<deviceId>.sscurrent` pointer in `StudySelfSync/v3/<key-fingerprint>`. Its manifest refers to immutable encrypted history shards (about 2 MiB) and binary attachment chunks (4 MiB). Each pointer is self-contained, including note modification history: new devices need only the latest pointers and referenced objects, not older manifests or Git prerequisites. Downloaded pointers are merged by stable event IDs and ancestry, never by device timestamp.

`sync-state.mjs` validates histories and device policy DAGs before mutation. Pull validates all downloaded manifests and metadata, assembles required originals, then transactionally applies events, asset bindings, device state and import identity receipts. A failed database transaction leaves current knowledge intact; verified file objects can be reused on retry. Index-only imports explicitly leave originals unavailable.

Publication freezes saved events in a persistent local plan. `statfs` estimates free bytes, additional encrypted-object bytes and a 64 MiB reserve; batches default to 256 MiB, bounded again by live free space before each write. Cursor progress persists after every object, and pauses/errors survive restart. Previously generated objects released through the official client require explicit batch-upload confirmation before finalizing a new pointer. Published descriptors can reuse existing immutable cloud references without fetching every old original. No cloud success is inferred from this bookkeeping.

`resumable-files.mjs` persists `.v3.partial` data and per-hash checkpoints. A chunk is checkpointed only after flush. Restart verifies each checkpointed prefix chunk, truncates any untrusted tail, and resumes at the first invalid/missing chunk. Missing cloud copies of an already verified prefix do not prevent continuation. Per-chunk authentication, full-file hashing and atomic promotion precede asset binding. Free-space checks and cooperative pause retain useful partial bytes.

Device retention guards remain: conflicting primary roles block release, secondaries require a current-primary hash receipt, no unsent changes, no pinned/active/local-file-link references, and a managed verified path. Primary originals remain protected. Per-note history restore does not require Git; cloud-level history is managed through Baidu. Restored old manifests on an existing workspace merge without silently discarding later edits.

Retired v2 journals recover their knowledge payload/bindings directly into SQLite; old repositories, backups and directories remain untouched. No active Service method imports Git or `BackupManager`. Legacy modules below remain test/reference compatibility only. See [decision 0006](decisions/0006-current-content-sync.md) for current recovery boundaries.

## Git versions and v2 handoff (retired)

`git-versions.mjs` maintains one bare repository per library scope plus `__shared__`. The JSON snapshot preserves original immutable revision IDs, rich content, provenance and file identities; binaries never enter Git. Moved records include required ancestors and the outbound move boundary in their previous scope, but not subsequent edits owned only by their new scope. Whole-library restore cannot reclaim an entity currently belonging to a different library. The repository is not the project source repository and never travels directly.

`v2Journal` durably records the frozen snapshot, intended parents and optional import bookkeeping. Recovery deterministically creates/reuses the commit, updates the local ref, then transactionally imports events, file bindings, import receipt and pointer. Pending journals prevent new edits. Restores save restorative revisions and the operation journal together; they do not rewind a ref over later history. Backup-restored tips are retained as archive refs and become parents of the next local commit.

`git-sync.mjs` was the v2 Service transport. Only explicit UI commands committed, published, scanned or imported. Publishing froze the submitted commit, using a full bundle initially and a prerequisite-based incremental bundle thereafter. A persistent publication ID and immutable object names supported retries. An incoming bundle had to verify, unbundle and pass Git fsck before its snapshot was accepted. Merge retained both Git parents and conflicting entity heads; dirty editor tabs or uncommitted scope changes blocked pulls. No timer imported incoming files.

`sync-objects.mjs` implements a directory channel with no cloud observation/control capability. The namespace is `StudySelfSync/v2/<key-fingerprint>`. Manifest, bundle, receipt and original chunks are all authenticated encrypted objects. Binary framing is an 8-byte format marker, 12-byte nonce, 16-byte GCM tag and ciphertext; AAD binds object identity. Attachments use SHA-256 plus 4 MiB chunks, full-file validation and local `received-objects/<hash>` staging/retention, compatible with earlier local bindings. Missing/truncated/unauthenticated objects never become complete records. Scan presence and size checks are only discovery, not integrity evidence. Normal import requires all current snapshot originals; explicit secondary index-only import leaves files unavailable.

Device announcements and primary-role DAG are shared in the separate scope. Local addresses, credentials and release paths are not. Conflicting roles disable eviction. Primary receipts cover verified file hashes under a committed role epoch, not cloud upload. Secondary eviction additionally requires explicit confirmation, clean versions, no active media read or pinned alias, no local-file-link reference, a known handoff manifest and a managed content-addressed original path. The app never deletes transfer files for space management. Primary originals are currently all protected; historical orphan eviction remains deferred. The retired client questionnaire is no longer an API or release prerequisite; existing local questionnaire records are left untouched and provide no release authority.

The first explicit commit lazily migrates existing revisions without changing IDs, SQLite history or originals. Old and new namespaces do not mix. Old cloud packets must be received with the old version before switching; no automatic old-packet importer is exposed in v2. See [decision 0005](decisions/0005-git-encrypted-handoff.md) for limits, backup compatibility and transport responsibilities.

## Legacy folder transport (inactive in Service)

The transport directory is disjoint from the local database directory. A 256-bit pairing key creates a channel fingerprint. Transfer envelopes use AES-256-GCM with authenticated schema/kind/sender/packet metadata. They are written through a uniquely named temporary file, flushed and renamed to `.ssync`; readers ignore partial files, verify authenticated payloads and content checksums, and deduplicate packet/revision IDs.

Large notes are batched by byte size. A received parent may unlock pending children. Receipts acknowledge only committed revisions, not unseen or pending children. Recipients create encrypted receipt packets; their eventual arrival supplies the only remote-received status.

No lock files, global mutable manifests or online coordinator are required. No operation assumes both computers are online. No cloud upload success is inferred. Baidu Sync Space is the user-accepted transport dependency, not a product awaiting requalification. StudySelf must still handle delayed, missing, repeated and damaged files correctly. Optional real-device integration records do not gate development or replace application integrity tests.

Local states: `local` = committed revision not yet published, `waiting` = an encrypted record was written to the configured directory, `received` = a different device acknowledged it (or this is an imported revision). Attachment availability and backup completeness are separate.

## Legacy attachment protocol (retained for compatibility tests)

Shared metadata uses a stable asset UUID, SHA-256, byte length, media type and original filename. Local bindings never travel. All imported files, including standalone and recycled assets, travel through authenticated packets and are stored locally on each computer. New files up to 4 MiB use the legacy `asset` packet; larger files use `asset-chunk` packets with fixed 4 MiB chunks, index/count, full-file hash, size and individual chunk hash. Legacy whole-file packets up to 16 MiB remain readable. Both computers must upgrade for chunk support. URLs and device-only external file bindings are not automatically downloaded or uploaded.

Publication checkpoints and incoming packet references are device-local SQLite settings. Interrupted publication reuses verified immutable packets. Incoming chunks may precede metadata or arrive out of order; the receiver streams authenticated packets into a local staging file, verifies the complete SHA-256 and atomically promotes it before binding asset IDs. It does not keep an additional plaintext chunk cache. Whole-file failures retain retry information without presenting partial attachments. Missing/corrupt local originals do not create deletion revisions or block unrelated notes; a cycle reports local file availability separately from note receipts and unverified cloud upload status. File packets are retained for offline/new devices. Automatic transport garbage collection and remote full-file receipts are not implemented; therefore no claim of zero duplicated disk use or remotely complete original files is made.

Successful local file hashes are cached against device-local path, file identity, size, modification time and change time, avoiding a full video rehash on every timer tick. A changed signature triggers a new hash check. Complete incoming assembly always verifies the full content, independently of this cache. Retained incoming packet references allow rebuilding a lost receiver copy, including legacy small files; they do not authorize deleting transport packets.

Processed packet scan fingerprints are also device-local. Only unchanged files whose packet digest still matches the persisted receipt can skip decryption; small-file packets are reopened when their local original needs repair. Changed signatures re-enter authentication and immutable packet-ID collision checks. Incomplete large files still assemble from their validated packet references, never from the scan cache alone.

Pinned means the application should keep the local object. There is currently no automatic object eviction, so unpinned files are not automatically deleted either.

## External Agents and Skill

### Rich note content

Content layout uses a separately validated `data-ss-layout` JSON attribute (width 15-100 percent, height null or 60-1600 pixels, align left/center/right). `section[data-ss-container]` holds editable table/callout/file-link content; `div[data-ss-row]` groups rich blocks and containers horizontally. Absent attributes retain the old automatic layout. Tiptap transactions record resize/reorder/group operations in undo history; display-only pointer previews never alter serialized data. Read-only hydration derives styles from validated attributes, and Markdown preserves the wrappers. Peers must update before editing these nodes; historical content and hashes are not rewritten.

Node views present unframed content with internal captions and hover/focus actions. A stationary primary press of one second starts a pointer-captured floating preview; movement before activation cancels the hold so text selection remains available. Left/right drop targets form rows and upper/lower targets reorder blocks. Eight transparent edge/corner regions resize content without a dedicated grip. Escape, pointer cancellation, window blur and node destruction clean up previews and restore uncommitted sizes. Native video controls and action buttons do not initiate holds. Gesture previews never enter note HTML or saved history.

File drops import only the supplied files through the authenticated preview upload or Electron's `webUtils.getPathForFile` preload bridge and trusted IPC. Images/videos embed stable asset IDs, other files become internal attachment links. Browser uploads retain the 128 MiB per-file limit; desktop imports use existing path-based streaming. Imports keep a mapped insertion position while the user edits; navigation/close actions are held until the batch completes, and individual failures leave successful imports intact. Dropping files never navigates the browser to their local path.

`web/note-autosave.js` serializes writes per note after a 1.5-second edit pause. Each request captures the draft and its base heads. Later edits remain dirty and use the returned heads for their next write. Successful saves update status without rebuilding the editor, preserving selection, undo and media state. Failed/conflicting requests pause automatic retries, retain local drafts, and require manual action; only an explicit manual confirmation writes a concurrent branch. Workspace draft snapshots are queued in order, independently of note revisions. Closing a dirty page still warns, and local save does not publish cloud content.

HTML note content has additive `figure[data-ss-block]` nodes containing versioned JSON (`v: 1`). Media refers to stable asset IDs; diagrams keep Mermaid source, formulas keep LaTeX, canvas blocks keep bounded structured shapes. Existing event schemas/checksums are unchanged; reading history does not normalize old data. New note/draft/source writes collect embedded assets. Core parsing uses parse5 (and marked for Markdown), independently of browser sanitization and declared reference arrays. Agent authorization follows embedded internal links/media and source URLs on every current branch and historical revision.

Rendering uses Tiptap task/highlight/custom nodes, KaTeX with trust disabled, Mermaid strict mode plus sanitized SVG, and Konva for canvas editing. External images/scripts/iframes are not accepted in note HTML. JSON characters that resemble XML delimiters are escaped without disabling sanitization. Atom-node views ignore display-only DOM mutations so asynchronous rendering cannot rewrite serialized content. Markdown export preserves raw rich-block HTML but does not bundle original assets or promise third-party rendering. Peers need the updated editor before editing rich notes; older editors can discard unknown nodes.

The preview adapter exposes authenticated `/media/<assetId>` GET/HEAD with single byte ranges, strict Host/Origin checks and no CORS. Desktop uses a `studyself-media://asset/<assetId>` protocol with a raster-image/video MIME allowlist. Both validate record availability, local regular files, size and hash before streaming. The content stores neither temporary URLs nor media access tokens. Large video startup may require a full hash scan; missing files remain visible as unavailable rather than deleting content.

Portable links use `studyself://note|asset|local/<UUID>`. Local-file UUID bindings live only in `local_config.localFileLinks`; paths never enter note revisions, workspace publications, transport, backup or Agent RPC. Only the desktop trusted UI can choose a binding. Opening requires native confirmation, local regular-file checks and a document/media extension allowlist; executables, scripts and UNC paths are excluded. Browser preview cannot directly open these bindings and supports managed attachments instead.

### Authorization and writes

`agent-access.mjs` owns a separate, default-off HTTP listener on 127.0.0.1. Desktop and preview share this implementation. The listener persists its local port, checks Host, rejects Origin, limits body size and does not enable CORS. It exposes only POST /v1/rpc and never forwards arbitrary Service RPCs.

Per-Agent random 256-bit bearer tokens are displayed once; only SHA-256 hashes, granted domains, permissions and expiry are stored locally. Revocation/expiry is checked again after reading the request body. Base permissions read/collect/propose do not allow note overwrite, trash or user approval. Sensitive access, edit and trash are separate grants. System configuration, files by arbitrary path, secrets, shell commands, preference writes and approval are not external methods. This protects the API, not against another process already possessing filesystem or OS permissions.

Every current branch and referenced source/asset/target must pass domain and sensitivity checks. History additionally checks every historical revision. Search filters inaccessible content before pagination. Files are hash-checked, addressed by asset ID and bounded to 16 MiB; no absolute paths are returned.

Mutations carry requestId, preferencesVersion and, for updates, exact base heads. The durable local agent_requests receipt and writeRaw revisions commit in one SQLite transaction. A repeated request returns the original result only when the digest matches and current authorization still permits access. A changed payload with the same ID fails. No network inference happens in this application. A bounded audit log stores operation names, grant IDs and outcome codes, not request bodies or credentials.

The fixed-ID agentPreferences entity synchronizes/backs up like other versioned content. It does not create a library. Its effective version hashes the maintained Skill baseline plus current preference heads. Concurrent preference versions suspend new Agent writes until user reconciliation. Adding this type requires every sync peer to update; historical schemas/hashes remain unchanged. Credentials and receipts remain local and are excluded from backup and transport.

Canonical Skill files live in skills/studyself-organize, included as application resources. bootstrap returns the latest Skill text, API guide, version and effective preferences. UI ZIP export contains a snapshot plus the dependency-free Node client. User requirement changes update this maintained source; installed copies fetch current guidance but are not overwritten automatically. Local installs receive no token or model configuration.

Built-in model, pricing, media and conversation workers were removed. Historical record validators remain to support old sync packets and backups. An orphan local running task may be marked interrupted_cost_unknown on startup, never rerun. Old local credentials are retained without reuse; the app no longer provides provider editing or billing UI.

## Backups (retired compatibility module)

There is no current backup UI, Service method or idle backup scheduler. The following format description is retained for old data and compatibility tests; it is not an active product workflow.

A backup directory contains `revisions.json`, `manifest.json` and content-addressed original files. It excludes local databases, device identities, pairing secrets and API credentials. Revisions and files are verified before restore; the attachment files are staged before committing database history. Missing or deferred originals stay explicit in the manifest.

Format 1 now optionally includes verified per-scope Git bundle descriptors under `git/`. Archive refs preserve original commit IDs; restoring merges knowledge and device-role history without replacing current pointers or silently changing the new device identity. Old manifests without Git remain supported.

Backup content is currently plaintext and may only be generated outside the configured sync tree. Do not upload it unencrypted; cloud encrypted backup is not implemented. `localComplete` does not imply `cloudVerified`.

## Verification

Node tests simulate separate profiles and transfer directories, reversal of directions, concurrent edits, dependencies, replay, corrupt transfers, deletes/restores, small/large files, partial approvals, backups, external Agent privacy boundaries, request deduplication, preference versions and workspace adoption.

Playwright browser tests cover real editing and task navigation. Native tests additionally cover packaged Electron startup, preload IPC, SQLite and Windows encryption. All test material is generated under `artifacts` and does not use a personal cloud account or a paid model.
