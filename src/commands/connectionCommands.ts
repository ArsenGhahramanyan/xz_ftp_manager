import * as vscode from 'vscode';
import { SiteManagerNode } from '../core/models/interfaces';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { StorageService } from '../services/StorageService';
import { SecretStorageService } from '../services/SecretStorageService';
import { LogService } from '../services/LogService';
import { DualPaneWebviewProvider } from '../providers/DualPaneWebviewProvider';
import { TransferQueue } from '../core/transfer/TransferQueue';
import { sanitizeForUi } from '../utils/messageSanitizer';
import { makeId } from '../utils/idUtils';

/**
 * Registers the connection-related commands:
 *   - ftpManager.connect
 *   - ftpManager.disconnect
 *   - ftpManager.quickConnect
 */
export function registerConnectionCommands(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    storageService: StorageService,
    secretStorageService: SecretStorageService,
    logService: LogService,
    webviewProvider: DualPaneWebviewProvider,
    transferQueue: TransferQueue,
): void {

    // ── Connect ───────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.connect', async (node?: SiteManagerNode) => {
            try {
                let profileId: string | undefined;

                if (node && node.type === 'site' && node.profileId) {
                    profileId = node.profileId;
                } else {
                    // Let the user pick from saved profiles.
                    const profiles = storageService.getProfiles();
                    if (profiles.length === 0) {
                        vscode.window.showInformationMessage(
                            'No saved sites. Use Quick Connect or add a site first.',
                        );
                        return;
                    }

                    const pick = await vscode.window.showQuickPick(
                        profiles.map((p) => ({
                            label: p.name,
                            description: `${p.protocol.toUpperCase()} — ${p.username}@${p.host}:${p.port}`,
                            profileId: p.id,
                        })),
                        { placeHolder: 'Select a site to connect' },
                    );
                    if (!pick) {
                        return;
                    }
                    profileId = pick.profileId;
                }

                const profile = storageService.getProfileById(profileId!);
                if (!profile) {
                    vscode.window.showErrorMessage('Connection profile not found.');
                    return;
                }

                // Already connected? Just focus the panel for that profile.
                if (connectionManager.isConnected(profile.id)) {
                    webviewProvider.openPanelForProfile(profile.id);
                    return;
                }

                const password = await secretStorageService.getPassword(profile.id);
                const passphrase =
                    profile.authMethod === 'privateKey' || profile.authMethod === 'keyAndPassword'
                        ? await secretStorageService.getPassphrase(profile.id)
                        : undefined;

                logService.info(`Connecting to ${profile.name} (${profile.host}:${profile.port})...`);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Connecting to ${profile.name}...`,
                        cancellable: false,
                    },
                    async () => {
                        await connectionManager.connect(profile, password, passphrase);
                    },
                );

                logService.info(`Connected to ${profile.name}`);
                webviewProvider.openPanelForProfile(profile.id);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logService.error(`Connection failed: ${message}`);
                vscode.window.showErrorMessage(`Connection failed: ${sanitizeForUi(message)}`);
            }
        }),
    );

    // ── Disconnect ────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.disconnect', async () => {
            try {
                const ids = connectionManager.getAllConnectionIds();
                if (ids.length === 0) {
                    vscode.window.showInformationMessage('No active connections.');
                    return;
                }

                let target: string;
                if (ids.length === 1) {
                    target = ids[0];
                } else {
                    const items = ids.map((id) => {
                        const profile = storageService.getProfileById(id);
                        return {
                            label: profile?.name ?? id,
                            description: profile ? `${profile.username}@${profile.host}:${profile.port}` : '',
                            id,
                        };
                    });
                    const pick = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select connection to disconnect',
                    });
                    if (!pick) {
                        return;
                    }
                    target = pick.id;
                }

                const busy = transferQueue
                    .getItems()
                    .filter((i) => i.connectionId === target && (i.status === 'active' || i.status === 'queued')).length;
                if (busy > 0) {
                    const choice = await vscode.window.showWarningMessage(
                        `${busy} transfer(s) in progress. Disconnecting will cancel them.`,
                        { modal: true },
                        'Disconnect',
                    );
                    if (choice !== 'Disconnect') {
                        return;
                    }
                }

                await connectionManager.disconnect(target);
                const profile = storageService.getProfileById(target);
                logService.info(`Disconnected from ${profile?.name ?? target}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logService.error(`Disconnect error: ${message}`);
                vscode.window.showErrorMessage(`Disconnect failed: ${sanitizeForUi(message)}`);
            }
        }),
    );

    // ── Quick Connect ─────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.quickConnect', async () => {
            try {
                // Step 1: Protocol
                const protocolPick = await vscode.window.showQuickPick(
                    [
                        { label: 'SFTP', description: 'SSH File Transfer Protocol', value: 'sftp' as const },
                        { label: 'FTP', description: 'File Transfer Protocol', value: 'ftp' as const },
                        { label: 'FTPS', description: 'FTP over TLS', value: 'ftps' as const },
                    ],
                    { placeHolder: 'Select protocol' },
                );
                if (!protocolPick) {
                    return;
                }

                // Step 2: Host
                const host = await vscode.window.showInputBox({
                    prompt: 'Hostname or IP address',
                    placeHolder: 'example.com',
                    validateInput: (v) => (v.trim() ? undefined : 'Host is required'),
                });
                if (!host) {
                    return;
                }

                // Step 3: Port
                const defaultPort = protocolPick.value === 'sftp' ? '22' : '21';
                const portStr = await vscode.window.showInputBox({
                    prompt: 'Port',
                    value: defaultPort,
                    validateInput: (v) => {
                        const n = parseInt(v, 10);
                        return n > 0 && n <= 65535 ? undefined : 'Enter a valid port (1-65535)';
                    },
                });
                if (!portStr) {
                    return;
                }

                // Step 4: Username
                const username = await vscode.window.showInputBox({
                    prompt: 'Username',
                    placeHolder: 'anonymous',
                    validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
                });
                if (!username) {
                    return;
                }

                // Step 5: Password
                const password = await vscode.window.showInputBox({
                    prompt: 'Password',
                    password: true,
                });
                if (password === undefined) {
                    return;
                }

                // Build a temporary profile and connect.
                const profile = {
                    id: makeId('quick'),
                    name: `${username}@${host.trim()}`,
                    protocol: protocolPick.value,
                    host: host.trim(),
                    port: parseInt(portStr, 10),
                    username: username.trim(),
                    encryptionMode: protocolPick.value === 'ftps' ? 'explicit' as const : 'none' as const,
                    authMethod: 'password' as const,
                    transferMode: 'auto' as const,
                    initialRemotePath: '/',
                    keepalive: { enabled: true, intervalSeconds: 60 },
                    timeoutSeconds: 30,
                    maxConcurrentTransfers: 2,
                    encoding: 'utf-8',
                    passiveMode: true,
                };

                logService.info(`Quick connect: ${username}@${host}:${portStr} (${protocolPick.value})`);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Connecting to ${host.trim()}...`,
                        cancellable: false,
                    },
                    async () => {
                        await connectionManager.connect(profile, password);
                    },
                );

                logService.info(`Connected via Quick Connect to ${host.trim()}`);
                webviewProvider.openPanelForProfile(profile.id);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logService.error(`Quick connect failed: ${message}`);
                vscode.window.showErrorMessage(`Quick connect failed: ${sanitizeForUi(message)}`);
            }
        }),
    );
}
