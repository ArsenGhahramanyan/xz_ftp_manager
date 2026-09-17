import * as vscode from 'vscode';
import * as path from 'path';
import { Client, FileInfo, FileType } from 'basic-ftp';
import {
    ConnectionProfile,
    FileEntry,
    IProtocolAdapter,
    ProgressCallback,
    ProtocolCapabilities,
} from '../models/interfaces';
import { assertSafeRemotePath } from '../../utils/pathUtils';

export class FtpAdapter implements IProtocolAdapter {
    // A single basic-ftp Client owns one control/data channel: it cannot run
    // transfers concurrently, and the only reliable interrupt is closing the
    // client (which drops the session). Hence both capabilities are false.
    public readonly capabilities: ProtocolCapabilities = {
        concurrentTransfers: false,
        pauseResume: false,
    };

    protected client: Client | null = null;
    protected connected = false;

    protected readonly _onDidDisconnect = new vscode.EventEmitter<{ reason: string; expected?: boolean }>();
    public readonly onDidDisconnect = this._onDidDisconnect.event;

    protected readonly _onLog = new vscode.EventEmitter<{ level: 'info' | 'command' | 'response' | 'error'; message: string }>();
    public readonly onLog = this._onLog.event;

    async connect(profile: ConnectionProfile, password?: string, _passphrase?: string): Promise<void> {
        // Plain FTP sends credentials and data in cleartext. Log it AND show a
        // non-modal warning toast, so the risk is visible even when the user
        // has `logLevel: off` and never opens the output channel.
        this._onLog.fire({
            level: 'error',
            message: `⚠ Connecting via plain FTP — credentials and data are sent UNENCRYPTED. Prefer FTPS or SFTP for any non-public host.`,
        });
        void vscode.window.showWarningMessage(
            `Plain FTP to "${profile.host}" sends your credentials and files UNENCRYPTED. Use FTPS or SFTP for any non-public host.`,
        );

        this.client = new Client(profile.timeoutSeconds * 1000);

        this.client.ftp.log = (message: string) => {
            const level = message.startsWith('< ')
                ? 'response' as const
                : message.startsWith('> ')
                    ? 'command' as const
                    : 'info' as const;
            // Redact credentials from FTP command chatter.
            const safe = message
                .replace(/^(> PASS )(.*)$/, '$1***')
                .replace(/^(> USER )(.*)$/, '$1***');
            this._onLog.fire({ level, message: safe });
        };

        this.client.ftp.socket.once('close', () => {
            if (this.connected) {
                this.connected = false;
                this._onDidDisconnect.fire({ reason: 'Connection closed by server' });
            }
        });

        await this.client.access({
            host: profile.host,
            port: profile.port,
            user: profile.username,
            password: password ?? '',
            secure: false,
        });

        this._onLog.fire({ level: 'info', message: `Connected to ${profile.host}:${profile.port} via FTP` });
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.connected = false;
            this.client.close();
            this._onLog.fire({ level: 'info', message: 'Disconnected' });
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    async pwd(): Promise<string> {
        this.assertConnected();
        return this.client!.pwd();
    }

    async list(remotePath: string): Promise<FileEntry[]> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const items = await this.client!.list(remotePath);
        return items.map((item) => this.mapFileInfo(item, remotePath));
    }

    async mkdir(remotePath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        await this.client!.ensureDir(remotePath);
        // ensureDir changes CWD, so return to root
        await this.client!.cd('/');
    }

    async rmdir(remotePath: string, _recursive?: boolean): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        await this.client!.removeDir(remotePath);
    }

    async get(
        remotePath: string,
        localDest: string,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
        startAt?: number,
        transferMode?: 'binary' | 'ascii',
    ): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const offset = Math.max(0, Math.floor(startAt ?? 0));
        await this.applyTransferType(transferMode);
        if (onProgress) {
            // basic-ftp's progress info reports `bytes` from 0 within the
            // current transfer segment. With REST resume, shift by `offset`
            // so the callback reports absolute file position.
            this.client!.trackProgress((info) => {
                onProgress(offset + info.bytes, info.bytesOverall || (offset + info.bytes));
            });
        }
        // basic-ftp doesn't expose a clean per-op abort. Closing the client
        // is the only reliable interrupt — but we must surface that the
        // connection died so the UI can show the disconnect and the queue
        // doesn't keep hammering a dead client. ConnectionManager listens to
        // `onDidDisconnect` and the next user action triggers reconnect.
        const onAbort = () => {
            try { this.client?.close(); } catch { /* best-effort */ }
            if (this.connected) {
                this.connected = false;
                // `expected: true` → this close is our own doing (user cancel),
                // not a network drop, so auto-reconnect should not kick in.
                this._onDidDisconnect.fire({ reason: 'Transfer cancelled — FTP connection closed', expected: true });
            }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            // basic-ftp opens local file with `flags: 'r+', start: offset` when
            // `startAt > 0` and issues `REST <offset>` before `RETR`.
            await this.client!.downloadTo(localDest, remotePath, offset);
            if (signal?.aborted) {
                throw new Error('Transfer cancelled');
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            this.client?.trackProgress();
            await this.restoreBinaryType(transferMode);
        }
    }

    async put(
        localSrc: string,
        remotePath: string,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
        startAt?: number,
        transferMode?: 'binary' | 'ascii',
    ): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const offset = Math.max(0, Math.floor(startAt ?? 0));
        await this.applyTransferType(transferMode);
        if (onProgress) {
            this.client!.trackProgress((info) => {
                onProgress(offset + info.bytes, info.bytesOverall || (offset + info.bytes));
            });
        }
        // basic-ftp doesn't expose a clean per-op abort. Closing the client
        // is the only reliable interrupt — but we must surface that the
        // connection died so the UI can show the disconnect and the queue
        // doesn't keep hammering a dead client. ConnectionManager listens to
        // `onDidDisconnect` and the next user action triggers reconnect.
        const onAbort = () => {
            try { this.client?.close(); } catch { /* best-effort */ }
            if (this.connected) {
                this.connected = false;
                // `expected: true` → this close is our own doing (user cancel),
                // not a network drop, so auto-reconnect should not kick in.
                this._onDidDisconnect.fire({ reason: 'Transfer cancelled — FTP connection closed', expected: true });
            }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (offset > 0) {
                // Resume: read local from `offset`, send via APPE so the server
                // appends the remaining bytes to the existing remote file.
                const fs = await import('fs');
                const stream = fs.createReadStream(localSrc, { start: offset });
                await this.client!.appendFrom(stream, remotePath);
            } else {
                await this.client!.uploadFrom(localSrc, remotePath);
            }
            if (signal?.aborted) {
                throw new Error('Transfer cancelled');
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            this.client?.trackProgress();
            await this.restoreBinaryType(transferMode);
        }
    }

    /**
     * Switch the FTP representation type to ASCII (TYPE A) when requested, so
     * the server performs CRLF/LF line-ending conversion. Binary (TYPE I) is
     * the default and needs no command.
     */
    private async applyTransferType(transferMode?: 'binary' | 'ascii'): Promise<void> {
        if (transferMode === 'ascii' && this.connected) {
            await this.client!.send('TYPE A');
        }
    }

    /** Restore binary type after an ASCII transfer so later transfers default to binary. */
    private async restoreBinaryType(transferMode?: 'binary' | 'ascii'): Promise<void> {
        if (transferMode === 'ascii' && this.connected) {
            try { await this.client?.send('TYPE I'); } catch { /* connection may be closing */ }
        }
    }

    async delete(remotePath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        await this.client!.remove(remotePath);
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(oldPath, 'rename source');
        assertSafeRemotePath(newPath, 'rename destination');
        await this.client!.rename(oldPath, newPath);
    }

    async chmod(remotePath: string, mode: number): Promise<void> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
            throw new Error(`Invalid chmod mode: ${mode}`);
        }
        const octal = mode.toString(8);
        await this.client!.send(`SITE CHMOD ${octal} ${remotePath}`);
    }

    async stat(remotePath: string): Promise<FileEntry> {
        this.assertConnected();
        assertSafeRemotePath(remotePath);
        const parentDir = path.posix.dirname(remotePath);
        const baseName = path.posix.basename(remotePath);
        const entries = await this.client!.list(parentDir);
        const match = entries.find((e) => e.name === baseName);
        if (!match) {
            throw new Error(`File not found: ${remotePath}`);
        }
        return this.mapFileInfo(match, parentDir);
    }

    dispose(): void {
        if (this.client) {
            this.connected = false;
            this.client.close();
            this.client = null;
        }
        this._onDidDisconnect.dispose();
        this._onLog.dispose();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    protected assertConnected(): void {
        if (!this.connected || !this.client) {
            throw new Error('Not connected to FTP server');
        }
    }

    protected mapFileInfo(info: FileInfo, parentPath: string): FileEntry {
        let entryType: FileEntry['type'];
        switch (info.type) {
            case FileType.Directory:
                entryType = 'directory';
                break;
            case FileType.SymbolicLink:
                entryType = 'symlink';
                break;
            default:
                entryType = 'file';
                break;
        }

        const fullPath = parentPath === '/'
            ? `/${info.name}`
            : `${parentPath}/${info.name}`;

        return {
            name: info.name,
            path: fullPath,
            type: entryType,
            size: info.size,
            modifiedDate: info.modifiedAt ? info.modifiedAt.getTime() : 0,
            permissions: info.permissions?.toString(),
            owner: info.user,
            group: info.group,
            isHidden: info.name.startsWith('.'),
        };
    }
}
