import { TransferItemData, TransferStatus, TransferDirection, OverwriteRule } from '../models/interfaces';
import { makeId } from '../../utils/idUtils';

/**
 * Stateful wrapper around TransferItemData that enforces valid state transitions.
 */
export class TransferItem {
    private _id: string;
    private _connectionId: string;
    private _localPath: string;
    private _remotePath: string;
    private _direction: TransferDirection;
    private _status: TransferStatus;
    private _totalBytes: number;
    private _transferredBytes: number;
    private _bytesPerSecond: number;
    private _error?: string;
    private _retryCount: number;
    private _maxRetries: number;
    private _overwriteRule: OverwriteRule;
    private _transferMode: 'binary' | 'ascii';
    private _startedAt?: number;
    private _completedAt?: number;
    private _preserveTimestamp: boolean;

    /** Timestamp of the last progress update, used to compute speed. */
    private _lastProgressTime: number = 0;
    /** Byte count at the last progress update. */
    private _lastProgressBytes: number = 0;
    /** Abort controller signalled on cancel/pause; passed to adapter.get/put. */
    private _abortController: AbortController = new AbortController();
    /**
     * When > 0, this item is resuming a previously-paused transfer and the
     * engine should continue from a byte offset (the actual on-disk / remote
     * partial size) rather than starting over.
     */
    private _resumeOffset: number = 0;

    constructor(data: Partial<TransferItemData> & Pick<TransferItemData, 'connectionId' | 'localPath' | 'remotePath' | 'direction'>) {
        this._id = data.id ?? makeId('tf');
        this._connectionId = data.connectionId;
        this._localPath = data.localPath;
        this._remotePath = data.remotePath;
        this._direction = data.direction;
        this._status = data.status ?? 'queued';
        this._totalBytes = data.totalBytes ?? 0;
        this._transferredBytes = data.transferredBytes ?? 0;
        this._bytesPerSecond = data.bytesPerSecond ?? 0;
        this._error = data.error;
        this._retryCount = data.retryCount ?? 0;
        this._maxRetries = data.maxRetries ?? 3;
        this._overwriteRule = data.overwriteRule ?? 'overwrite';
        this._transferMode = data.transferMode ?? 'binary';
        this._startedAt = data.startedAt;
        this._completedAt = data.completedAt;
        this._preserveTimestamp = data.preserveTimestamp ?? false;
    }

    // ── Accessors ─────────────────────────────────────────────────────

    get id(): string { return this._id; }
    get connectionId(): string { return this._connectionId; }
    get localPath(): string { return this._localPath; }
    get remotePath(): string { return this._remotePath; }

    /**
     * Used by the engine when applying the `'rename'` overwrite rule:
     * the target side gets a unique suffix (e.g. `file (1).txt`) so the
     * existing file is preserved.
     */
    retarget(side: 'local' | 'remote', newPath: string): void {
        if (side === 'local') {
            this._localPath = newPath;
        } else {
            this._remotePath = newPath;
        }
    }
    get direction(): TransferDirection { return this._direction; }
    get status(): TransferStatus { return this._status; }
    get totalBytes(): number { return this._totalBytes; }
    get transferredBytes(): number { return this._transferredBytes; }
    get bytesPerSecond(): number { return this._bytesPerSecond; }
    get error(): string | undefined { return this._error; }
    get retryCount(): number { return this._retryCount; }
    get maxRetries(): number { return this._maxRetries; }
    get overwriteRule(): OverwriteRule { return this._overwriteRule; }
    get transferMode(): 'binary' | 'ascii' { return this._transferMode; }
    get startedAt(): number | undefined { return this._startedAt; }
    get completedAt(): number | undefined { return this._completedAt; }
    get preserveTimestamp(): boolean { return this._preserveTimestamp; }
    get abortSignal(): AbortSignal { return this._abortController.signal; }
    /** Byte offset to resume from (0 = start from scratch). Set on pause of an active transfer. */
    get resumeOffset(): number { return this._resumeOffset; }

    // ── State transitions ─────────────────────────────────────────────

    /** Move from queued -> active. */
    activate(): void {
        this.assertTransition('activate', ['queued']);
        this._status = 'active';
        this._startedAt = Date.now();
        this._lastProgressTime = Date.now();
        // Seed the speed baseline with the already-transferred bytes so a
        // resumed transfer doesn't report one huge fake speed spike.
        this._lastProgressBytes = this._transferredBytes;
        this._error = undefined;
    }

    /** Mark transfer as completed. */
    complete(): void {
        this.assertTransition('complete', ['active']);
        this._status = 'completed';
        this._completedAt = Date.now();
        this._bytesPerSecond = 0;
    }

    /** Mark transfer as failed with an error message. */
    fail(error: string): void {
        this.assertTransition('fail', ['active', 'queued']);
        this._status = 'failed';
        this._error = error;
        this._bytesPerSecond = 0;
    }

    /**
     * Pause the transfer. For an active transfer this records the current
     * byte position as the resume offset and aborts in-flight I/O so the
     * stream stops (the adapter's abort handler destroys the stream). A queued
     * item simply won't be started.
     */
    pause(): void {
        this.assertTransition('pause', ['active', 'queued']);
        if (this._status === 'active') {
            this._resumeOffset = this._transferredBytes;
            // Signal the adapter to stop the current stream. resume() installs
            // a fresh controller so the resumed transfer isn't pre-aborted.
            this._abortController.abort();
        }
        this._status = 'paused';
        this._bytesPerSecond = 0;
    }

    /** Resume a paused transfer (back to queued for re-processing from the offset). */
    resume(): void {
        this.assertTransition('resume', ['paused']);
        // The controller was aborted on pause; replace it so the resumed
        // transfer starts with a clean, un-aborted signal.
        this._abortController = new AbortController();
        this._status = 'queued';
    }

    /** Cancel the transfer and signal in-flight I/O to abort. */
    cancel(): void {
        this.assertTransition('cancel', ['queued', 'active', 'paused']);
        this._status = 'cancelled';
        this._bytesPerSecond = 0;
        this._abortController.abort();
    }

    /** Retry a failed transfer from scratch. */
    retry(): void {
        this.assertTransition('retry', ['failed', 'cancelled']);
        this._retryCount++;
        this._status = 'queued';
        this._error = undefined;
        this._transferredBytes = 0;
        this._resumeOffset = 0;
        this._bytesPerSecond = 0;
        this._startedAt = undefined;
        this._completedAt = undefined;
        this._abortController = new AbortController();
    }

    // ── Progress ──────────────────────────────────────────────────────

    /**
     * Update progress counters and compute the current transfer speed.
     */
    updateProgress(transferred: number, total: number): void {
        this._transferredBytes = transferred;
        this._totalBytes = total;

        const now = Date.now();
        const elapsed = (now - this._lastProgressTime) / 1000; // seconds

        if (elapsed >= 0.5) {
            const deltaBytes = transferred - this._lastProgressBytes;
            this._bytesPerSecond = elapsed > 0 ? Math.round(deltaBytes / elapsed) : 0;
            this._lastProgressTime = now;
            this._lastProgressBytes = transferred;
        }
    }

    // ── Serialisation ─────────────────────────────────────────────────

    /** Return a plain data snapshot (no methods). */
    toData(): TransferItemData {
        return {
            id: this._id,
            connectionId: this._connectionId,
            localPath: this._localPath,
            remotePath: this._remotePath,
            direction: this._direction,
            status: this._status,
            totalBytes: this._totalBytes,
            transferredBytes: this._transferredBytes,
            bytesPerSecond: this._bytesPerSecond,
            error: this._error,
            retryCount: this._retryCount,
            maxRetries: this._maxRetries,
            overwriteRule: this._overwriteRule,
            transferMode: this._transferMode,
            startedAt: this._startedAt,
            completedAt: this._completedAt,
            preserveTimestamp: this._preserveTimestamp,
        };
    }

    // ── Private ───────────────────────────────────────────────────────

    private assertTransition(action: string, validFrom: TransferStatus[]): void {
        if (!validFrom.includes(this._status)) {
            throw new Error(
                `Cannot ${action} transfer "${this._id}": current status is "${this._status}", expected one of [${validFrom.join(', ')}]`
            );
        }
    }
}
