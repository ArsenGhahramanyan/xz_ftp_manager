import * as vscode from 'vscode';
import { ProtocolCapabilities, TransferItemData } from '../models/interfaces';
import { TransferItem } from './TransferItem';

/**
 * Callback invoked when a queued item is ready to be processed.
 * The implementation should perform the actual transfer and resolve/reject
 * when the transfer completes or fails.
 */
export type OnProcessCallback = (item: TransferItem) => Promise<void>;

/** Resolves the protocol capabilities for a connection, or undefined if unknown. */
export type CapabilityResolver = (connectionId: string) => ProtocolCapabilities | undefined;

/**
 * Manages a queue of transfer items, enforcing a configurable concurrency limit.
 */
export class TransferQueue implements vscode.Disposable {
    private readonly items = new Map<string, TransferItem>();
    private _maxConcurrent: number;
    private readonly _onProcess: OnProcessCallback;
    private readonly _capabilities: CapabilityResolver | undefined;

    private readonly _onDidChange = new vscode.EventEmitter<TransferItemData[]>();
    public readonly onDidChange: vscode.Event<TransferItemData[]> = this._onDidChange.event;

    constructor(maxConcurrent: number = 2, onProcess: OnProcessCallback, capabilities?: CapabilityResolver) {
        this._maxConcurrent = maxConcurrent;
        this._onProcess = onProcess;
        this._capabilities = capabilities;
    }

    /**
     * Per-connection concurrency cap. FTP/FTPS cannot run concurrent transfers
     * on one client, so they are capped at 1 regardless of the global setting;
     * SFTP uses the configured limit. Unknown protocols default to 1 (safe).
     */
    private effectiveConcurrency(connectionId: string): number {
        const caps = this._capabilities?.(connectionId);
        if (caps === undefined) {
            return 1;
        }
        return caps.concurrentTransfers ? this._maxConcurrent : 1;
    }

    /**
     * Update the concurrency cap at runtime. If the new cap is higher,
     * immediately attempt to activate more queued items.
     */
    setMaxConcurrent(n: number): void {
        const clamped = Math.max(1, Math.min(10, Math.floor(n)));
        if (clamped === this._maxConcurrent) {
            return;
        }
        this._maxConcurrent = clamped;
        this.processNext();
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Add a transfer item to the queue and attempt to start processing.
     */
    enqueue(item: TransferItem): void {
        this.items.set(item.id, item);
        this.fireChange();
        this.processNext();
    }

    /**
     * Attempt to activate the next queued item(s) up to the concurrency limit.
     * The cap is applied PER connection — a slow upload on profile A must not
     * starve transfers on profile B.
     */
    processNext(): void {
        const activeByConn = new Map<string, number>();
        for (const it of this.items.values()) {
            if (it.status === 'active') {
                activeByConn.set(it.connectionId, (activeByConn.get(it.connectionId) ?? 0) + 1);
            }
        }

        const queued = this.getItemsByStatus('queued');
        const toActivate: TransferItem[] = [];
        for (const item of queued) {
            const used = activeByConn.get(item.connectionId) ?? 0;
            if (used < this.effectiveConcurrency(item.connectionId)) {
                toActivate.push(item);
                activeByConn.set(item.connectionId, used + 1);
            }
        }
        if (toActivate.length === 0) {
            return;
        }

        for (const item of toActivate) {
            item.activate();
            this.fireChange();

            this._onProcess(item)
                .catch((err: unknown) => {
                    // If the engine rejected without moving the item out of `active`,
                    // mark it failed so it doesn't stay orphaned in the queue.
                    if (item.status === 'active') {
                        const message = err instanceof Error ? err.message : String(err);
                        try { item.fail(message); } catch { /* already transitioned */ }
                    }
                })
                .finally(() => {
                    this.fireChange();
                    this.processNext();
                });
        }
    }

    // ── Single-item actions ───────────────────────────────────────────

    /** Whether an ACTIVE transfer on this connection can be paused mid-flight. */
    private canPauseActive(connectionId: string): boolean {
        return this._capabilities?.(connectionId)?.pauseResume ?? false;
    }

    pause(id: string): void {
        const item = this.mustGet(id);
        // FTP/FTPS cannot pause a running transfer without dropping the whole
        // session, so leave active items running (cancel is the alternative).
        // Queued items are always pausable — they simply won't be started.
        if (item.status === 'active' && !this.canPauseActive(item.connectionId)) {
            return;
        }
        item.pause();
        this.fireChange();
    }

    resume(id: string): void {
        const item = this.mustGet(id);
        item.resume();
        this.fireChange();
        this.processNext();
    }

    cancel(id: string): void {
        const item = this.mustGet(id);
        item.cancel();
        this.fireChange();
        this.processNext();
    }

    retry(id: string): void {
        const item = this.mustGet(id);
        item.retry();
        this.fireChange();
        this.processNext();
    }

    remove(id: string): void {
        this.items.delete(id);
        this.fireChange();
    }

    // ── Bulk actions ──────────────────────────────────────────────────

    pauseAll(): void {
        for (const item of this.items.values()) {
            // Skip active FTP/FTPS transfers that cannot be paused mid-flight.
            if (item.status === 'active' && !this.canPauseActive(item.connectionId)) {
                continue;
            }
            if (item.status === 'active' || item.status === 'queued') {
                try { item.pause(); } catch { /* skip invalid transitions */ }
            }
        }
        this.fireChange();
    }

    resumeAll(): void {
        for (const item of this.items.values()) {
            if (item.status === 'paused') {
                try { item.resume(); } catch { /* skip */ }
            }
        }
        this.fireChange();
        this.processNext();
    }

    cancelAll(): void {
        for (const item of this.items.values()) {
            if (item.status === 'queued' || item.status === 'active' || item.status === 'paused') {
                try { item.cancel(); } catch { /* skip */ }
            }
        }
        this.fireChange();
    }

    retryAllFailed(): void {
        for (const item of this.items.values()) {
            if (item.status === 'failed') {
                try { item.retry(); } catch { /* skip */ }
            }
        }
        this.fireChange();
        this.processNext();
    }

    clearCompleted(): void {
        for (const [id, item] of this.items.entries()) {
            if (item.status === 'completed' || item.status === 'cancelled') {
                this.items.delete(id);
            }
        }
        this.fireChange();
    }

    // ── Queries ───────────────────────────────────────────────────────

    getItems(): TransferItem[] {
        return Array.from(this.items.values());
    }

    getItem(id: string): TransferItem | undefined {
        return this.items.get(id);
    }

    getItemsData(): TransferItemData[] {
        return this.getItems().map(i => i.toData());
    }

    // ── Disposal ──────────────────────────────────────────────────────

    dispose(): void {
        // Signal in-flight transfers to abort so their adapters stop I/O
        // rather than being orphaned when the queue is torn down.
        for (const item of this.items.values()) {
            if (item.status === 'active' || item.status === 'queued' || item.status === 'paused') {
                try { item.cancel(); } catch { /* already transitioned */ }
            }
        }
        this.items.clear();
        this._onDidChange.dispose();
    }

    // ── Private ───────────────────────────────────────────────────────

    private mustGet(id: string): TransferItem {
        const item = this.items.get(id);
        if (!item) {
            throw new Error(`Transfer item not found: ${id}`);
        }
        return item;
    }

    private getItemsByStatus(status: string): TransferItem[] {
        const result: TransferItem[] = [];
        for (const item of this.items.values()) {
            if (item.status === status) {
                result.push(item);
            }
        }
        return result;
    }

    private fireChange(): void {
        this._onDidChange.fire(this.getItemsData());
    }
}
