import * as vscode from 'vscode';
import { ConfigService } from '../services/ConfigService';

/**
 * Registers file-view commands that are not driven directly by the webview:
 *   - ftpManager.toggleHidden
 *
 * All actual file operations (upload/download/delete/rename/mkdir/chmod) are
 * handled inside DualPaneWebviewProvider via typed webview messages, so no
 * separate command registrations are needed for them.
 */
export function registerFileCommands(
    context: vscode.ExtensionContext,
    configService: ConfigService,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.toggleHidden', async () => {
            const current = configService.getShowHiddenFiles();
            await vscode.workspace
                .getConfiguration('ftpManager')
                .update('showHiddenFiles', !current, vscode.ConfigurationTarget.Global);
        }),
    );
}
