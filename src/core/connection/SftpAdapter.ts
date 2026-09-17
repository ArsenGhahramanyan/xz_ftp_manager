import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    Client as SSHClient,
    SFTPWrapper,
    ConnectConfig,
    FileEntry as SSH2DirEntry,
    ServerHostKeyAlgorithm,
    Stats,
} from 'ssh2';
import {
    ConnectionProfile,
    FileEntry,
    HostKeyVerifier,
    IProtocolAdapter,
    ProgressCallback,
    ProtocolCapabilities,
} from '../models/interfaces';
import { assertSafeRemotePath } from '../../utils/pathUtils';

export class SftpAdapter implements IProtocolAdapter {
    // ssh2 multiplexes channels over one connection, so concurrent transfers
    // are safe, and a single stream can be destroyed to pause without closing
    // the session.
    public readonly capabilities: ProtocolCapabilities = {
        concurrentTransfers: true,
        pauseResume: true,
    };

    private sshClient: SSHClient | null = null;
    private sftp: SFTPWrapper | null = null;
    private _connected = false;
    private _hostKeyVerifier: HostKeyVerifier | undefined;
    /** Timeout (ms) applied to short SFTP ops; captured from profile at connect time. */
    private _opTimeoutMs = 30_000;

    setHostKeyVerifier(verifier: HostKeyVerifier): void {
        this._hostKeyVerifier = verifier;
    }

    private readonly _onDidDisconnect = new vscode.EventEmitter<{ reason: string; expected?: boolean }>();
    public readonly onDidDisconnect = this._onDidDisconnect.event;

    private readonly _onLog = new vscode.EventEmitter<{ level: 'info' | 'command' | 'response' | 'error'; message: string }>();
    public readonly onLog = this._onLog.event;

    async connect(profile: ConnectionProfile, password?: string, passphrase?: string): Promise<void> {
        this._opTimeoutMs = Math.max(5_000, profile.timeoutSeconds * 1000);
        return new Promise<void>((resolve, reject) => {
            this.sshClient = new SSHClient();

            const pinned = profile.pinnedHostKey?.toLowerCase();
            // Modern, RFC-compliant host-key algorithms. ssh2's own default
            // still accepts ssh-rsa with SHA-1, deprecated by RFC 8332.
            const serverHostKey: ServerHostKeyAlgorithm[] = [
                'ssh-ed25519',
                'ecdsa-sha2-nistp256',
                'ecdsa-sha2-nistp384',
                'ecdsa-sha2-nistp521',
                'rsa-sha2-512',
                'rsa-sha2-256',
            ];
            // Opt-in escape hatch: appliances that predate RFC 8332 offer only
            // the SHA-1 variants, and the handshake dies with "no matching host
            // key format" before auth. Appended last so a modern algorithm is
            // still preferred whenever the server supports one.
            if (profile.allowLegacyHostKeyAlgorithms) {
                serverHostKey.push('ssh-rsa', 'ssh-dss');
            }
            const config: ConnectConfig = {
                host: profile.host,
                port: profile.port,
                username: profile.username,
                readyTimeout: profile.timeoutSeconds * 1000,
                algorithms: { serverHostKey },
                // ssh2 invokes hostVerifier DURING key exchange, before any
                // authentication. Verifying here — and, for unknown keys,
                // prompting the user before calling `verify(true)` — guarantees
                // the password/key is never sent to an unverified host.
                hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
                    const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
                    const fp = crypto.createHash('sha256').update(buf).digest('hex');
                    if (pinned) {
                        const a = Buffer.from(pinned, 'utf8');
                        const b = Buffer.from(fp, 'utf8');
                        const match = a.length === b.length && crypto.timingSafeEqual(a, b);
                        if (!match) {
                            this._onLog.fire({
                                level: 'error',
                                message: `Host key fingerprint mismatch for ${profile.host}! Expected ${pinned}, got ${fp}.`,
                            });
                        }
                        verify(match);
                        return;
                    }
                    // Unknown host: ask the injected verifier (which prompts the
                    // user and persists a trusted key) BEFORE auth proceeds.
                    if (this._hostKeyVerifier) {
                        this._hostKeyVerifier({
                            profileId: profile.id,
                            host: profile.host,
                            port: profile.port,
                            fingerprint: fp,
                        }).then(
                            (trusted) => verify(trusted),
                            () => verify(false),
                        );
                        return;
                    }
                    // No verifier wired (defensive): refuse rather than silently
                    // trusting an unknown key and leaking credentials.
                    this._onLog.fire({
                        level: 'error',
                        message: `No host-key verifier available for ${profile.host}; refusing unverified key.`,
                    });
                    verify(false);
                },
            };

            // Auth method
            switch (profile.authMethod) {
                case 'password':
                    config.password = password;
                    // Some servers only offer "password" via keyboard-interactive
                    // (PAM). Enable it and answer non-echo prompts with the
                    // supplied password so those servers work without a new
                    // auth method. Multi-prompt 2FA still needs manual setup.
                    config.tryKeyboard = true;
                    break;
                case 'privateKey': {
                    if (!profile.privateKeyPath) {
                        reject(new Error('Private key path is required'));
                        return;
                    }
                    config.privateKey = fs.readFileSync(profile.privateKeyPath);
                    if (passphrase) {
                        config.passphrase = passphrase;
                    }
                    break;
                }
                case 'keyAndPassword': {
                    config.password = password;
                    config.tryKeyboard = true;
                    if (!profile.privateKeyPath) {
                        reject(new Error('Private key path is required'));
                        return;
                    }
                    config.privateKey = fs.readFileSync(profile.privateKeyPath);
                    if (passphrase) {
                        config.passphrase = passphrase;
                    }
                    break;
                }
                case 'sshAgent':
                    config.agent = process.env.SSH_AUTH_SOCK;
                    break;
            }

            // Keyboard-interactive fallback: answer prompts with the supplied
            // password. Covers servers that expose password auth only via PAM
            // keyboard-interactive. Does not handle multi-prompt 2FA.
            if (config.tryKeyboard) {
                this.sshClient.on(
                    'keyboard-interactive',
                    (_name, _instructions, _lang, prompts, finish) => {
                        finish(prompts.map(() => password ?? ''));
                    },
                );
            }

            this.sshClient.on('ready', () => {
                this._onLog.fire({ level: 'info', message: `SSH connection established to ${profile.host}:${profile.port}` });
                this.sshClient!.sftp((err, sftpSession) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.sftp = sftpSession;
                    this._connected = true;
                    this._onLog.fire({ level: 'info', message: 'SFTP session opened' });
                    resolve();
                });
            });

            this.sshClient.on('error', (err: Error) => {
                // ssh2 reports an empty algorithm intersection as a bare
                // "Handshake failed: no matching host key format", which says
                // nothing about the fix. Point at the per-site opt-in instead.
                if (
                    !profile.allowLegacyHostKeyAlgorithms &&
                    /no matching host key format/i.test(err.message)
                ) {
                    err.message =
                        `${err.message}. ${profile.host} offers only legacy SHA-1 host keys ` +
                        '(ssh-rsa / ssh-dss). Enable "Allow legacy SHA-1 host key algorithms" ' +
                        'in the site\'s Advanced tab to connect anyway.';
                }
                this._onLog.fire({ level: 'error', message: `SSH error: ${err.message}` });
                if (!this._connected) {
                    // Tear down the underlying socket explicitly. Without this,
                    // an error before `ready` leaves the TCP connection alive
                    // until GC eventually destroys the SSHClient.
                    try { this.sshClient?.destroy(); } catch { /* best-effort */ }
                    reject(err);
                } else {
                    this._connected = false;
                    this._onDidDisconnect.fire({ reason: err.message });
                }
            });

            this.sshClient.on('close', () => {
                if (this._connected) {
                    this._connected = false;
                    this._onDidDisconnect.fire({ reason: 'Connection closed' });
                }
            });

            this.sshClient.on('end', () => {
                if (this._connected) {
                    this._connected = false;
                    this._onDidDisconnect.fire({ reason: 'Connection ended' });
                }
            });

            this._onLog.fire({ level: 'info', message: `Connecting to ${profile.host}:${profile.port} via SFTP...` });
            this.sshClient.connect(config);
        });
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        if (this.sftp) {
            this.sftp.end();
            this.sftp = null;
        }
        if (this.sshClient) {
            this.sshClient.end();
        }
        this._onLog.fire({ level: 'info', message: 'Disconnected' });
    }

    isConnected(): boolean {
        return this._connected;
    }

    /**
     * Wrap a Promise with a timeout. Used to ensure SFTP operations do not
     * hang indefinitely when the underlying socket is wedged.
     */
    private withTimeout<T>(op: string, p: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const to = setTimeout(
                () => reject(new Error(`SFTP ${op} timed out after ${this._opTimeoutMs}ms`)),
                this._opTimeoutMs,
            );
            p.then(
                (v) => { clearTimeout(to); resolve(v); },
                (err) => { clearTimeout(to); reject(err); },
            );
        });
    }

    async pwd(): Promise<string> {
        this.assertConnected();
        return this.withTimeout('pwd', new Promise<string>((resolve, reject) => {
            this.sftp!.realpath('.', (err, absPath) => {
                if (err) { reject(err); } else { resolve(absPath); }
            });
        }));
    }

    async list(remotePath: string): Promise<FileEntry[]> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        return this.withTimeout('list', new Promise<FileEntry[]>((resolve, reject) => {
            this.sftp!.readdir(remotePath, (err, dirList) => {
                if (err) {
                    reject(err);
                    return;
                }
                const entries = dirList.map((item) => this.mapSftpEntry(item, remotePath));
                resolve(entries);
            });
        }));
    }

    async mkdir(remotePath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        return this.withTimeout('mkdir', new Promise<void>((resolve, reject) => {
            this.sftp!.mkdir(remotePath, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        }));
    }

    async rmdir(remotePath: string, recursive?: boolean): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        if (recursive) {
            await this.rmdirRecursive(remotePath);
        } else {
            return this.withTimeout('rmdir', new Promise<void>((resolve, reject) => {
                this.sftp!.rmdir(remotePath, (err) => {
                    if (err) { reject(err); } else { resolve(); }
                });
            }));
        }
    }

    async get(
        remotePath: string,
        localDest: string,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
        startAt?: number,
        _transferMode?: 'binary' | 'ascii', // SFTP has no ASCII mode; ignored.
    ): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const offset = Math.max(0, Math.floor(startAt ?? 0));

        // Get total size for progress (best effort)
        let total = 0;
        try {
            const st = await new Promise<Stats>((resolve, reject) => {
                this.sftp!.stat(remotePath, (err, stats) => {
                    if (err) { reject(err); } else { resolve(stats); }
                });
            });
            total = st.size ?? 0;
        } catch { /* progress total unknown */ }

        return new Promise<void>((resolve, reject) => {
            // For resume, start the remote read at `offset` and open the local
            // file in r+ mode positioned at the same offset so previous bytes
            // remain intact.
            const readStream = this.sftp!.createReadStream(
                remotePath,
                offset > 0 ? { start: offset } : undefined,
            );
            const writeStream = fs.createWriteStream(
                localDest,
                offset > 0 ? { flags: 'r+', start: offset } : undefined,
            );
            let transferred = 0;
            let settled = false;

            const cleanup = () => {
                signal?.removeEventListener('abort', onAbort);
                readStream.removeAllListeners();
                writeStream.removeAllListeners();
            };
            const settle = (fn: () => void) => {
                if (settled) { return; }
                settled = true;
                cleanup();
                fn();
            };
            const onAbort = () => {
                readStream.destroy();
                writeStream.destroy();
                settle(() => reject(new Error('Transfer cancelled')));
            };

            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });

            readStream.on('data', (chunk: string | Buffer) => {
                transferred += chunk.length;
                onProgress?.(offset + transferred, total || (offset + transferred));
            });
            readStream.on('error', (err: Error) => settle(() => reject(err)));
            writeStream.on('error', (err: Error) => settle(() => reject(err)));
            writeStream.on('finish', () => settle(() => resolve()));

            readStream.pipe(writeStream);
        });
    }

    async put(
        localSrc: string,
        remotePath: string,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
        startAt?: number,
        _transferMode?: 'binary' | 'ascii', // SFTP has no ASCII mode; ignored.
    ): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const offset = Math.max(0, Math.floor(startAt ?? 0));

        let total = 0;
        try {
            total = (await fs.promises.stat(localSrc)).size;
        } catch { /* ignore */ }

        return new Promise<void>((resolve, reject) => {
            const readStream = fs.createReadStream(
                localSrc,
                offset > 0 ? { start: offset } : undefined,
            );
            const writeStream = this.sftp!.createWriteStream(
                remotePath,
                offset > 0 ? { flags: 'r+', start: offset } : undefined,
            );
            let transferred = 0;
            let settled = false;

            const cleanup = () => {
                signal?.removeEventListener('abort', onAbort);
                readStream.removeAllListeners();
                writeStream.removeAllListeners();
            };
            const settle = (fn: () => void) => {
                if (settled) { return; }
                settled = true;
                cleanup();
                fn();
            };
            const onAbort = () => {
                readStream.destroy();
                writeStream.destroy();
                settle(() => reject(new Error('Transfer cancelled')));
            };

            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });

            readStream.on('data', (chunk: string | Buffer) => {
                transferred += chunk.length;
                onProgress?.(offset + transferred, total || (offset + transferred));
            });
            readStream.on('error', (err: Error) => settle(() => reject(err)));
            writeStream.on('error', (err: Error) => settle(() => reject(err)));
            writeStream.on('close', () => settle(() => resolve()));

            readStream.pipe(writeStream);
        });
    }

    async delete(remotePath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        return this.withTimeout('delete', new Promise<void>((resolve, reject) => {
            this.sftp!.unlink(remotePath, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        }));
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(oldPath, 'rename source');
        assertSafeRemotePath(newPath, 'rename destination');
        return this.withTimeout('rename', new Promise<void>((resolve, reject) => {
            this.sftp!.rename(oldPath, newPath, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        }));
    }

    async chmod(remotePath: string, mode: number): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
            throw new Error(`Invalid chmod mode: ${mode}`);
        }
        return this.withTimeout('chmod', new Promise<void>((resolve, reject) => {
            this.sftp!.chmod(remotePath, mode, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        }));
    }

    async stat(remotePath: string): Promise<FileEntry> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        return this.withTimeout('stat', new Promise<FileEntry>((resolve, reject) => {
            this.sftp!.stat(remotePath, (err, stats) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(this.statsToFileEntry(remotePath, stats));
            });
        }));
    }

    dispose(): void {
        this._connected = false;
        if (this.sftp) {
            this.sftp.end();
            this.sftp = null;
        }
        if (this.sshClient) {
            this.sshClient.destroy();
            this.sshClient = null;
        }
        this._onDidDisconnect.dispose();
        this._onLog.dispose();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private assertConnected(): void {
        if (!this._connected || !this.sftp) {
            throw new Error('Not connected to SFTP server');
        }
    }

    private mapSftpEntry(item: SSH2DirEntry, parentPath: string): FileEntry {
        const attrs = item.attrs;
        const fullPath = parentPath === '/'
            ? `/${item.filename}`
            : `${parentPath}/${item.filename}`;

        return {
            name: item.filename,
            path: fullPath,
            type: this.resolveType(attrs),
            size: attrs.size ?? 0,
            modifiedDate: attrs.mtime ? attrs.mtime * 1000 : 0,
            permissions: this.formatPermissions(attrs.mode ?? 0),
            permissionOctal: attrs.mode !== undefined ? attrs.mode & 0o7777 : undefined,
            owner: attrs.uid?.toString(),
            group: attrs.gid?.toString(),
            isHidden: item.filename.startsWith('.'),
            linkTarget: item.longname?.includes('->') ? item.longname.split('->').pop()?.trim() : undefined,
        };
    }

    private statsToFileEntry(filePath: string, stats: Stats): FileEntry {
        const name = path.posix.basename(filePath);
        return {
            name,
            path: filePath,
            type: this.resolveType(stats),
            size: stats.size ?? 0,
            modifiedDate: stats.mtime ? stats.mtime * 1000 : 0,
            permissions: this.formatPermissions(stats.mode ?? 0),
            permissionOctal: stats.mode !== undefined ? stats.mode & 0o7777 : undefined,
            owner: stats.uid?.toString(),
            group: stats.gid?.toString(),
            isHidden: name.startsWith('.'),
        };
    }

    private resolveType(attrs: { mode?: number; isDirectory?: () => boolean; isSymbolicLink?: () => boolean }): FileEntry['type'] {
        if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) {
            return 'symlink';
        }
        if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) {
            return 'directory';
        }
        // Fall back to mode bit inspection
        if (attrs.mode !== undefined) {
            // S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000
            const fmt = attrs.mode & 0o170000;
            if (fmt === 0o120000) { return 'symlink'; }
            if (fmt === 0o040000) { return 'directory'; }
        }
        return 'file';
    }

    /**
     * Converts a Unix mode integer to an rwxrwxrwx string.
     */
    private formatPermissions(mode: number): string {
        const bits = mode & 0o7777;
        const chars = ['r', 'w', 'x'];
        let result = '';
        for (let shift = 6; shift >= 0; shift -= 3) {
            for (let i = 0; i < 3; i++) {
                result += (bits >> (shift + (2 - i))) & 1 ? chars[i] : '-';
            }
        }
        return result;
    }

    /**
     * Recursively remove a directory and its contents.
     */
    private async rmdirRecursive(dirPath: string): Promise<void> {
        const entries = await this.list(dirPath);
        for (const entry of entries) {
            // Symlinks are removed as links, never followed. Following a
            // symlink to a directory would traverse outside `dirPath` and
            // delete unrelated files on the server.
            if (entry.type === 'symlink') {
                await this.delete(entry.path);
            } else if (entry.type === 'directory') {
                await this.rmdirRecursive(entry.path);
            } else {
                await this.delete(entry.path);
            }
        }
        return new Promise<void>((resolve, reject) => {
            this.sftp!.rmdir(dirPath, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        });
    }
}
