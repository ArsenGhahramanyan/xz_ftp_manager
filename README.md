# xZ FTP Manager

[![CI](https://github.com/ArsenGhahramanyan/xz_ftp_manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ArsenGhahramanyan/xz_ftp_manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC.svg)](https://code.visualstudio.com/)

Full-featured FTP / FTPS / SFTP client for VS Code.

A dual-pane file browser, a Site Manager with persistent profiles, secure credential storage, partial-byte transfer **resume**, and ergonomic keyboard shortcuts. One panel per connection, multiple connections at once.

No telemetry, no phone-home: the extension talks only to the servers you configure.

## Install

The extension is not on the Marketplace yet — install it from a VSIX:

1. Download the latest `ftp-manager-<version>.vsix` from the [Releases](https://github.com/ArsenGhahramanyan/xz_ftp_manager/releases) page, or build one yourself (see [Development](#development)).
2. In VS Code run **Extensions: Install from VSIX…** from the Command Palette and pick the file.
3. Reload the window. The **xZ FTP Manager** icon appears in the Activity Bar.

Requires VS Code 1.90 or newer. Node.js 20+ is needed only to build from source.

## Features

### Browser & navigation
- **Dual-pane file browser** — local and remote side-by-side. The central splitter is fully draggable; each pane has its own folder-tree / file-list horizontal split that is also draggable.
- **Multiple simultaneous connections** — every active connection lives in its own VS Code editor tab (with its own current path, transfer queue filter, and search state). Open `Site Manager → Connect` on a second profile and a new tab opens next to the first.
- **Active-pane focus model** — the pane you click becomes "active" (blue selection). The other pane keeps its selection in a muted "inactive" gray, so you always see what's selected on both sides.
- **Keyboard shortcuts** — **Enter** transfers the selection in the active pane (or navigates into a single highlighted folder); **Ctrl+A** / **Cmd+A** selects every visible entry in the active pane (respecting the hidden-files toggle and any name filter). Ctrl+A is scoped to the active pane only — it never bleeds into page-wide text selection.
- **Drag-and-drop between panes** — drop a file (or multi-selection) on the opposite pane, on a folder row, or on a folder in the tree. Visual feedback while dragging; works in either direction.
- **Resizable, persistent file-list columns** — drag the right edge of any column header to resize, double-click to reset. Widths are stored per pane (`local` / `remote`) and survive reloads. Local pane shows Name / Size / Type / Modified; remote pane additionally shows Permissions / Owner.

### Connections
- **Site Manager** with folders (**FTP**, **FTPS** and **SFTP** are created for you on first run), **drag-and-drop** to reorganize the tree, **Export / Import** profiles as JSON (passwords are not exported — they live in SecretStorage and have to be re-entered), and a multi-field **modal connection editor** (General / Advanced / Transfer tabs, **Test Connection**, **Browse Key**, contextual tooltips).
- **Protocols** — FTP, FTP-over-TLS (FTPS, explicit/implicit), SFTP.
- **Authentication** — password, private key, key + password, SSH agent. Per-profile passphrase field.
- **Quick Connect** bar in the panel header for one-off password-only connections.
- **Auto-reconnect** with exponential backoff on unexpected disconnects. The loop stops on non-transient errors (auth failure, host-key mismatch) so a bad password never spams retries.
- **Keepalive** with consecutive-failure threshold — three failures in a row force a disconnect instead of silently sitting on a wedged socket.
- **Closing a panel tab disconnects** the underlying connection (and cancels any in-flight transfers for that profile). No more zombie sockets in the background.

### Transfers
- **Transfer queue** — pause, resume, cancel (in-flight), retry, configurable concurrency, per-item progress with bytes-per-second.
- **Partial-byte resume** — set `defaultOverwriteRule` to `resume` (or pick *Resume* in the per-transfer prompt) and an interrupted transfer continues from the last received byte. Implemented via FTP `REST` (`appendFrom` for upload) and SFTP `createReadStream/createWriteStream` with `start: offset`.
- **Smart overwrite rules** — `overwrite`, `skip`, `rename` (auto-suffix `name (1).ext` …), `ask` (modal prompt), `overwriteIfNewer` (mtime-based), `overwriteIfSizeDiffers`, `resume`.
- **Recursive directory transfer** — uploads / downloads of folders are decomposed into per-file queue items, each respecting the chosen overwrite rule.
- **Auto-upload on save** — files opened from the remote pane are temp-cached locally; saving the buffer re-uploads.

### Search
- **Recursive remote search** — breadth-first, cancellable, with regex / case / size / date filters. Results open via `Navigate Remote Path` so a click on a hit lands you in the matching folder in the panel.

### Permissions
- **Remote permission editor** — right-click a remote file or folder → **File Permissions...** opens a modal with 9 rwx checkboxes (Owner / Group / Other × Read / Write / Execute), an editable octal field (e.g. `755`), and a live `-rwxr-xr-x` symbolic preview.

### Security
- **FTPS certificate validation** with an opt-in *Trust self-signed* per-profile flag.
- **TLSv1.2 minimum** for FTPS (no SSLv3 / TLSv1.0 / TLSv1.1 fallback).
- **SFTP host-key pinning (TOFU)** — first connect prompts the user with a SHA-256 fingerprint and a *Trust and Save / Disconnect* choice. Subsequent connects compare with `crypto.timingSafeEqual` and refuse on mismatch.
- **SFTP host-key algorithm allowlist** — only modern algorithms are accepted (`ssh-ed25519`, `ecdsa-sha2-nistp{256,384,521}`, `rsa-sha2-{256,512}`). `ssh-rsa` (SHA-1) and `ssh-dss` are rejected.
- **Passwords and passphrases in VS Code SecretStorage** — never written to settings or profile JSON.
- **Path / entry-name sanitization** — every adapter call validates against CRLF injection, null bytes, control characters, and `..` traversal. FTP-Slip protection on recursive directory walks.
- **Plain-FTP runtime warning** — opening a `protocol: ftp` connection logs an explicit ⚠ in the Connection log; credentials and data on the wire are unencrypted.
- **ReDoS guard** in remote search — pattern length capped, catastrophic-backtracking heuristic refuses nested-quantifier regexes.
- **Stale temp cleanup** — `os.tmpdir()/ftp-manager-*` directories older than 24 h are pruned on activate.

### Privacy
- **No telemetry, no analytics, no phone-home.** The extension makes no network connections other than to the FTP/FTPS/SFTP servers you configure.
- **Your data stays local.** Profiles live in VS Code's `globalState`; passwords and passphrases live in VS Code SecretStorage. Nothing is sent to the author or any third party.

### Quality of life
- **Last remote path remembered** per profile.
- **Configurable log levels** with redaction of `PASS` / `USER` lines in FTP command chatter.
- **Reactive concurrency** — changing `maxConcurrentTransfers` in settings takes effect immediately, no restart.
- **Lazy activation** — the extension loads only when you open its view or run one of its commands, not on every VS Code start.

## Getting started

1. Open the **xZ FTP Manager** view in the Activity Bar.
2. Click the **+** in the *Site Manager* to open the connection editor.
3. Fill in protocol, host, user, auth method; use **Test** to verify; **OK** to save.
4. Right-click the site → **Connect**. The dual-pane browser opens automatically.

## Commands (Command Palette)

- `xZ FTP Manager: Open xZ FTP Manager` — show the dual-pane panel.
- `xZ FTP Manager: Connect` / `Disconnect` / `Quick Connect`. Disconnect on multiple active connections shows a QuickPick.
- `xZ FTP Manager: Add Site` / `Edit Site` / `Delete Site` / `Add Folder`.
- `xZ FTP Manager: Export Sites…` / `Import Sites…` (JSON, passwords excluded).
- `xZ FTP Manager: Search Remote Files`.
- `xZ FTP Manager: Pause / Resume / Cancel / Retry Transfer` (single and bulk).
- `xZ FTP Manager: Refresh` / `Toggle Hidden Files`.
- `xZ FTP Manager: Show Connection Log` / `Show Transfer Log`.
- `xZ FTP Manager: Navigate Remote Path` (used internally by search).

Context-menu actions for files inside the panel are delivered via the webview UI (not the Command Palette) — right-click items in either pane.

## Settings

All settings live under `ftpManager.*`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `defaultLocalDirectory` | `""` | Starting folder for the local pane. |
| `showHiddenFiles` | `false` | Show files beginning with `.`. |
| `transferMode` | `auto` | `auto`, `binary`, or `ascii`. |
| `maxConcurrentTransfers` | `2` | 1–10. Reactive — changes apply live. |
| `defaultOverwriteRule` | `ask` | `overwrite`, `skip`, `rename`, `ask`, `overwriteIfNewer`, `overwriteIfSizeDiffers`, `resume`. |
| `preserveTimestamp` | `true` | Keep file mtime on transfer. |
| `asciiFileExtensions` | (list) | Extensions treated as text in `auto` mode. |
| `connectionTimeout` | `30` | Seconds. |
| `keepaliveInterval` | `60` | Seconds; `0` disables. Three consecutive failures force a disconnect. |
| `retryCount` | `3` | Retries per transfer on transient errors. |
| `retryDelay` | `5` | Base delay (s) for exponential backoff (`d * 2^attempt`). |
| `logLevel` | `info` | `off`, `error`, `info`, `debug`. |
| `autoUploadOnSave` | `true` | Upload edited temp files on save. |

## Development

```bash
npm install
npm run compile      # production webpack build (extension + webview)
npm run watch        # dev build with source maps
npx @vscode/vsce package --allow-missing-repository --out vsix   # produce vsix/ftp-manager-<version>.vsix
```

Install the packaged VSIX via **Extensions: Install from VSIX…**.

## Architecture (short)

- `src/` — extension host (Node): protocol adapters (`basic-ftp`, `ssh2`), transfer queue / engine with retry + resume, connection manager, the Site Manager tree provider, command registrations.
- `webview/src/` — browser-side vanilla-TS dual-pane UI with an observable `Store`, typed `postMessage` protocol, drag state, and per-pane `FilePane → Toolbar / FolderTree / FileList` composition.
- `src/providers/ConnectionEditorProvider.ts` — self-contained webview for creating / editing profiles, rendered as a modal dialog (overlay + centered card) with live Test Connection.
- `src/providers/DualPaneWebviewProvider.ts` — owns one `PanelSession` per connection, broadcasts queue snapshots filtered by `connectionId`, routes messages from each panel to the right session.

webpack ships two bundles: `dist/extension.js` (Node) and `dist/webview/webview.js` (browser). VSIX is runtime-only — 10 files, ~170 KB.

## Known limitations

- **Pause does not interrupt an active transfer.** Pausing holds queued items and updates the UI, but a transfer that is already streaming runs to completion in the background — only *Cancel* aborts in-flight I/O — and resuming re-transfers from the start. A true mid-stream pause is feasible for SFTP and is on the roadmap.
- Recursive transfers do not currently snapshot the in-progress directory tree to disk, so resuming a partially-completed *folder* download starts the directory walk over (individual files inside still resume correctly).
- Plain FTP/FTPS run a single transfer at a time per connection (the `basic-ftp` client has one data channel); the per-connection concurrency cap only parallelises SFTP. Cancelling an FTP transfer tears down and reconnects the control socket.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/ArsenGhahramanyan/xz_ftp_manager.git
cd xz_ftp_manager
npm install
npm run watch        # then press F5 in VS Code to launch the Extension Host
```

Before opening a PR, please make sure the same checks CI runs pass locally:

```bash
npm run typecheck
npm run lint
npm test
npm run compile
```

Bug reports are most useful with the protocol (FTP / FTPS / SFTP), the server software, and the relevant lines from **xZ FTP Manager: Show Connection Log** (log lines redact `USER` / `PASS`, but please re-read them before pasting).

Notable changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Arsen Ghahramanyan
