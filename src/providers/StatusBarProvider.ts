import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { TransferQueue } from '../core/transfer/TransferQueue';
import { TransferItemData } from '../core/models/interfaces';
import { formatSpeed } from '../utils/formatUtils';

/**
 * Manages two status bar items:
 *
 * 1. **Connection indicator** (left, priority 100)
 *    Shows "$(plug) Disconnected" or "$(plug) user@host" when connected.
 *
 * 2. **Transfer speed indicator** (right, priority 99)
 *    Visible only while transfers are active, showing aggregate speed.
 */
export class StatusBarProvider implements vscode.Disposable {
    private readonly connectionItem: vscode.StatusBarItem;
    private readonly speedItem: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        connectionManager: ConnectionManager,
        transferQueue: TransferQueue,
    ) {
        // ── Connection status ─────────────────────────────────────────
        this.connectionItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100,
        );
        this.connectionItem.command = 'ftpManager.quickConnect';
        this.setDisconnected();
        this.connectionItem.show();

        // ── Transfer speed ────────────────────────────────────────────
        this.speedItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99,
        );
        this.speedItem.hide();

        // ── Subscribe to events ───────────────────────────────────────
        this.disposables.push(
            connectionManager.onDidConnect(({ profile }) => {
                this.connectionItem.text = `$(plug) ${profile.username}@${profile.host}`;
                this.connectionItem.tooltip = `Connected to ${profile.host}:${profile.port} (${profile.protocol.toUpperCase()})`;
                this.connectionItem.command = 'ftpManager.disconnect';
            }),

            connectionManager.onDidDisconnect(() => {
                this.setDisconnected();
            }),

            connectionManager.onConnectionError(() => {
                this.setDisconnected();
            }),

            transferQueue.onDidChange((items) => {
                this.updateSpeed(items);
            }),
        );
    }

    dispose(): void {
        this.connectionItem.dispose();
        this.speedItem.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    // ── Private helpers ───────────────────────────────────────────────

    private setDisconnected(): void {
        this.connectionItem.text = '$(plug) Disconnected';
        this.connectionItem.tooltip = 'Click to connect';
        this.connectionItem.command = 'ftpManager.quickConnect';
    }

    private updateSpeed(items: TransferItemData[]): void {
        const activeItems = items.filter((i) => i.status === 'active');
        if (activeItems.length === 0) {
            this.speedItem.hide();
            return;
        }

        const totalSpeed = activeItems.reduce((sum, i) => sum + i.bytesPerSecond, 0);
        this.speedItem.text = `$(arrow-swap) ${formatSpeed(totalSpeed)}`;
        this.speedItem.tooltip = `${activeItems.length} active transfer(s)`;
        this.speedItem.show();
    }
}
