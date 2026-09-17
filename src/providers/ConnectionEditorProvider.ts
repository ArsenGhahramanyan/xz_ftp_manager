import * as vscode from 'vscode';
import {
    ConnectionProfile,
    Protocol,
    EncryptionMode,
    AuthMethod,
    HostKeyVerifier,
} from '../core/models/interfaces';
import { ConnectionFactory } from '../core/connection/ConnectionFactory';
import { SecretStorageService } from '../services/SecretStorageService';
import { makeId, makeNonce } from '../utils/idUtils';
import { sanitizeForUi } from '../utils/messageSanitizer';

interface EditorPayload {
    profile: ConnectionProfile;
    password: string;          // empty = do not change (in edit) / no password (in add)
    passphrase: string;
}

type EditorResult = EditorPayload | undefined;

interface EditorInit {
    mode: 'add' | 'edit';
    profile: ConnectionProfile;
    hasStoredPassword: boolean;
    hasStoredPassphrase: boolean;
}

type Web2Ext =
    | { type: 'ready' }
    | { type: 'save'; payload: EditorPayload }
    | { type: 'cancel' }
    | { type: 'test'; payload: EditorPayload }
    | { type: 'pickKey' };

type Ext2Web =
    | { type: 'init'; data: EditorInit }
    | { type: 'testResult'; ok: boolean; message: string }
    | { type: 'keyPicked'; path: string };

/**
 * Webview panel for creating / editing a ConnectionProfile.
 *
 * Usage:
 *   const result = await editor.showEditor();                // Add
 *   const result = await editor.showEditor(existingProfile); // Edit
 *
 * Resolves with the edited profile + password/passphrase, or `undefined`
 * when the user cancels or closes the panel.
 */
export class ConnectionEditorProvider implements vscode.Disposable {
    public static readonly viewType = 'ftpManager.connectionEditor';

    private panel: vscode.WebviewPanel | undefined;
    private resolveCurrent: ((v: EditorResult) => void) | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private hostKeyVerifier: HostKeyVerifier | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly secretStorage: SecretStorageService,
    ) {}

    /** Install the same host-key verifier used for real connects, so the
     *  "Test connection" path also verifies the key before sending credentials. */
    setHostKeyVerifier(verifier: HostKeyVerifier): void {
        this.hostKeyVerifier = verifier;
    }

    async showEditor(existing?: ConnectionProfile): Promise<EditorResult> {
        // If another editor is open, focus it and bail.
        if (this.panel) {
            this.panel.reveal();
            return undefined;
        }

        const mode: 'add' | 'edit' = existing ? 'edit' : 'add';
        const profile: ConnectionProfile = existing
            ? { ...existing }
            : defaultProfile();

        const hasStoredPassword = existing
            ? (await this.secretStorage.getPassword(existing.id)) !== undefined
            : false;
        const hasStoredPassphrase = existing
            ? (await this.secretStorage.getPassphrase(existing.id)) !== undefined
            : false;

        this.panel = vscode.window.createWebviewPanel(
            ConnectionEditorProvider.viewType,
            mode === 'add' ? 'New Connection' : `Edit: ${profile.name || 'Connection'}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                ],
            },
        );

        this.panel.iconPath = new vscode.ThemeIcon('server');
        this.panel.webview.html = this.getHtml(this.panel.webview);

        return new Promise<EditorResult>((resolve) => {
            this.resolveCurrent = resolve;

            this.panel!.webview.onDidReceiveMessage(
                (msg: Web2Ext) => this.handleMessage(msg, { mode, profile, hasStoredPassword, hasStoredPassphrase }),
                undefined,
                this.disposables,
            );

            this.panel!.onDidDispose(
                () => {
                    this.panel = undefined;
                    if (this.resolveCurrent) {
                        const r = this.resolveCurrent;
                        this.resolveCurrent = undefined;
                        r(undefined);
                    }
                },
                undefined,
                this.disposables,
            );
        });
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    // ── Message handling ──────────────────────────────────────────────

    private async handleMessage(msg: Web2Ext, init: EditorInit): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.post({ type: 'init', data: init });
                break;

            case 'save': {
                const resolve = this.resolveCurrent;
                this.resolveCurrent = undefined;
                this.panel?.dispose();
                resolve?.(msg.payload);
                break;
            }

            case 'cancel':
                this.panel?.dispose();
                break;

            case 'test':
                await this.testConnection(msg.payload);
                break;

            case 'pickKey': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    openLabel: 'Select Private Key',
                });
                if (picked && picked[0]) {
                    this.post({ type: 'keyPicked', path: picked[0].fsPath });
                }
                break;
            }
        }
    }

    private async testConnection(payload: EditorPayload): Promise<void> {
        // Use an ephemeral id to avoid clashing with a stored profile's connection.
        const ephemeral: ConnectionProfile = {
            ...payload.profile,
            id: makeId('test'),
        };

        const adapter = ConnectionFactory.createAdapter(ephemeral);
        if (this.hostKeyVerifier) {
            adapter.setHostKeyVerifier?.(this.hostKeyVerifier);
        }
        try {
            await adapter.connect(ephemeral, payload.password || undefined, payload.passphrase || undefined);
            await adapter.disconnect().catch(() => { /* best effort */ });
            this.post({
                type: 'testResult',
                ok: true,
                message: `Connected to ${ephemeral.host}:${ephemeral.port} successfully.`,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'testResult', ok: false, message: sanitizeForUi(message) });
        } finally {
            adapter.dispose();
        }
    }

    private post(msg: Ext2Web): void {
        this.panel?.webview.postMessage(msg);
    }

    // ── HTML ──────────────────────────────────────────────────────────

    private getHtml(webview: vscode.Webview): string {
        const nonce = makeNonce();
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'connectionEditor.css'),
        );
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<title>Connection</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div class="modal-overlay" id="overlay">
<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="title">
  <h2 id="title">Connection</h2>

  <div class="tabs" role="tablist">
    <button class="tab active" data-tab="general" type="button">General</button>
    <button class="tab" data-tab="advanced" type="button">Advanced</button>
    <button class="tab" data-tab="transfer" type="button">Transfer</button>
  </div>

  <!-- ── General ─────────────────────────────────────────────────── -->
  <div class="panel active" id="panel-general">
    <div class="row"><label for="name">Name</label>
      <input id="name" type="text" placeholder="My Server" autofocus>
    </div>

    <div class="row"><label for="protocol">Protocol</label>
      <select id="protocol">
        <option value="sftp">SFTP — SSH File Transfer Protocol</option>
        <option value="ftp">FTP</option>
        <option value="ftps">FTPS — FTP over TLS</option>
      </select>
    </div>

    <div class="row" id="row-encryption"><label for="encryption">Encryption</label>
      <select id="encryption" title="Explicit upgrades a plain FTP control connection to TLS via AUTH TLS (typical port 21). Implicit opens a TLS connection from the start on a dedicated port (typical 990).">
        <option value="explicit">Require explicit FTP over TLS</option>
        <option value="implicit">Require implicit FTP over TLS</option>
        <option value="none">Only use plain FTP (insecure)</option>
      </select>
    </div>

    <div class="row" id="row-trust"><label for="trustSelfSigned">Certificate</label>
      <div class="checkbox-row">
        <input id="trustSelfSigned" type="checkbox"
               title="When checked, the server's TLS certificate is not validated against the OS trust store. Use only for servers you know personally; enables MITM attacks otherwise.">
        <label for="trustSelfSigned" class="label-left">
          Trust self-signed / untrusted certificates (insecure)
        </label>
      </div>
    </div>

    <div class="row"><label for="host">Host</label>
      <input id="host" type="text" placeholder="example.com">
    </div>

    <div class="row"><label for="port">Port</label>
      <input id="port" type="number" min="1" max="65535">
    </div>

    <div class="row"><label for="authMethod">Logon Type</label>
      <select id="authMethod" title="Password: prompt for server password. Key file: authenticate with a private key (optionally protected by a passphrase). Key + password: some servers require both. SSH agent: use the running OS agent (SSH_AUTH_SOCK).">
        <option value="password">Password</option>
        <option value="privateKey">Key file</option>
        <option value="keyAndPassword">Key + password</option>
        <option value="sshAgent">SSH agent</option>
      </select>
    </div>

    <div class="row"><label for="username">User</label>
      <input id="username" type="text" placeholder="user" autocomplete="off">
    </div>

    <div class="row" id="row-password"><label for="password">Password</label>
      <input id="password" type="password" autocomplete="new-password">
    </div>
    <div class="row is-hidden" id="row-password-hint">
      <span></span><span class="hint" id="password-hint"></span>
    </div>

    <div class="row row-wide" id="row-key"><label for="keyPath">Key file</label>
      <input id="keyPath" type="text" placeholder="C:\\Users\\me\\.ssh\\id_rsa">
      <button id="pickKeyBtn" class="pick-btn" type="button">Browse…</button>
    </div>

    <div class="row" id="row-passphrase"><label for="passphrase">Passphrase</label>
      <input id="passphrase" type="password" autocomplete="new-password">
    </div>
    <div class="row is-hidden" id="row-passphrase-hint">
      <span></span><span class="hint" id="passphrase-hint"></span>
    </div>
  </div>

  <!-- ── Advanced ────────────────────────────────────────────────── -->
  <div class="panel" id="panel-advanced">
    <div class="row"><label for="initialRemote">Default remote dir</label>
      <input id="initialRemote" type="text" placeholder="/" title="The remote directory to open on connect (unless a last-visited path has been remembered for this profile).">
    </div>
    <div class="row"><label for="initialLocal">Default local dir</label>
      <input id="initialLocal" type="text" placeholder="(workspace)" title="Starting folder for the local pane. Leave empty to use the current workspace root.">
    </div>
    <div class="row"><label for="timeout">Timeout (sec)</label>
      <input id="timeout" type="number" min="1" max="600" title="Socket / operation timeout. Also used as the SFTP short-operation timeout.">
    </div>
    <div class="row"><label for="keepaliveEnabled">Keepalive</label>
      <div class="checkbox-row">
        <input id="keepaliveEnabled" type="checkbox" title="When enabled, the extension periodically sends PWD/NOOP so idle servers do not drop the connection. After three consecutive failures the connection is force-closed.">
        <label for="keepaliveEnabled" class="label-left">Send NOOP periodically</label>
      </div>
    </div>
    <div class="row"><label for="keepaliveInterval">Interval (sec)</label>
      <input id="keepaliveInterval" type="number" min="10" max="3600" title="How often to send the keepalive ping. Shorter intervals catch dropped sockets faster but add traffic.">
    </div>
    <div class="row"><label for="encoding">Encoding</label>
      <select id="encoding">
        <option value="utf-8">UTF-8</option>
        <option value="latin1">ISO-8859-1 (latin1)</option>
        <option value="cp1251">Windows-1251 (Cyrillic)</option>
        <option value="gbk">GBK</option>
        <option value="shift_jis">Shift_JIS</option>
      </select>
    </div>
    <div class="row" id="row-legacy-hostkey"><label for="allowLegacyHostKey">Host key</label>
      <div class="checkbox-row">
        <input id="allowLegacyHostKey" type="checkbox"
               title="Also accept the deprecated SHA-1 host-key algorithms (ssh-rsa, ssh-dss). Needed for old servers that fail the handshake with 'no matching host key format'. Modern algorithms are still preferred when the server supports them.">
        <label for="allowLegacyHostKey" class="label-left">
          Allow legacy SHA-1 host key algorithms (ssh-rsa / ssh-dss)
        </label>
      </div>
    </div>
    <div class="row" id="row-passive"><label for="passive">Passive mode</label>
      <div class="checkbox-row">
        <input id="passive" type="checkbox" title="PASV: the client opens data connections to the server. Leave enabled unless your server only supports active mode (the client listens for incoming data sockets).">
        <label for="passive" class="label-left">Use passive (PASV) connections</label>
      </div>
    </div>
  </div>

  <!-- ── Transfer ────────────────────────────────────────────────── -->
  <div class="panel" id="panel-transfer">
    <div class="row"><label for="transferMode">Transfer mode</label>
      <select id="transferMode" title="Binary preserves bytes exactly; ASCII does line-ending conversion between Unix and Windows. Auto picks ASCII for extensions listed in the asciiFileExtensions setting.">
        <option value="auto">Auto (use extension list)</option>
        <option value="binary">Binary</option>
        <option value="ascii">ASCII</option>
      </select>
    </div>
    <div class="row"><label for="maxConcurrent">Max concurrent</label>
      <input id="maxConcurrent" type="number" min="1" max="10" title="Per-profile transfer concurrency cap. Most servers accept 2–4 parallel streams; going higher can trigger rate limiting.">
    </div>
    <div class="row"><label for="overwriteRule">Overwrite rule</label>
      <select id="overwriteRule" title="Per-site override for the workspace defaultOverwriteRule setting. Choose Use global to inherit.">
        <option value="">Use global setting</option>
        <option value="ask">Ask before overwrite</option>
        <option value="overwrite">Always overwrite</option>
        <option value="skip">Skip existing</option>
        <option value="rename">Rename to unique</option>
        <option value="overwriteIfNewer">Overwrite if source newer</option>
        <option value="overwriteIfSizeDiffers">Overwrite if size differs</option>
        <option value="resume">Resume from last byte</option>
      </select>
    </div>
    <div class="row"><label for="autoUploadOverride">Auto-upload on save</label>
      <select id="autoUploadOverride" title="Per-site override for the workspace autoUploadOnSave setting. Disable on production sites where silent re-uploads are dangerous.">
        <option value="">Use global setting</option>
        <option value="on">Enabled</option>
        <option value="off">Disabled</option>
      </select>
    </div>
  </div>

  <!-- ── Footer ──────────────────────────────────────────────────── -->
  <div class="footer">
    <span id="status" class="status"></span>
    <button id="testBtn"   class="btn" type="button">Test</button>
    <button id="cancelBtn" class="btn" type="button">Cancel</button>
    <button id="saveBtn"   class="btn primary" type="button">OK</button>
  </div>
</div>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  let state = {
    mode: 'add',
    profile: null,
    hasStoredPassword: false,
    hasStoredPassphrase: false,
  };

  // ── Element refs ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    title:              $('title'),
    name:               $('name'),
    protocol:           $('protocol'),
    encryption:         $('encryption'),
    rowEncryption:      $('row-encryption'),
    trustSelfSigned:    $('trustSelfSigned'),
    rowTrust:           $('row-trust'),
    host:               $('host'),
    port:               $('port'),
    authMethod:         $('authMethod'),
    username:           $('username'),
    password:           $('password'),
    rowPassword:        $('row-password'),
    rowPasswordHint:    $('row-password-hint'),
    passwordHint:       $('password-hint'),
    keyPath:            $('keyPath'),
    rowKey:             $('row-key'),
    pickKeyBtn:         $('pickKeyBtn'),
    passphrase:         $('passphrase'),
    rowPassphrase:      $('row-passphrase'),
    rowPassphraseHint:  $('row-passphrase-hint'),
    passphraseHint:     $('passphrase-hint'),
    initialRemote:      $('initialRemote'),
    initialLocal:       $('initialLocal'),
    timeout:            $('timeout'),
    keepaliveEnabled:   $('keepaliveEnabled'),
    keepaliveInterval:  $('keepaliveInterval'),
    encoding:           $('encoding'),
    passive:            $('passive'),
    rowPassive:         $('row-passive'),
    allowLegacyHostKey: $('allowLegacyHostKey'),
    rowLegacyHostKey:   $('row-legacy-hostkey'),
    transferMode:       $('transferMode'),
    maxConcurrent:      $('maxConcurrent'),
    overwriteRule:      $('overwriteRule'),
    autoUploadOverride: $('autoUploadOverride'),
    status:             $('status'),
    testBtn:            $('testBtn'),
    cancelBtn:          $('cancelBtn'),
    saveBtn:            $('saveBtn'),
  };

  // ── Tabs ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    });
  });

  // ── Protocol / auth reactivity ───────────────────────────────────
  function updateProtocolFields() {
    const proto = els.protocol.value;
    const isFtps = proto === 'ftps';
    const isSftp = proto === 'sftp';

    els.rowEncryption.style.display = isFtps ? '' : 'none';
    els.rowTrust.style.display      = isFtps ? '' : 'none';
    els.rowPassive.style.display    = isSftp ? 'none' : '';
    els.rowLegacyHostKey.style.display = isSftp ? '' : 'none';

    // Default port hint (only change if port is empty or matches previous default)
    const defaults = { sftp: 22, ftp: 21, ftps: 21 };
    const cur = parseInt(els.port.value, 10);
    if (!cur || cur === 22 || cur === 21 || cur === 990) {
      els.port.value = String(defaults[proto]);
    }

    updateAuthFields();
  }

  function updateAuthFields() {
    const proto = els.protocol.value;
    const method = els.authMethod.value;
    const isSftp = proto === 'sftp';

    // Non-SFTP -> force password
    if (!isSftp && method !== 'password') {
      els.authMethod.value = 'password';
    }
    Array.from(els.authMethod.options).forEach(opt => {
      opt.disabled = !isSftp && opt.value !== 'password';
    });

    const m = els.authMethod.value;
    const needsPassword = m === 'password' || m === 'keyAndPassword';
    const needsKey      = m === 'privateKey' || m === 'keyAndPassword';

    els.rowPassword.style.display   = needsPassword ? '' : 'none';
    els.rowKey.style.display        = needsKey ? '' : 'none';
    els.rowPassphrase.style.display = needsKey ? '' : 'none';

    const showPasswordHint = needsPassword && state.mode === 'edit' && state.hasStoredPassword;
    els.rowPasswordHint.classList.toggle('is-hidden', !showPasswordHint);
    if (showPasswordHint) {
      els.passwordHint.textContent = 'Stored — leave blank to keep existing.';
    }

    const showPassphraseHint = needsKey && state.mode === 'edit' && state.hasStoredPassphrase;
    els.rowPassphraseHint.classList.toggle('is-hidden', !showPassphraseHint);
    if (showPassphraseHint) {
      els.passphraseHint.textContent = 'Stored — leave blank to keep existing.';
    }
  }

  els.protocol.addEventListener('change', updateProtocolFields);
  els.authMethod.addEventListener('change', updateAuthFields);

  // ── Key picker ───────────────────────────────────────────────────
  els.pickKeyBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickKey' }));

  // ── Validation ───────────────────────────────────────────────────
  function validate() {
    if (!els.name.value.trim()) return 'Name is required.';
    if (!els.host.value.trim()) return 'Host is required.';
    const port = parseInt(els.port.value, 10);
    if (!(port > 0 && port <= 65535)) return 'Port must be 1–65535.';
    if (!els.username.value.trim() && els.authMethod.value !== 'sshAgent') {
      return 'User is required.';
    }
    if ((els.authMethod.value === 'privateKey' || els.authMethod.value === 'keyAndPassword') && !els.keyPath.value.trim()) {
      return 'Key file path is required.';
    }
    const to = parseInt(els.timeout.value, 10);
    if (!(to >= 1 && to <= 600)) return 'Timeout must be 1–600.';
    const mc = parseInt(els.maxConcurrent.value, 10);
    if (!(mc >= 1 && mc <= 10)) return 'Max concurrent must be 1–10.';
    return null;
  }

  function collect() {
    const proto = els.protocol.value;
    const profile = {
      ...state.profile,
      name:         els.name.value.trim(),
      protocol:     proto,
      host:         els.host.value.trim(),
      port:         parseInt(els.port.value, 10),
      username:     els.username.value.trim(),
      encryptionMode: proto === 'ftps' ? els.encryption.value : 'none',
      trustSelfSigned: proto === 'ftps' ? els.trustSelfSigned.checked : undefined,
      authMethod:   els.authMethod.value,
      privateKeyPath: els.keyPath.value.trim() || undefined,
      transferMode: els.transferMode.value,
      initialRemotePath: els.initialRemote.value.trim() || '/',
      initialLocalPath:  els.initialLocal.value.trim() || undefined,
      keepalive: {
        enabled: els.keepaliveEnabled.checked,
        intervalSeconds: parseInt(els.keepaliveInterval.value, 10) || 60,
      },
      timeoutSeconds:         parseInt(els.timeout.value, 10) || 30,
      maxConcurrentTransfers: parseInt(els.maxConcurrent.value, 10) || 2,
      encoding: els.encoding.value,
      passiveMode: els.passive.checked,
      allowLegacyHostKeyAlgorithms: proto === 'sftp' ? els.allowLegacyHostKey.checked : undefined,
      defaultOverwriteRule: els.overwriteRule.value || undefined,
      autoUploadOnSave:
        els.autoUploadOverride.value === 'on' ? true :
        els.autoUploadOverride.value === 'off' ? false :
        undefined,
    };
    return {
      profile,
      password:   els.password.value,    // empty => keep existing (edit) / no pw (add)
      passphrase: els.passphrase.value,  // same rule
    };
  }

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ── Buttons ──────────────────────────────────────────────────────
  els.saveBtn.addEventListener('click', () => {
    const err = validate();
    if (err) { setStatus(err, 'err'); return; }
    setStatus('');
    vscode.postMessage({ type: 'save', payload: collect() });
  });

  els.cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  // Click on the overlay backdrop (outside the dialog card) cancels.
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) {
        vscode.postMessage({ type: 'cancel' });
      }
    });
  }

  els.testBtn.addEventListener('click', () => {
    const err = validate();
    if (err) { setStatus(err, 'err'); return; }
    setStatus('Testing…', 'busy');
    els.testBtn.disabled = true;
    els.saveBtn.disabled = true;
    vscode.postMessage({ type: 'test', payload: collect() });
  });

  // Enter to save from single-line inputs; Escape to cancel.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    } else if (ev.key === 'Enter' && ev.target && ev.target.tagName === 'INPUT' && ev.target.type !== 'textarea') {
      els.saveBtn.click();
    }
  });

  // ── Incoming messages ────────────────────────────────────────────
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'init') {
      state = msg.data;
      els.title.textContent = state.mode === 'add' ? 'New Connection' : 'Edit Connection';
      const p = state.profile;

      els.name.value             = p.name || '';
      els.protocol.value         = p.protocol || 'sftp';
      els.encryption.value       = p.encryptionMode || 'explicit';
      els.trustSelfSigned.checked = !!p.trustSelfSigned;
      els.host.value             = p.host || '';
      els.port.value             = String(p.port || 22);
      els.authMethod.value       = p.authMethod || 'password';
      els.username.value         = p.username || '';
      els.password.value         = '';
      els.passphrase.value       = '';
      els.keyPath.value          = p.privateKeyPath || '';
      els.initialRemote.value    = p.initialRemotePath || '/';
      els.initialLocal.value     = p.initialLocalPath || '';
      els.timeout.value          = String(p.timeoutSeconds ?? 30);
      els.keepaliveEnabled.checked = !!(p.keepalive && p.keepalive.enabled);
      els.keepaliveInterval.value  = String((p.keepalive && p.keepalive.intervalSeconds) || 60);
      els.encoding.value         = p.encoding || 'utf-8';
      els.passive.checked        = p.passiveMode !== false;
      els.allowLegacyHostKey.checked = !!p.allowLegacyHostKeyAlgorithms;
      els.transferMode.value     = p.transferMode || 'auto';
      els.maxConcurrent.value    = String(p.maxConcurrentTransfers ?? 2);
      els.overwriteRule.value    = p.defaultOverwriteRule || '';
      els.autoUploadOverride.value =
        p.autoUploadOnSave === true ? 'on' :
        p.autoUploadOnSave === false ? 'off' :
        '';

      updateProtocolFields();
      setTimeout(() => els.name.focus(), 0);
    } else if (msg.type === 'testResult') {
      els.testBtn.disabled = false;
      els.saveBtn.disabled = false;
      setStatus(msg.message, msg.ok ? 'ok' : 'err');
    } else if (msg.type === 'keyPicked') {
      els.keyPath.value = msg.path;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

function defaultProfile(): ConnectionProfile {
    return {
        id: makeId('profile'),
        name: '',
        protocol: 'sftp' as Protocol,
        host: '',
        port: 22,
        username: '',
        encryptionMode: 'explicit' as EncryptionMode,
        authMethod: 'password' as AuthMethod,
        transferMode: 'auto',
        initialRemotePath: '/',
        keepalive: { enabled: true, intervalSeconds: 60 },
        timeoutSeconds: 30,
        maxConcurrentTransfers: 2,
        encoding: 'utf-8',
        passiveMode: true,
    };
}

