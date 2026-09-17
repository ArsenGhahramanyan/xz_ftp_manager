import * as path from 'path';
import * as fs from 'fs';
import { IProtocolAdapter, ProgressCallback, OverwriteRule } from '../models/interfaces';
import { ConnectionManager } from '../connection/ConnectionManager';
import { TransferItem } from './TransferItem';
import { TransferQueue } from './TransferQueue';
import { ConfigService } from '../../services/ConfigService';
import { joinRemotePath, assertSafeEntryName, assertWithinDirectory } from '../../utils/pathUtils';

/**
 * Function that asks the user how to handle a collision. Resolves to one of:
 *   - 'overwrite' — replace the target
 *   - 'skip'      — leave the target alone
 * (Rename / smart rules are resolved inside the engine and never surface here.)
 */
export type OverwritePrompter = (ctx: {
    item: TransferItem;
    target: string;
}) => Promise<'overwrite' | 'skip'>;

/**
 * Performs the actual file-level transfer work for individual TransferItem instances.
 * Supports single-file uploads/downloads and recursive directory transfers.
 *
 * Automatic retry: transient errors (not user-cancellation, not auth) are retried
 * up to `item.maxRetries` times with exponential backoff based on
 * `configService.getRetryDelay()`.
 */
export class TransferEngine {
    private readonly queue: TransferQueue;
    private readonly connectionManager: ConnectionManager;
    private readonly configService: ConfigService | undefined;

    private readonly prompter: OverwritePrompter | undefined;

    constructor(
        queue: TransferQueue,
        connectionManager: ConnectionManager,
        configService?: ConfigService,
        prompter?: OverwritePrompter,
    ) {
        this.queue = queue;
        this.connectionManager = connectionManager;
        this.configService = configService;
        this.prompter = prompter;
    }

    /**
     * Process a single transfer item to completion.
     * This is the function handed to TransferQueue as the `onProcess` callback.
     */
    async processTransfer(item: TransferItem, adapter?: IProtocolAdapter): Promise<void> {
        const resolvedAdapter = adapter ?? this.connectionManager.getAdapter(item.connectionId);
        if (!resolvedAdapter) {
            item.fail(`No active connection for ${item.connectionId}`);
            return;
        }

        const baseDelay = (this.configService?.getRetryDelay() ?? 5) * 1000;
        let attempt = 0;
        let lastError: unknown;

        while (attempt <= item.maxRetries) {
            try {
                const isDirectory = await this.isRemoteDirectory(item, resolvedAdapter);

                if (isDirectory) {
                    await this.processDirectoryTransfer(item, resolvedAdapter);
                } else if (item.direction === 'download') {
                    await this.processDownload(item, resolvedAdapter);
                } else {
                    await this.processUpload(item, resolvedAdapter);
                }

                if (item.status === 'active') {
                    item.complete();
                }
                return;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : String(err);

                // Stop retrying on user cancel or if the item was externally moved.
                if (item.status !== 'active' || item.abortSignal.aborted || /cancelled/i.test(message)) {
                    throw err;
                }
                // Stop retrying on non-transient errors (authentication, permission).
                if (/auth|permission|forbidden|denied|no such file|ENOENT/i.test(message)) {
                    item.fail(message);
                    throw err;
                }

                if (attempt >= item.maxRetries) {
                    item.fail(message);
                    throw err;
                }
                attempt++;
                const waitMs = baseDelay * Math.pow(2, attempt - 1);
                await new Promise((r) => setTimeout(r, waitMs));
                // Loop and try again. Progress starts over from whatever adapter does.
            }
        }

        // Exhausted retries without ever throwing (defensive).
        throw lastError ?? new Error('Transfer failed');
    }

    // ── Single file transfers ─────────────────────────────────────────

    private async processDownload(item: TransferItem, adapter: IProtocolAdapter): Promise<void> {
        // A resumed (previously paused) transfer continues from the on-disk
        // partial; otherwise apply the configured overwrite rule.
        const decision = item.resumeOffset > 0
            ? await this.resolveResume(item, adapter)
            : await this.resolveCollision(item, adapter);
        if (decision.action === 'skip') {
            return;
        }

        // Ensure local parent directory exists
        const localDir = path.dirname(item.localPath);
        await fs.promises.mkdir(localDir, { recursive: true });

        const onProgress: ProgressCallback = (transferred, total) => {
            item.updateProgress(transferred, total);
        };

        await adapter.get(item.remotePath, item.localPath, onProgress, item.abortSignal, decision.startAt, item.transferMode);
    }

    private async processUpload(item: TransferItem, adapter: IProtocolAdapter): Promise<void> {
        const decision = item.resumeOffset > 0
            ? await this.resolveResume(item, adapter)
            : await this.resolveCollision(item, adapter);
        if (decision.action === 'skip') {
            return;
        }

        const onProgress: ProgressCallback = (transferred, total) => {
            item.updateProgress(transferred, total);
        };

        await adapter.put(item.localPath, item.remotePath, onProgress, item.abortSignal, decision.startAt, item.transferMode);
    }

    /**
     * Check if the transfer target already exists and resolve the overwrite
     * rule. Returns the action and an optional `startAt` byte offset for
     * `'resume'` mode.
     */
    private async resolveCollision(
        item: TransferItem,
        adapter: IProtocolAdapter,
    ): Promise<{ action: 'proceed' | 'skip'; startAt?: number }> {
        const exists = await this.targetExists(item, adapter);
        if (!exists) {
            return { action: 'proceed' };
        }

        const rule: OverwriteRule = item.overwriteRule;
        switch (rule) {
            case 'overwrite':
                return { action: 'proceed' };
            case 'skip':
                return { action: 'skip' };
            case 'ask': {
                if (!this.prompter) {
                    return { action: 'proceed' }; // no UI available — preserve historical behavior
                }
                const target = item.direction === 'download' ? item.localPath : item.remotePath;
                const choice = await this.prompter({ item, target });
                return { action: choice === 'skip' ? 'skip' : 'proceed' };
            }
            case 'overwriteIfNewer': {
                const newer = await this.localIsNewer(item, adapter);
                return { action: newer === item.direction ? 'proceed' : 'skip' };
            }
            case 'overwriteIfSizeDiffers': {
                const sizesEqual = await this.sizesEqual(item, adapter);
                return { action: sizesEqual ? 'skip' : 'proceed' };
            }
            case 'rename': {
                if (item.direction === 'download') {
                    const unique = await this.findUniqueLocalPath(item.localPath);
                    item.retarget('local', unique);
                } else {
                    const unique = await this.findUniqueRemotePath(item.remotePath, adapter);
                    item.retarget('remote', unique);
                }
                return { action: 'proceed' };
            }
            case 'resume':
                return this.resolveResume(item, adapter);
            default:
                return { action: 'proceed' };
        }
    }

    /**
     * Compute the byte offset to resume a transfer from, by inspecting the
     * partial file at the destination. Used both by the `'resume'` overwrite
     * rule and when continuing a previously-paused transfer.
     *   - download: local partial size, remote = source of truth.
     *   - upload:   remote partial size, local  = source of truth.
     * ASCII mode rewrites line endings on the wire, so a partial byte size on
     * disk has no meaningful offset on the server — fall back to a full
     * transfer to avoid producing a half-converted file.
     */
    private async resolveResume(
        item: TransferItem,
        adapter: IProtocolAdapter,
    ): Promise<{ action: 'proceed' | 'skip'; startAt?: number }> {
        if (item.transferMode === 'ascii') {
            return { action: 'proceed' };
        }
        try {
            const [local, remote] = await Promise.all([
                fs.promises.stat(item.localPath).catch(() => undefined),
                adapter.stat(item.remotePath).catch(() => undefined),
            ]);
            const localSize = local?.size ?? 0;
            const remoteSize = remote?.size ?? 0;

            if (item.direction === 'download') {
                if (localSize === 0) { return { action: 'proceed' }; } // nothing to resume
                if (localSize >= remoteSize) { return { action: 'skip' }; } // already done
                return { action: 'proceed', startAt: localSize };
            } else {
                if (remoteSize === 0) { return { action: 'proceed' }; }
                if (remoteSize >= localSize) { return { action: 'skip' }; }
                return { action: 'proceed', startAt: remoteSize };
            }
        } catch {
            // stat failed unexpectedly — safer to overwrite than risk
            // a half-byte corruption.
            return { action: 'proceed' };
        }
    }

    /**
     * Find a non-existing path next to `target` by appending ` (1)`, ` (2)`, …
     * before the extension. Bounded at 1000 attempts to avoid infinite loops
     * on a misbehaving filesystem.
     */
    private async findUniqueLocalPath(target: string): Promise<string> {
        const dir = path.dirname(target);
        const ext = path.extname(target);
        const stem = path.basename(target, ext);
        for (let n = 1; n <= 1000; n++) {
            const candidate = path.join(dir, `${stem} (${n})${ext}`);
            try {
                await fs.promises.stat(candidate);
                // exists — try next
            } catch {
                return candidate;
            }
        }
        throw new Error(`Cannot find a unique name for ${target} (1000 attempts).`);
    }

    private async findUniqueRemotePath(target: string, adapter: IProtocolAdapter): Promise<string> {
        const dir = target.substring(0, target.lastIndexOf('/')) || '/';
        const base = target.substring(target.lastIndexOf('/') + 1);
        const dotIdx = base.lastIndexOf('.');
        const stem = dotIdx > 0 ? base.substring(0, dotIdx) : base;
        const ext = dotIdx > 0 ? base.substring(dotIdx) : '';
        for (let n = 1; n <= 1000; n++) {
            const candidate = joinRemotePath(dir, `${stem} (${n})${ext}`);
            try {
                await adapter.stat(candidate);
                // exists — try next
            } catch {
                return candidate;
            }
        }
        throw new Error(`Cannot find a unique name for ${target} (1000 attempts).`);
    }

    private async targetExists(item: TransferItem, adapter: IProtocolAdapter): Promise<boolean> {
        if (item.direction === 'download') {
            try {
                await fs.promises.stat(item.localPath);
                return true;
            } catch {
                return false;
            }
        } else {
            try {
                await adapter.stat(item.remotePath);
                return true;
            } catch {
                return false;
            }
        }
    }

    /**
     * Return the side that holds the newer file, or `undefined` if timestamps
     * cannot be obtained. Used by `overwriteIfNewer`.
     */
    private async localIsNewer(
        item: TransferItem,
        adapter: IProtocolAdapter,
    ): Promise<'download' | 'upload' | undefined> {
        try {
            const [local, remote] = await Promise.all([
                fs.promises.stat(item.localPath),
                adapter.stat(item.remotePath),
            ]);
            const localMs = local.mtimeMs;
            const remoteMs = (remote.modifiedDate ?? 0) * 1000;
            if (localMs > remoteMs) {
                return 'upload'; // local is newer — only upload direction should proceed
            }
            if (remoteMs > localMs) {
                return 'download'; // remote is newer — only download should proceed
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    private async sizesEqual(item: TransferItem, adapter: IProtocolAdapter): Promise<boolean> {
        try {
            const [local, remote] = await Promise.all([
                fs.promises.stat(item.localPath),
                adapter.stat(item.remotePath),
            ]);
            return local.size === (remote.size ?? -1);
        } catch {
            return false;
        }
    }

    // ── Recursive directory transfers ─────────────────────────────────

    private async processDirectoryTransfer(item: TransferItem, adapter: IProtocolAdapter): Promise<void> {
        if (item.direction === 'download') {
            await this.downloadDirectory(item, adapter, item.remotePath, item.localPath);
        } else {
            await this.uploadDirectory(item, adapter, item.localPath, item.remotePath);
        }
    }

    private async downloadDirectory(
        parentItem: TransferItem,
        adapter: IProtocolAdapter,
        remotePath: string,
        localPath: string
    ): Promise<void> {
        // Create local directory
        await fs.promises.mkdir(localPath, { recursive: true });

        // List remote contents
        const entries = await adapter.list(remotePath);

        for (const entry of entries) {
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }

            // Defence against FTP-Slip: a malicious server can return entries
            // with names like "../../etc/passwd" to make us write outside the
            // intended target directory. Reject any name with traversal,
            // separators, NUL or control bytes, and verify the resolved path
            // still lives inside `localPath`.
            try {
                assertSafeEntryName(entry.name);
            } catch (err) {
                // Skip the entry but log; one bad name should not abort the
                // whole recursive transfer.
                // eslint-disable-next-line no-console
                console.warn(`Skipping unsafe entry from server: ${(err as Error).message}`);
                continue;
            }

            // Skip symlinks. Following them recursively can pull in unrelated
            // trees and may trigger ToCToU surprises if the link target
            // changes mid-walk. Users who need symlink content can transfer
            // the explicit target.
            if (entry.type === 'symlink') {
                continue;
            }

            const childRemotePath = joinRemotePath(remotePath, entry.name);
            const childLocalPath = path.join(localPath, entry.name);
            assertWithinDirectory(localPath, childLocalPath);

            if (entry.type === 'directory') {
                // Enqueue child directory as a separate transfer item
                const childItem = new TransferItem({
                    connectionId: parentItem.connectionId,
                    localPath: childLocalPath,
                    remotePath: childRemotePath,
                    direction: 'download',
                    overwriteRule: parentItem.overwriteRule,
                    transferMode: parentItem.transferMode,
                    preserveTimestamp: parentItem.preserveTimestamp,
                });
                this.queue.enqueue(childItem);
            } else {
                // Enqueue child file
                const childItem = new TransferItem({
                    connectionId: parentItem.connectionId,
                    localPath: childLocalPath,
                    remotePath: childRemotePath,
                    direction: 'download',
                    totalBytes: entry.size,
                    overwriteRule: parentItem.overwriteRule,
                    transferMode: parentItem.transferMode,
                    preserveTimestamp: parentItem.preserveTimestamp,
                });
                this.queue.enqueue(childItem);
            }
        }
    }

    private async uploadDirectory(
        parentItem: TransferItem,
        adapter: IProtocolAdapter,
        localPath: string,
        remotePath: string
    ): Promise<void> {
        // Create remote directory
        await adapter.mkdir(remotePath);

        // List local contents
        const dirEntries = await fs.promises.readdir(localPath, { withFileTypes: true });

        for (const entry of dirEntries) {
            // Skip symlinks — uploading the link target rather than the link
            // itself can produce out-of-tree writes if a malicious or stale
            // workspace link points outside `localPath`.
            if (entry.isSymbolicLink()) {
                continue;
            }
            // Defence-in-depth: validate the entry name and confirm the
            // resolved local path stays inside the upload root before we use
            // it to derive the remote target.
            try {
                assertSafeEntryName(entry.name);
            } catch (err) {
                console.warn(`Skipping unsafe local entry: ${(err as Error).message}`);
                continue;
            }

            const childLocalPath = path.join(localPath, entry.name);
            const childRemotePath = joinRemotePath(remotePath, entry.name);
            assertWithinDirectory(localPath, childLocalPath);

            if (entry.isDirectory()) {
                const childItem = new TransferItem({
                    connectionId: parentItem.connectionId,
                    localPath: childLocalPath,
                    remotePath: childRemotePath,
                    direction: 'upload',
                    overwriteRule: parentItem.overwriteRule,
                    transferMode: parentItem.transferMode,
                    preserveTimestamp: parentItem.preserveTimestamp,
                });
                this.queue.enqueue(childItem);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(childLocalPath);
                const childItem = new TransferItem({
                    connectionId: parentItem.connectionId,
                    localPath: childLocalPath,
                    remotePath: childRemotePath,
                    direction: 'upload',
                    totalBytes: stat.size,
                    overwriteRule: parentItem.overwriteRule,
                    transferMode: parentItem.transferMode,
                    preserveTimestamp: parentItem.preserveTimestamp,
                });
                this.queue.enqueue(childItem);
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────

    /**
     * Decide whether the transfer item represents a directory.
     * For downloads we ask the remote; for uploads we check the local filesystem.
     */
    private async isRemoteDirectory(item: TransferItem, adapter: IProtocolAdapter): Promise<boolean> {
        try {
            if (item.direction === 'download') {
                const stat = await adapter.stat(item.remotePath);
                return stat.type === 'directory';
            } else {
                const stat = await fs.promises.stat(item.localPath);
                return stat.isDirectory();
            }
        } catch {
            return false;
        }
    }
}
