import * as vscode from 'vscode';
import { SearchService } from '../services/SearchService';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { DualPaneWebviewProvider } from '../providers/DualPaneWebviewProvider';
import { sanitizeForUi } from '../utils/messageSanitizer';

/**
 * Registers remote search commands:
 *   - ftpManager.searchRemote
 */
export function registerSearchCommands(
    context: vscode.ExtensionContext,
    searchService: SearchService,
    connectionManager?: ConnectionManager,
    webviewProvider?: DualPaneWebviewProvider,
): void {

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.searchRemote', async () => {
            // Get the pattern from the user.
            const pattern = await vscode.window.showInputBox({
                prompt: 'Search pattern (glob or regex)',
                placeHolder: '*.txt',
                validateInput: (v) => (v.trim() ? undefined : 'Pattern is required'),
            });
            if (!pattern) {
                return;
            }

            // Determine remote path to start searching from.
            const remotePath = await vscode.window.showInputBox({
                prompt: 'Remote directory to search in',
                value: '/',
            });
            if (remotePath === undefined) {
                return;
            }

            // Run with progress and cancellation support.
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Searching remote files...',
                    cancellable: true,
                },
                async (_progress, token) => {
                    try {
                        // Determine the active connection id.
                        const connectionId = connectionManager?.getAllConnectionIds()?.[0];
                        if (!connectionId) {
                            vscode.window.showErrorMessage('No active connection. Connect first.');
                            return;
                        }

                        const results = await searchService.search(
                            connectionId,
                            {
                                pattern: pattern.trim(),
                                remotePath: remotePath.trim() || '/',
                                recursive: true,
                                matchCase: false,
                                useRegex: false,
                            },
                            token,
                        );

                        if (token.isCancellationRequested) {
                            vscode.window.showInformationMessage('Search cancelled.');
                            return;
                        }

                        if (results.length === 0) {
                            vscode.window.showInformationMessage(`No files matching "${pattern}" found.`);
                            return;
                        }

                        // Prefer the in-panel SearchResultsPanel for the
                        // bound webview — supports filtering and stays open
                        // for browsing many hits. Falls back to QuickPick
                        // if no panel is bound to this profile.
                        if (
                            webviewProvider &&
                            webviewProvider.presentSearchResults(connectionId, results, pattern.trim())
                        ) {
                            return;
                        }

                        // Show results in a quick pick so the user can select one.
                        const picks = results.map((entry) => ({
                            label: entry.name,
                            description: entry.path,
                            detail: `${entry.type} — ${entry.size} bytes`,
                            entry,
                        }));

                        const selected = await vscode.window.showQuickPick(picks, {
                            placeHolder: `${results.length} result(s) — select to navigate`,
                        });

                        if (selected) {
                            await vscode.commands.executeCommand(
                                'ftpManager.navigateRemote',
                                selected.entry.type === 'directory'
                                    ? selected.entry.path
                                    : selected.entry.path.substring(0, selected.entry.path.lastIndexOf('/')),
                                connectionId,
                            );
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Search failed: ${sanitizeForUi(err)}`);
                    }
                },
            );
        }),
    );
}
