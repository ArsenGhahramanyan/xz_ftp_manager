# Changelog

## 1.6.2

### Changed
- **Published as open source under the MIT license.** Added a `LICENSE` file, `license` / `bugs` / `homepage` fields in `package.json`, and Install / Contributing / License sections in the README.

### Fixed
- **`npm run lint` is clean again.** `assertWithinDirectory` loaded `path` through an inline `require()`, which `@typescript-eslint/no-require-imports` rejects and which failed the CI lint step; it is now a top-level `import * as nodePath from 'path'`. Behaviour is unchanged.

## 1.6.1

### Changed
- **Import Sites now files every imported site by protocol.** Instead of appending the exported tree at root level, each incoming site is placed in the default **FTP** / **FTPS** / **SFTP** folder matching its profile's protocol; folders from the file are no longer recreated. The target folder is matched by its stable id, so a folder the user renamed is reused under its own name and one the user deleted is recreated on import. A site whose profile is missing from the bundle has no protocol to sort by and stays at the top level; the summary notification reports how many folders were dropped and how many sites stayed unsorted.

## 1.6.0

### Added
- **Default Site Manager folders.** On first run the tree is seeded with three root folders — **FTP**, **FTPS**, **SFTP** — so new sites have a place to go. Seeding happens once per install: deleting or renaming a folder is respected and it is not recreated on the next activation.

### Removed
- **The Bookmarks view** and its `Add Bookmark` / `Remove Bookmark` / `Go to Bookmark` commands, the `Bookmark` model, the bookmark storage keys, and the (never used by the webview) `addBookmark` / `goToBookmark` webview messages. The sidebar now shows only *Site Manager*.
- **The Transfer Queue sidebar view.** Queue management lives in the panel's transfer pane; the `pause/resume/cancel/retry/clearCompleted` commands are unchanged and still available from the Command Palette.

## 1.5.0

### Security
- **SFTP host key is now verified *before* authentication (fixes credential leak on first connect).** Previously the `hostVerifier` accepted any unknown key and the TOFU "Trust and Save / Disconnect" prompt only appeared *after* the SSH handshake — so a man-in-the-middle on the first connect received the user's password before they could reject the key. Verification now runs inside ssh2's async `hostVerifier` during key exchange; credentials are transmitted only after the user trusts the fingerprint. The *Test Connection* path uses the same verifier.
- **Remote search is now bounded.** `SearchService` adds a visited-path set, a max recursion depth, and caps on directories visited / results collected, so a malicious or misbehaving server returning cyclic or ever-deeper listings can no longer exhaust the extension host.
- **Download targets are traversal-checked.** A server entry named exactly `..` could make a single/multi-file download write into the parent of the chosen folder; `handleDownload` now runs `assertSafeEntryName` + `assertWithinDirectory` on each target.
- **Stale secrets are purged on profile edit.** Switching a site's auth method now deletes the password/passphrase the new method no longer needs, instead of leaving them in the OS keychain.
- **Plain-FTP cleartext warning is now user-visible** (a non-modal notification, not only a log line that `logLevel: off` would suppress).
- **Quick Connect validates the password** for CR/LF/NUL, matching the existing host/username checks.
- **Case-sensitive temp-file mapping.** The remote↔temp map is no longer lower-cased on Linux, so two remote files differing only in case can't collapse to one key and re-upload to the wrong path on save.
- **Tightened the ReDoS guard** to also reject alternation-overlap patterns like `(a|a)+` in regex search.

### Fixed
- **SFTP servers with only SHA-1 host keys can be reached again.** The hardcoded modern-only `serverHostKey` list made ssh2 abort with a bare `Handshake failed: no matching host key format` against appliances that predate RFC 8332 and offer just `ssh-rsa` / `ssh-dss`. A per-site *Allow legacy SHA-1 host key algorithms* checkbox (Advanced tab, SFTP only, off by default) appends them **after** the modern ones, so a server that supports a modern algorithm still negotiates one. The handshake error now names the site and points at the checkbox instead of failing silently.
- **"Pause All" / "Resume All" did nothing.** The webview sent `pauseAllTransfers` / `resumeAllTransfers` messages the extension never handled; they now send the `transferBulkAction` message the handler expects.
- **Pausing an active SFTP transfer now actually stops I/O and resumes from the byte offset**, instead of continuing to stream in the background and getting stuck in `paused`. FTP/FTPS (which cannot pause without dropping the session) leave active transfers running; queued items are always pausable.
- **`ftpManager.refresh` and the post-bookmark tree refresh now work** — both previously called unregistered commands (`ftpManager.refreshTree` / `ftpManager.bookmarks.refresh`) and were silent no-ops.

### Changed
- **Concurrency is now protocol-aware.** FTP/FTPS are capped at one transfer per connection (a single `basic-ftp` client cannot multiplex); SFTP uses the configured `maxConcurrentTransfers`. Introduced `ProtocolCapabilities` (`concurrentTransfers`, `pauseResume`) on the adapter interface.
- **Cancelling an FTP transfer no longer triggers auto-reconnect.** The forced close is flagged `expected`, so the reconnect loop leaves it alone.
- **FTP ASCII mode is now implemented** (issues `TYPE A` around the transfer, restores `TYPE I`); the setting previously had no effect. SFTP ignores it (no ASCII mode in the protocol).
- **SSH keyboard-interactive fallback** — password/keyAndPassword auth now answers keyboard-interactive prompts with the connection password, so PAM-only servers connect.

### Removed
- **Dead code.** Deleted the unused `Breadcrumb` webview component (and its CSS); six unregistered/undeclared file-operation commands in `fileCommands.ts` (upload/download/deleteRemote/renameRemote/mkdirRemote/chmodRemote — the webview drives these directly); the dead `transferUpdate` / `transferStats` / `showPermissionDialog` webview-message paths; and the unused exports `formatUtils.formatDate`, `formatUtils.formatPermissions`, `pathUtils.isHiddenFile`. `TransferItem` now uses the shared `makeId` helper.

### Tooling
- Added an **ESLint flat config**, a **GitHub Actions CI** workflow (type-check + lint + unit tests + build + VSIX package on Linux & Windows), and **unit tests** for `pathUtils` and the `TransferItem` state machine (run with `npm test`, zero extra runtime deps via `node:test`).
- Removed the unused `style-loader` dependency, bumped `@types/vscode` to match `engines.vscode` (`^1.90.0`), and removed a stray `invoicevendor` entry from the ignore files.

## 1.4.0

### Fixed
- **Auto-upload on save was completely broken.** `FileWatcherService` enqueued a plain `TransferItemData` object literal, but `TransferQueue` expects a `TransferItem` instance and immediately calls `.toData()` / `.activate()` on it — so every save of a remote-opened file threw `TypeError: i.toData is not a function` and nothing uploaded. The watcher now constructs a real `TransferItem`. (The `ITransferQueue.enqueue` signature had been widened to `TransferItemData`, which hid the type mismatch from the compiler.)
- **Import Sites was completely broken.** `validateImportedNode` checked `node.label`, but `SiteManagerNode` has no `label` field — it's `name`. Every otherwise-valid export was rejected with "Node.label invalid". It now validates `node.name`.

### Security
- **Temp-file path containment.** `TempFileService.downloadAndOpen` now runs `assertSafeRemotePath` on the remote path and `assertWithinDirectory` on the resulting local path before writing. Previously a malicious server returning a path with `..` segments could land the downloaded file outside the temp directory — and, via the save-watcher, re-upload edits to an attacker-chosen remote path.
- **FTPS upgrade no longer silently trusts self-signed certificates.** The v1→v2 storage migration used to set `trustSelfSigned = true` on existing FTPS profiles, flipping `rejectUnauthorized` to `false` and disabling certificate validation without consent. The migration no longer touches the flag, so it defaults to strict validation; a user who genuinely needs a self-signed cert re-enables *Trust self-signed* per profile.
- **Connection-test errors are sanitized.** The *Test Connection* result in the connection editor now passes its error message through `sanitizeForUi` (redacting hosts / IPs / absolute paths), matching every other error surface.

### Changed
- **Lazy activation.** Added `activationEvents` (`onView:ftpManager.{siteManager,bookmarks,transferQueue}`, `onCommand:ftpManager.openPanel`) so the extension no longer activates eagerly on every VS Code startup.
- **Auto-reconnect jitter.** Exponential backoff now applies ±20 % randomized jitter, so multiple windows / profiles that dropped at the same instant don't retry the server in lockstep.
- **Defensive config validation.** `ConfigService` clamps numeric settings (`maxConcurrentTransfers`, `connectionTimeout`, `keepaliveInterval`, `retryCount`, `retryDelay`) to their documented ranges and falls back to the default on a non-numeric / `NaN` value, guarding against a hand-edited `settings.json`.
- **`TransferQueue.dispose()` aborts in-flight transfers** instead of orphaning them — every active / queued / paused item is cancelled (signalling its `AbortController`) before the queue is torn down.
- **Quick Connect uses a crypto-random profile id** (`makeId('quick')`) instead of the predictable `quick_${Date.now()}`.

### Removed
- **Dead code.** Deleted `src/utils/permissionUtils.ts` — all three exports (`numericToSymbolic`, `symbolicToNumeric`, `parsePermissionBits`) were unused; the webview has its own permission logic. Also removed the unused `TransferQueue.countByStatus` method and a duplicate `posixDirname` helper in `DualPaneWebviewProvider` (now uses `getParentPath` from `pathUtils`).
- **`test/` scratch artifacts** — local manual-test files purged from the working tree (already git- and VSIX-ignored).

### Documentation
- Added a **Privacy** section to the README (no telemetry, no phone-home, data stays local).
- Removed the stale "CSP still allows `'unsafe-inline'`" known-limitation — both webviews have run under a strict `style-src ${webview.cspSource}` since 1.2.0.
- Documented the **pause** limitation (pausing does not interrupt an already-streaming transfer; only *Cancel* aborts in-flight I/O).

## 1.3.0

### Added
- **Offline banner per panel** — when a connection is lost (network drop, server kicked, keepalive failure) the panel now shows a red banner above the file panes with the disconnect reason; the banner disappears automatically on the next successful (auto-)reconnect.
- **Search results panel** in the webview replaces the legacy `QuickPick` for `xZ FTP Manager: Search Remote Files`. Results render in a modal overlay with a live filter box, click-to-navigate, `Esc` to close. The QuickPick is kept as fallback when no panel is bound to the connection.
- **Sort menu in each pane toolbar** — popover with the visible columns (Name / Size / Type / Modified, plus Permissions / Owner on the remote side) and a direction toggle. The current sort is marked with `✓`.
- **Transfer ETA column** — TransferPanel rows now show estimated time-remaining alongside the throughput once a transfer is active and a `bytesPerSecond` reading is available.
- **Per-site transfer overrides.** Connection editor → *Transfer* tab gained two new dropdowns:
  - **Overwrite rule** — site-level override for the workspace `defaultOverwriteRule` (use `Use global setting` to inherit). All overwrite modes are exposed including `Resume` and `Rename`.
  - **Auto-upload on save** — site-level override for the workspace `autoUploadOnSave` (Enabled / Disabled / Use global). Useful for production sites where silent re-uploads would be dangerous.
  - The runtime resolver `ProfileSettings` is consulted by every transfer-creating call site (DualPane upload/download, `ftpManager.upload`/`download`, `FileWatcherService`).
- **Keyboard shortcuts in the active pane**:
  - **F5** — refresh the active pane
  - **F2** — rename the single selected entry (validated client-side, server still re-checks)
  - **Delete** — delete the selected entries (with confirm)
  - Existing `Enter` and `Ctrl+A` shortcuts unchanged.

### Changed
- **TransferQueue concurrency cap is now per-connection.** Previously `processNext` counted active items globally, so a slow upload on profile A would starve transfers on profile B even when both panels had `maxConcurrent ≥ 2`. Each `connectionId` now gets its own slice of the cap.
- **FTP cancel emits `onDidDisconnect`.** `basic-ftp` doesn't expose a per-op abort, so cancelling a transfer still tears down the FTP socket — but the adapter now flips `connected` to false and fires the disconnect event so the UI updates immediately and auto-reconnect (or the next user action) can re-establish the session, instead of the next call failing with a cryptic "Not connected" error.
- **Notifications hygiene.** `Bookmark added/removed`, `Deleted: X`, `Renamed to: X`, `Directory created: X`, and `Permissions … → X` toasts have been downgraded to status-bar messages (`setStatusBarMessage`, 2-second auto-dismiss) — the file pane already shows the result, the toast was just visual noise.
- **TypeScript declarations no longer emitted.** `tsconfig.json → declaration: false`. Webpack would emit `.d.ts` siblings for every source file but never delete the orphans of removed modules; we ship the bundled JS only, so the declarations were dead weight.

### Fixed
- **Recursive `uploadDirectory` is now defended like `downloadDirectory`.** Symlinks are skipped, every entry name passes through `assertSafeEntryName`, and `assertWithinDirectory` confirms the resolved local path stays inside the upload root before the remote path is derived.
- **Symlink-skip on download walks** — recursive download of a remote tree no longer follows symlink entries (which would have written link-target paths into local files instead of the actual content). Users who need symlink targets transfer them explicitly.
- **Ctrl+A no longer selects every text run in the extension UI.** A regression introduced alongside the new offline banner / search-results / sort-popover elements meant that under some focus configurations the keydown handler ran *after* the browser's default "select all text on the page" had already kicked in, leaking row-level selection into the toolbar / breadcrumb / transfer panel as a single rainbow highlight. The fix is two layered:
  - **JS:** keydown is now bound on **both `window` and `document` in capture phase** (`window` fires earliest in the capture sequence). `Ctrl+A` calls `preventDefault` + `stopPropagation` + `stopImmediatePropagation` + `getSelection().removeAllRanges()` before delegating to `selectAllInActivePane`.
  - **CSS:** `.app-root` gets `user-select: none` globally; `input`, `textarea`, and `[contenteditable="true"]` re-enable text selection inside fields where the user is actually typing. Even if the JS handler ever fails to attach, the OS / browser cannot select arbitrary text in the chrome — so a regression like this can no longer manifest.
- **Folder tree now mirrors the active-pane state** — when a pane is the inactive one, the highlighted folder in its tree (top half) renders in the muted `var(--fm-list-inactive-bg)/-fg)` instead of the bright "active" blue. Previously only the file list (bottom half) followed the focus state, so the active pane's tree and the inactive pane's tree both glowed blue, which contradicted the active-pane indicator.
- **Delete key now actually deletes selected files**, and **Shift+Delete** is now accepted as well. Two issues piled up: the keydown handler refused `Shift+Delete` (the common "skip trash" shortcut), and the client-side `confirm()` prompt sat in front of the extension's own modal warning so the user saw a duplicate prompt. The client confirm is now removed — the server-side `showWarningMessage` is the single source of truth.
- **Delete confirmation modal no longer appears twice.** `handleKeydown` is bound on **both `window` and `document`** in capture phase as a belt-and-braces fallback against the browser's default `Ctrl+A`. The `Ctrl+A` branch already called `stopPropagation` to keep the document listener from re-firing, but `Delete`, `F2`, `F5`, and `Enter` only called `preventDefault`, so each keypress dispatched the action twice. For `Delete` this surfaced as a duplicate `deleteItems` message and two stacked `showWarningMessage` modals (the file was deleted by the first, the second sat there orphaned). All four branches now also call `e.stopPropagation()`. Note: `stopImmediatePropagation` alone wouldn't fix this — it only blocks listeners on the *same* `EventTarget`, and `window` and `document` are different targets.

### Security
- **Cryptographically random CSP nonces.** Both `DualPaneWebviewProvider` and `ConnectionEditorProvider` previously generated their `script-src 'nonce-…'` value with `Math.random()` — predictable, collision-prone, and effectively useless as a CSP defense. The nonce is now generated by `crypto.randomBytes(16).toString('base64')` via a shared `makeNonce()` helper.
- **`SftpAdapter.rmdirRecursive` no longer follows symlinks.** A malicious or carelessly placed symlink to another directory on the server could cause recursive delete to traverse outside the requested tree and remove unrelated files. Symlinks are now removed as links, never followed.
- **`npm audit fix`** — `basic-ftp` 5.3.0 → 5.3.1 (DoS via unbounded multiline control responses, GHSA-rpmf-866q-6p89) and `fast-uri` 3.1.0 → 3.1.2 (path-traversal via percent-encoded dots, host confusion via percent-encoded authority delimiters). `npm audit` reports 0 vulnerabilities at any severity.
- **Site Manager Import** — additional per-field validation: `defaultOverwriteRule` must be one of the seven allowed enum values; `autoUploadOnSave` must be a boolean if present.

### Removed
- **Stale `dist/**/*.d.ts`** for already-deleted modules (`DirectoryComparer`, `SyncBrowser`, `OverwriteResolver`, `ThrottleStream`, `TransferModeDetector`) cleaned up; declaration emission is now disabled.
- **`media/icons/light/connect.svg`** — the package only references the dark variant; the unused light SVG and now-empty `media/icons/light/` folder were removed.

## 1.2.0

### Changed
- **Rebranded to "xZ FTP Manager"** across all user-facing surfaces: extension display name, Activity Bar view title, Command Palette category, configuration section, output channels (`xZ FTP Manager`, `xZ FTP Manager - Transfers`), webview panel title, and toast prefixes. Settings keys, command IDs, and the package identifier (`ftp-manager`) are unchanged, so existing user settings and workspace state migrate without action.

### Security
- **Excluded private-key artefacts from VSIX and git.** `.vscodeignore` and `.gitignore` now exclude `invoicevendor`, `*.pem`, `id_rsa`, `id_ed25519` so private-key files cannot end up in a published `.vsix` or be committed by accident.

## 1.1.0

### Added
- **Partial-byte transfer resume** (FTP `REST` / SFTP `{ start: offset }`). Set `defaultOverwriteRule` to `resume` (or pick *Resume* in the per-transfer prompt) and an interrupted transfer continues from the last received byte instead of restarting from zero. Works for both directions:
  - **Download**: server sends from local-file size; local file is reopened with `flags: 'r+', start: offset` so the existing prefix stays intact.
  - **Upload**: local file is read from `remote-size`; server appends via `APPE` (FTP) or seeks-and-writes (SFTP).
- Adapter contract gained an optional `startAt` byte offset on `get()` / `put()`.
- **Active-pane focus model** with keyboard shortcuts:
  - The pane you click becomes "active" (highlighted blue selection); the other pane shows its selection in the muted "inactive" color.
  - **Enter** transfers the selected file(s) — or navigates into a single selected directory.
  - **Ctrl+A** / **Cmd+A** selects every visible entry in the active pane (respecting hidden/filter settings).
- **Multi-connection UI** — every active connection lives in its own VS Code editor tab, with its own current local / remote path, transfer-queue filter (by `connectionId`), search session, and overwrite-prompt resolver. `Site Manager → Connect` on a second profile opens a new tab next to the first.
- **Drag-and-drop in Site Manager** — reorder sites and folders by dragging tree nodes. Drop on a folder → move into; drop outside → move to root. Cycle prevention (no folder into its own descendant).
- **Export / Import Site Manager** — `xZ FTP Manager: Export Sites…` / `Import Sites…`. JSON format includes profiles + tree structure, **without** passwords (SecretStorage is not exported). Import re-issues IDs, merges into the existing tree, validates every field with allowlists and rejects prototype-pollution keys. Export / Import are also reachable from the Site Manager panel's overflow menu (`…` next to *Add Site* / *Add Folder*).
- **Disconnect QuickPick** — when several connections are active, `xZ FTP Manager: Disconnect` prompts which one to drop instead of closing whichever happened to be first.
- **Auto-reconnect** with exponential backoff on unexpected disconnects (network drop, server kicked, socket wedged). Skipped for user-initiated disconnects and ephemeral Quick Connect profiles.
- **`rename` overwrite rule** now actually works: the engine generates `name (1).ext`, `name (2).ext`, … by probing the destination side for the first free name (up to 1000 attempts).
- **Plain FTP runtime warning** in the Connection log when a connection is opened without TLS — the channel is unencrypted and credentials travel in cleartext.
- **Reactive `maxConcurrentTransfers`** — changing the setting now takes effect immediately on the live `TransferQueue`, no extension restart needed.
- **Stale temp cleanup** — `os.tmpdir()/ftp-manager-*` directories older than 24 h are pruned on activate (recovers from prior crashes that skipped `dispose`).
- **Client-side validation in webview filename prompts.** `Rename` / `New folder` context-menu prompts reject empty / `.` / `..` / control / path-separator / Windows-reserved characters and names longer than 255 characters before the round-trip, with a clear `alert()` and the dialog re-opening so you can fix the input. The server-side `assertSafeEntryName` remains the authoritative check.

### Changed
- **Closing a panel tab now disconnects the underlying connection** (and cancels any in-flight transfers for that profile). Previously the socket stayed alive in the background.
- **Auto-reconnect** stops looping on non-transient errors (`auth`, `permission`, `host key`, `fingerprint`). Earlier the loop would retry up to five times even when the password had been changed or the host key had rotated.
- **SFTP** explicitly tears down the underlying socket when the SSH client errors before `ready` (closes a small TCP-leak window).
- **webpack** silences two harmless ssh2 native-addon warnings (`cpu-features`, `sshcrypto.node`) via `IgnorePlugin` — the JS fallback is used regardless.
- **Marketplace polish in `package.json`.** `engines.vscode` raised from `^1.85.0` (Nov 2023) to `^1.90.0` (May 2024). Added `repository: { type: git, url: https://github.com/ghahr/ftp-manager.git }`, so `vsce package` no longer needs `--allow-missing-repository`.
- **VSIX trimmed to runtime-only artefacts** (~10 files, ~170 KB). `.vscodeignore` excludes `.vs/`, `.claude/`, `.vscodeignore` itself, and stale `.d.ts` files in `dist/` left over from removed modules. Earlier packages had been silently bundling Visual Studio's local index cache (≈740 KB).
- `webview.js` shrank from 144 KB → ~45 KB (CSS strings no longer baked in); the new `webview.css` is ~37 KB. Total payload is roughly the same, but with proper cache separation and CSP-clean delivery.

### Fixed
- **Ctrl+A in the active pane no longer leaks into page-wide text selection.** The keydown handler now runs in capture phase, calls `preventDefault` *and* `stopPropagation`, and explicitly clears any existing `Selection` ranges. File table rows also get `user-select: none` so triple-click / drag-select can never produce stray text highlighting that would compete with the row-level "selected" state.
- **`'resume'` overwrite rule with ASCII transfer mode.** Resume is a byte-offset operation; ASCII mode rewrites line endings on the wire so the partial size on disk does not correspond to a byte offset on the server. The engine falls back to a full overwrite for `transferMode === 'ascii'` to avoid producing a half-converted file.

### Security
- **TLSv1.2 minimum** for FTPS (no SSLv3 / TLSv1.0 / TLSv1.1 fallback).
- **SFTP host-key algorithm allowlist** — only modern algorithms accepted (`ssh-ed25519`, `ecdsa-sha2-nistp{256,384,521}`, `rsa-sha2-{256,512}`). `ssh-rsa` (SHA-1) and `ssh-dss` rejected.
- **`crypto.timingSafeEqual`** for host-key fingerprint comparison.
- **Path / entry-name sanitization** on every adapter call (`assertSafeRemotePath`, `assertSafeEntryName`, `assertWithinDirectory`) — defends against CRLF injection, NUL, control bytes, and FTP-Slip on recursive directory walks.
- **ReDoS guard** in remote search: pattern length capped at 256, heuristic detector for catastrophic-backtracking regexes.
- **`crypto.randomUUID`** replaces ad-hoc `Date.now()_Math.random()` ID generation across site / bookmark / panel / connection-editor flows.
- **PASS / USER redaction** in the FTP command-channel log; all `adapter.onLog` events are now actually wired to `LogService` (previously fired into the void).
- **`basic-ftp`** updated past 3 high-severity advisories (CRLF injection, FTP cmd injection, DoS in `Client.list`).
- **CSP `'unsafe-inline'` for `style-src` is gone in both webviews.** The dual-pane webview ships its CSS as a separate `dist/webview/webview.css` (extracted via `mini-css-extract-plugin` instead of injected at runtime by `style-loader`) and loads it through `<link rel="stylesheet">`. The Connection editor's inline `<style>` block was moved to `media/connectionEditor.css`; remaining inline `style="..."` attributes (3× `text-align:left`, 2× `display:none`) became CSS classes, and the show/hide JS was switched from `style.display` mutation to `classList.toggle('is-hidden', …)`. Both webviews now run under a strict `style-src ${webview.cspSource}` (no `'unsafe-inline'`).
- **`err.message` sanitizer for UI toasts.** New `sanitizeForUi()` utility redacts URLs (`<url>`), IPv4/IPv6 with optional port (`<addr>`), and UNC / Windows / POSIX absolute paths (`<path>`) from error messages before they reach `vscode.window.showErrorMessage`. Applied across 12 call sites in `connectionCommands`, `siteManagerCommands`, `searchCommands`, `transferCommands`, `fileCommands`, and `DualPaneWebviewProvider`. The `LogService` channel still receives the unredacted message — only the bottom-right toast (where someone glancing at the screen can read it) is sanitized.
- **`npm audit fix`**: 3 moderate dev-only advisories (postcss <8.5.10, uuid <14, @azure/msal-node) cleared. `postcss` 8.5.8 → 8.5.13, `@azure/msal-node` 5.1.2 → 5.1.5, vulnerable `uuid` removed from the dev tree. No `@vscode/vsce` major bump was required. `npm audit` reports 0 vulnerabilities at any severity.

### Removed
- **`syncBrowsingEnabled`** setting and **`directoryComparisonMethod`** setting. The companion `SyncBrowser` and `DirectoryComparer` modules had been removed earlier; this release also takes out the now-dead config keys, getters, message types (`compareDirectories`, `comparisonResult`, `overwritePrompt`, `toggleSyncBrowsing`, `ComparisonEntry`), and webview state field. Existing settings are simply ignored.
- **Unregistered commands** (`upload`, `download`, `deleteRemote`, `renameRemote`, `mkdirRemote`, `chmodRemote`, `compareDirectories`, `syncBrowsing`) removed from `package.json` — they showed up in the Command Palette only to fail with "command not found."
- **`speedLimitKBps`** setting (was unused after `ThrottleStream` removal).
- Stale/incorrect "Known limitations" notes from the README.

### Documentation
- README rewritten to reflect the current featureset — multi-connection UI, active-pane focus + Enter / Ctrl+A, partial-byte resume, drag-and-drop in Site Manager, Export / Import sites, auto-reconnect with auth-grace, security hardening (TLS 1.2 minimum, modern host-key algorithms, path/entry-name sanitization, ReDoS guard, plain-FTP runtime warning).
- Commands list expanded with Export / Import, Bookmarks (Add / Remove / Go to), Refresh, Toggle Hidden Files, Navigate Remote Path. Disconnect documents the QuickPick behavior on multiple active connections.

## 1.0.0

### Added
- Full-featured dual-pane file browser webview with drag-and-drop between local and remote.
- Site Manager with folders, proper multi-field connection editor (tabs: General / Advanced / Transfer), **Test Connection** and **Browse Key** controls.
- FTP, FTPS (explicit / implicit), SFTP adapters.
- Authentication modes: password, private key, key + password, SSH agent — passphrase field in the editor.
- Transfer queue with pause/resume/cancel (in-flight), retry with exponential backoff, and per-item progress.
- Bookmarks tree and `Navigate Remote Path` command (used by search and bookmarks).
- Remote file search with cancellation.
- Keepalive with consecutive-failure threshold (auto-disconnect when the socket is wedged).
- Security:
  - FTPS certificate validation with an opt-in **Trust self-signed** per-profile flag.
  - SFTP SHA-256 host-key pinning (TOFU) — captured on first connect, strictly enforced afterwards.
  - Passwords and passphrases stored in VS Code `SecretStorage`.
- `lastRemotePath` remembered per profile.
- SFTP short operations have per-op timeouts (connection timeout × 1 s minimum 5 s) so wedged sockets fail fast.
- Schema versioning in storage (v2) with migration from v1.
- **Drag-and-drop between local and remote panes** in the dual-pane browser:
  - Drag a file (or a multi-selection) from one pane and drop it on the other pane to upload / download to the destination's current directory.
  - Drop directly on a folder row in the file list, or on a folder node in the tree, to transfer into that specific folder.
  - Visual feedback while dragging (faded source row, dashed outline on the target pane, highlighted folder under the cursor).
- **Resizable file-list columns**: every column header (Name, Size, Type, Modified, Permissions, Owner) exposes a 6 px drag handle on its right edge. Drag with the mouse to widen or narrow the column; double-click the handle to reset that column to its default width. Each column has a sensible minimum so it cannot collapse to zero. Column widths are persisted per pane (`local` / `remote`) in `localStorage` and survive panel reloads and VS Code restarts. When the total column width exceeds the pane width, the file list scrolls horizontally instead of squeezing cells.
- **Permission editor dialog** for the remote pane. Right-click a remote file or folder → **File Permissions...** opens a modal with:
  - 9 rwx checkboxes (Owner / Group / Other × Read / Write / Execute);
  - editable numeric octal field (e.g. `755`) that stays in sync with the checkboxes;
  - live symbolic preview (e.g. `-rwxr-xr-x`) including the directory `d` prefix;
  - file/folder name shown in the dialog header for context.
  - The submitted mode is sent over `chmod` only when **Apply** is clicked.

### Changed
- **Local pane** no longer shows the **Permissions** and **Owner** columns (Windows-side metadata wasn't meaningful there). Remote pane keeps them.
- Default permission used by the permission dialog falls back to `0o755` for directories and `0o644` for files when the server didn't report a mode.
- **Connection editor (Add Site / Edit Site) is now a modal-style dialog**, matching the look of the remote-pane permission editor:
  - the form is rendered on top of a dimmed backdrop and centered in a bordered card with a soft shadow and a slide-in animation;
  - the card has a fixed maximum width so fields don't stretch across the whole tab anymore;
  - clicking on the dimmed area outside the card cancels (same as the **Cancel** button);
  - all existing controls are preserved — General / Advanced / Transfer tabs, **Test**, **Browse Key**, password / passphrase "Stored — leave blank to keep existing" hints.

### Fixed
- **Central splitter** between local and remote panes is now actually draggable. The pane containers had `flex: 1 1 50%` in CSS which silently overrode the JS-set `width`; the drag handler now sets `flex` directly.
- The legacy `showPermissionDialog` extension → webview message used to send `chmod` with field `path`, but the handler reads `remotePath`, so the request was a no-op. Now sends `remotePath`.
