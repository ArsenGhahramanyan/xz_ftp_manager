import * as vscode from 'vscode';
import { ConnectionManager } from './ConnectionManager';

/**
 * Periodically pings active connections with a lightweight `pwd()` call
 * so that idle connections are not dropped by the server.
 *
 * After {@link MAX_CONSECUTIVE_FAILURES} consecutive ping failures the
 * connection is forcibly disconnected, so that the UI can show an
 * accurate offline state instead of pretending the socket is alive.
 */
export class KeepaliveManager implements vscode.Disposable {
    /**
     * Disconnect after this many consecutive keepalive failures.
     * With the default 60s interval this gives 5 minutes of grace before
     * the extension forces a disconnect on a wedged socket.
     */
    private static readonly MAX_CONSECUTIVE_FAILURES = 5;

    /** profileId -> intervalHandle */
    private timers = new Map<string, ReturnType<typeof setInterval>>();
    /** profileId -> number of consecutive pwd() failures */
    private failures = new Map<string, number>();
    private disposables: vscode.Disposable[] = [];

    /**
     * @param connectionManager  The ConnectionManager to observe.
     * @param getKeepaliveInterval  Returns the keepalive interval in **milliseconds**
     *                              for a given profile id, or 0 / undefined to disable.
     */
    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly getKeepaliveInterval: (profileId: string) => number,
    ) {
        // Start keepalive when a connection is established
        this.disposables.push(
            this.connectionManager.onDidConnect(({ profileId }) => {
                this.startKeepalive(profileId);
            }),
        );

        // Stop keepalive when a connection drops
        this.disposables.push(
            this.connectionManager.onDidDisconnect(({ profileId }) => {
                this.stopKeepalive(profileId);
            }),
        );
    }

    // ── Public ────────────────────────────────────────────────────────

    dispose(): void {
        for (const [id] of this.timers) {
            this.stopKeepalive(id);
        }
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    // ── Private ───────────────────────────────────────────────────────

    private startKeepalive(profileId: string): void {
        // Clear any previous timer for this profile
        this.stopKeepalive(profileId);

        const intervalMs = this.getKeepaliveInterval(profileId);
        if (!intervalMs || intervalMs <= 0) {
            return;
        }

        this.failures.set(profileId, 0);

        const handle = setInterval(async () => {
            const adapter = this.connectionManager.getAdapter(profileId);
            if (!adapter || !adapter.isConnected()) {
                this.stopKeepalive(profileId);
                return;
            }
            try {
                await adapter.pwd();
                this.failures.set(profileId, 0);
            } catch {
                const count = (this.failures.get(profileId) ?? 0) + 1;
                this.failures.set(profileId, count);
                if (count >= KeepaliveManager.MAX_CONSECUTIVE_FAILURES) {
                    // Socket is wedged; force a disconnect so onDidDisconnect fires
                    // and UI reflects reality. Marked NOT user-initiated so the
                    // auto-reconnect handler can take over.
                    this.stopKeepalive(profileId);
                    void this.connectionManager
                        .disconnect(profileId, { userInitiated: false })
                        .catch(() => {
                            /* best effort */
                        });
                }
            }
        }, intervalMs);

        this.timers.set(profileId, handle);
    }

    private stopKeepalive(profileId: string): void {
        const handle = this.timers.get(profileId);
        if (handle !== undefined) {
            clearInterval(handle);
            this.timers.delete(profileId);
        }
        this.failures.delete(profileId);
    }
}
