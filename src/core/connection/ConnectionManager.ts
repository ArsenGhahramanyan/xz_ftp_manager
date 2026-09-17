import * as vscode from 'vscode';
import { ConnectionProfile, HostKeyVerifier, IProtocolAdapter } from '../models/interfaces';
import { ConnectionFactory } from './ConnectionFactory';

interface ActiveConnection {
    adapter: IProtocolAdapter;
    profile: ConnectionProfile;
    /** Subscriptions for the adapter's events (disconnect, log). */
    disconnectSub: vscode.Disposable;
    logSub?: vscode.Disposable;
}

/**
 * Manages the lifecycle of all FTP/FTPS/SFTP connections.
 */
export class ConnectionManager implements vscode.Disposable {
    private connections = new Map<string, ActiveConnection>();

    /** Injected before connect so SFTP host keys are verified during KEX. */
    private _hostKeyVerifier: HostKeyVerifier | undefined;

    // ── Events ────────────────────────────────────────────────────────

    private readonly _onDidConnect = new vscode.EventEmitter<{ profileId: string; profile: ConnectionProfile }>();
    public readonly onDidConnect = this._onDidConnect.event;

    private readonly _onDidDisconnect = new vscode.EventEmitter<{ profileId: string; reason: string; userInitiated: boolean }>();
    public readonly onDidDisconnect = this._onDidDisconnect.event;

    private readonly _onConnectionError = new vscode.EventEmitter<{ profileId: string; error: Error }>();
    public readonly onConnectionError = this._onConnectionError.event;

    private readonly _onAdapterLog = new vscode.EventEmitter<{ profileId: string; level: 'info' | 'command' | 'response' | 'error'; message: string }>();
    /** Forwarded protocol chatter from any active adapter (already redacted). */
    public readonly onAdapterLog = this._onAdapterLog.event;

    /**
     * Install the host-key verifier used for all subsequent SFTP connects.
     * The verifier runs during key exchange, before credentials are sent.
     */
    setHostKeyVerifier(verifier: HostKeyVerifier): void {
        this._hostKeyVerifier = verifier;
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Connect to a server described by `profile`.
     * If a connection with the same profile id already exists, it is disconnected first.
     */
    async connect(profile: ConnectionProfile, password?: string, passphrase?: string): Promise<IProtocolAdapter> {
        // Tear down any existing connection for this profile
        if (this.connections.has(profile.id)) {
            await this.disconnect(profile.id);
        }

        const adapter = ConnectionFactory.createAdapter(profile);

        // Verify SFTP host keys before authentication (no-op for FTP/FTPS).
        if (this._hostKeyVerifier) {
            adapter.setHostKeyVerifier?.(this._hostKeyVerifier);
        }

        // Listen for disconnects from the adapter itself. `expected` marks a
        // disconnect we caused deliberately (e.g. an FTP transfer cancel), so
        // it is treated as user-initiated and does not trigger auto-reconnect.
        const disconnectSub = adapter.onDidDisconnect(({ reason, expected }) => {
            this.handleAdapterDisconnect(profile.id, reason, expected === true);
        });

        // Forward protocol chatter (adapters already redact passwords in log callback).
        const logSub = adapter.onLog?.(({ level, message }) => {
            this._onAdapterLog.fire({ profileId: profile.id, level, message });
        });

        try {
            await adapter.connect(profile, password, passphrase);
        } catch (err) {
            disconnectSub.dispose();
            logSub?.dispose();
            adapter.dispose();
            const error = err instanceof Error ? err : new Error(String(err));
            this._onConnectionError.fire({ profileId: profile.id, error });
            throw error;
        }

        this.connections.set(profile.id, { adapter, profile, disconnectSub, logSub });
        this._onDidConnect.fire({ profileId: profile.id, profile });

        return adapter;
    }

    /**
     * Gracefully disconnect the connection for the given profile id.
     * @param opts.userInitiated  Defaults to `true`. Set to `false` for forced
     *                            disconnects (e.g. keepalive failure) so the
     *                            auto-reconnect handler can fire.
     */
    async disconnect(profileId: string, opts: { userInitiated?: boolean } = {}): Promise<void> {
        const conn = this.connections.get(profileId);
        if (!conn) {
            return;
        }
        const userInitiated = opts.userInitiated !== false;
        this.connections.delete(profileId);
        conn.disconnectSub.dispose();
        conn.logSub?.dispose();
        try {
            await conn.adapter.disconnect();
        } finally {
            conn.adapter.dispose();
        }
        this._onDidDisconnect.fire({
            profileId,
            reason: userInitiated ? 'User disconnect' : 'Forced disconnect',
            userInitiated,
        });
    }

    /**
     * Returns the adapter for a connected profile, or undefined.
     */
    getAdapter(profileId: string): IProtocolAdapter | undefined {
        return this.connections.get(profileId)?.adapter;
    }

    /**
     * Returns the first active connection (adapter + profile), or undefined.
     */
    getActiveConnection(): { adapter: IProtocolAdapter; profile: ConnectionProfile } | undefined {
        for (const conn of this.connections.values()) {
            if (conn.adapter.isConnected()) {
                return { adapter: conn.adapter, profile: conn.profile };
            }
        }
        return undefined;
    }

    isConnected(profileId: string): boolean {
        const conn = this.connections.get(profileId);
        return conn !== undefined && conn.adapter.isConnected();
    }

    getAllConnectionIds(): string[] {
        return Array.from(this.connections.keys());
    }

    // ── Disposal ──────────────────────────────────────────────────────

    dispose(): void {
        for (const [id, conn] of this.connections.entries()) {
            conn.disconnectSub.dispose();
            conn.adapter.disconnect().catch(() => { /* best effort */ });
            conn.adapter.dispose();
            this.connections.delete(id);
        }
        this._onDidConnect.dispose();
        this._onDidDisconnect.dispose();
        this._onConnectionError.dispose();
        this._onAdapterLog.dispose();
    }

    // ── Private ───────────────────────────────────────────────────────

    private handleAdapterDisconnect(profileId: string, reason: string, expected: boolean): void {
        const conn = this.connections.get(profileId);
        if (!conn) {
            return;
        }
        this.connections.delete(profileId);
        conn.disconnectSub.dispose();
        conn.logSub?.dispose();
        conn.adapter.dispose();
        // `expected` closes (e.g. our own FTP transfer-cancel) are surfaced as
        // user-initiated so the auto-reconnect handler leaves them alone.
        // Genuine drops (network, server kick) are userInitiated:false.
        this._onDidDisconnect.fire({ profileId, reason, userInitiated: expected });
    }
}
