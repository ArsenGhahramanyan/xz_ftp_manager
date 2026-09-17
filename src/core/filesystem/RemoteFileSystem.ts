import { FileEntry, IProtocolAdapter } from '../models/interfaces';
import { ConnectionManager } from '../connection/ConnectionManager';
import { joinRemotePath } from '../../utils/pathUtils';

/**
 * High-level remote file-system operations that route through
 * the ConnectionManager to reach the correct protocol adapter.
 */
export class RemoteFileSystem {
    private readonly connectionManager: ConnectionManager;

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * List a remote directory and return FileEntry[].
     */
    async listDirectory(connectionId: string, remotePath: string): Promise<FileEntry[]> {
        const adapter = this.requireAdapter(connectionId);
        return adapter.list(remotePath);
    }

    /**
     * Create a remote directory (recursively via the adapter).
     */
    async createDirectory(connectionId: string, remotePath: string): Promise<void> {
        const adapter = this.requireAdapter(connectionId);
        await adapter.mkdir(remotePath);
    }

    /**
     * Delete a remote file or directory.
     * Directories are removed recursively.
     */
    async deleteItem(connectionId: string, remotePath: string, isDir: boolean): Promise<void> {
        const adapter = this.requireAdapter(connectionId);

        if (isDir) {
            await this.deleteDirectoryRecursive(adapter, remotePath);
        } else {
            await adapter.delete(remotePath);
        }
    }

    /**
     * Rename (or move) a remote path.
     */
    async rename(connectionId: string, oldPath: string, newPath: string): Promise<void> {
        const adapter = this.requireAdapter(connectionId);
        await adapter.rename(oldPath, newPath);
    }

    /**
     * Change permissions on a remote path.
     */
    async chmod(connectionId: string, remotePath: string, mode: number): Promise<void> {
        const adapter = this.requireAdapter(connectionId);
        await adapter.chmod(remotePath, mode);
    }

    /**
     * Stat a single remote path and return a FileEntry.
     */
    async stat(connectionId: string, remotePath: string): Promise<FileEntry> {
        const adapter = this.requireAdapter(connectionId);
        return adapter.stat(remotePath);
    }

    // ── Private ───────────────────────────────────────────────────────

    /**
     * Recursively delete a remote directory by listing, deleting children, then the dir itself.
     */
    private async deleteDirectoryRecursive(adapter: IProtocolAdapter, remotePath: string): Promise<void> {
        let entries: FileEntry[];
        try {
            entries = await adapter.list(remotePath);
        } catch {
            // If listing fails, try to remove it as an empty directory
            await adapter.rmdir(remotePath);
            return;
        }

        for (const entry of entries) {
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }

            const childPath = joinRemotePath(remotePath, entry.name);

            if (entry.type === 'directory') {
                await this.deleteDirectoryRecursive(adapter, childPath);
            } else {
                await adapter.delete(childPath);
            }
        }

        await adapter.rmdir(remotePath);
    }

    /**
     * Get the adapter for a connection id, or throw.
     */
    private requireAdapter(connectionId: string): IProtocolAdapter {
        const adapter = this.connectionManager.getAdapter(connectionId);
        if (!adapter) {
            throw new Error(`No active connection for id: ${connectionId}`);
        }
        return adapter;
    }
}
