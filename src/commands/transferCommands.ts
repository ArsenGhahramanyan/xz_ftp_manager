import * as vscode from 'vscode';
import { TransferQueue } from '../core/transfer/TransferQueue';
import { sanitizeForUi } from '../utils/messageSanitizer';

/**
 * Registers transfer-queue management commands:
 *   - ftpManager.pauseTransfer
 *   - ftpManager.resumeTransfer
 *   - ftpManager.cancelTransfer
 *   - ftpManager.retryTransfer
 *   - ftpManager.pauseAllTransfers
 *   - ftpManager.resumeAllTransfers
 *   - ftpManager.cancelAllTransfers
 *   - ftpManager.retryAllFailed
 *   - ftpManager.clearCompleted
 */
export function registerTransferCommands(
    context: vscode.ExtensionContext,
    transferQueue: TransferQueue,
): void {

    // ── Single-item actions ───────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.pauseTransfer', (itemId: string) => {
            try {
                transferQueue.pause(itemId);
            } catch (err) {
                vscode.window.showErrorMessage(`Pause failed: ${sanitizeForUi(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.resumeTransfer', (itemId: string) => {
            try {
                transferQueue.resume(itemId);
            } catch (err) {
                vscode.window.showErrorMessage(`Resume failed: ${sanitizeForUi(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.cancelTransfer', (itemId: string) => {
            try {
                transferQueue.cancel(itemId);
            } catch (err) {
                vscode.window.showErrorMessage(`Cancel failed: ${sanitizeForUi(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.retryTransfer', (itemId: string) => {
            try {
                transferQueue.retry(itemId);
            } catch (err) {
                vscode.window.showErrorMessage(`Retry failed: ${sanitizeForUi(err)}`);
            }
        }),
    );

    // ── Bulk actions ──────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.pauseAllTransfers', () => {
            transferQueue.pauseAll();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.resumeAllTransfers', () => {
            transferQueue.resumeAll();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.cancelAllTransfers', () => {
            transferQueue.cancelAll();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.retryAllFailed', () => {
            transferQueue.retryAllFailed();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.clearCompleted', () => {
            transferQueue.clearCompleted();
        }),
    );
}
