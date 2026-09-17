import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { IProtocolAdapter } from '../core/models/interfaces';
import { assertSafeRemotePath, assertWithinDirectory } from '../utils/pathUtils';

interface TempMapping {
    connectionId: string;
    remotePath: string;
}

/**
 * Manages a temporary directory for remote files opened locally in the editor.
 * Keeps track of which local temp file maps to which remote path so
 * the FileWatcherService can re-upload on save.
 */
export class TempFileService implements vscode.Disposable {
    private readonly tempDir: string;
    private readonly mappings = new Map<string, TempMapping>();

    constructor() {
        TempFileService.cleanupStale();
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-manager-'));
    }

    /**
     * Remove leftover `ftp-manager-*` directories older than 24h from the OS
     * temp dir. Accounts for crashes / ungraceful shutdowns that skipped
     * {@link dispose}. Does not touch recent dirs to avoid stealing another
     * window's live workspace.
     */
    private static cleanupStale(): void {
        const STALE_MS = 24 * 60 * 60 * 1000;
        const root = os.tmpdir();
        try {
            const now = Date.now();
            for (const entry of fs.readdirSync(root)) {
                if (!entry.startsWith('ftp-manager-')) {
                    continue;
                }
                const full = path.join(root, entry);
                try {
                    const st = fs.statSync(full);
                    if (now - st.mtimeMs > STALE_MS) {
                        fs.rmSync(full, { recursive: true, force: true });
                    }
                } catch { /* ignore single-entry failures */ }
            }
        } catch { /* temp dir unreadable — skip cleanup */ }
    }

    /**
     * Download `remotePath` into a temp file and open it in a VS Code editor.
     * Returns the local path of the temp file.
     */
    async downloadAndOpen(
        connectionId: string,
        remotePath: string,
        adapter: IProtocolAdapter,
    ): Promise<string> {
        // Reject CR/LF/NUL before the path is used for any filesystem op.
        assertSafeRemotePath(remotePath);

        // Reproduce the remote directory structure inside the temp dir so
        // files with the same basename but different directories don't collide.
        const relativePath = remotePath.startsWith('/') ? remotePath.slice(1) : remotePath;
        const baseDir = path.join(this.tempDir, connectionId);
        const localPath = path.join(baseDir, relativePath);

        // Defence against a malicious server returning a path with ".." that
        // would land the downloaded file outside the temp dir (and, via the
        // save-watcher, re-upload to an attacker-chosen remote path).
        assertWithinDirectory(baseDir, localPath);

        // Ensure the parent folder exists
        const parentDir = path.dirname(localPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        await adapter.get(remotePath, localPath);

        // Store mapping for later upload-on-save
        this.mappings.set(this.normalizeLocal(localPath), { connectionId, remotePath });

        // Open in editor
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc);

        return localPath;
    }

    /**
     * Returns the remote mapping for a given local temp file, or `undefined`
     * if the file is not tracked.
     */
    getTempMapping(localPath: string): TempMapping | undefined {
        return this.mappings.get(this.normalizeLocal(localPath));
    }

    /**
     * Remove the entire temporary directory and all tracked mappings.
     */
    cleanup(): void {
        this.mappings.clear();
        try {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup; the OS will eventually reclaim temp files.
        }
    }

    dispose(): void {
        this.cleanup();
    }

    // ── Private ──────────────────────────────────────────────────────

    private normalizeLocal(p: string): string {
        const normalized = path.normalize(p);
        // Only case-fold on case-insensitive filesystems. On Linux (and
        // case-sensitive APFS) two remote files differing only in case are
        // distinct; lower-casing would collapse them and re-upload to the
        // wrong remote path on save.
        return process.platform === 'win32' || process.platform === 'darwin'
            ? normalized.toLowerCase()
            : normalized;
    }
}
