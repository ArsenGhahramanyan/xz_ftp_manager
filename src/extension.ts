import * as vscode from 'vscode';
import { LogService } from './services/LogService';
import { ConfigService } from './services/ConfigService';
import { StorageService } from './services/StorageService';
import { SecretStorageService } from './services/SecretStorageService';
import { ConnectionManager } from './core/connection/ConnectionManager';
import { KeepaliveManager } from './core/connection/KeepaliveManager';
import { LocalFileSystem } from './core/filesystem/LocalFileSystem';
import { RemoteFileSystem } from './core/filesystem/RemoteFileSystem';
import { TransferQueue } from './core/transfer/TransferQueue';
import { TransferEngine } from './core/transfer/TransferEngine';
import { SearchService } from './services/SearchService';
import { TempFileService } from './services/TempFileService';
import { FileWatcherService } from './services/FileWatcherService';
import { SiteManagerTreeProvider } from './providers/SiteManagerTreeProvider';
import { StatusBarProvider } from './providers/StatusBarProvider';
import { DualPaneWebviewProvider } from './providers/DualPaneWebviewProvider';
import { ConnectionEditorProvider } from './providers/ConnectionEditorProvider';
import { registerAllCommands } from './commands/index';
import { ProfileSettings } from './utils/profileSettings';
import { HostKeyVerifier } from './core/models/interfaces';

export function activate(context: vscode.ExtensionContext): void {
    // ── Services ──────────────────────────────────────────────────────
    const configService = new ConfigService();
    const logService = new LogService(configService);
    const storageService = new StorageService(context);
    const secretStorageService = new SecretStorageService(context);

    // ── Core ──────────────────────────────────────────────────────────
    const connectionManager = new ConnectionManager();
    const localFs = new LocalFileSystem();
    const remoteFs = new RemoteFileSystem(connectionManager);

    // TransferQueue requires a concurrency limit and a processing callback.
    // Use a late-bound reference so the engine and queue can reference each other.
    let engine: TransferEngine | undefined;
    const transferQueue = new TransferQueue(
        configService.getMaxConcurrentTransfers(),
        (item) => engine!.processTransfer(item),
        // Protocol capabilities gate per-connection concurrency and pausing:
        // FTP/FTPS run one transfer at a time and can't pause mid-flight.
        (connectionId) => connectionManager.getAdapter(connectionId)?.capabilities,
    );
    engine = new TransferEngine(transferQueue, connectionManager, configService, async ({ target }) => {
        const choice = await vscode.window.showWarningMessage(
            `"${target}" already exists. Overwrite?`,
            { modal: true },
            'Overwrite',
            'Skip',
        );
        return choice === 'Overwrite' ? 'overwrite' : 'skip';
    });

    // KeepaliveManager takes (profileId) => interval in ms.
    const keepaliveManager = new KeepaliveManager(
        connectionManager,
        (_profileId: string) => configService.getKeepaliveInterval() * 1000,
    );

    const tempFileService = new TempFileService();
    const searchService = new SearchService(connectionManager);
    const profileSettings = new ProfileSettings(configService, storageService);
    const fileWatcherService = new FileWatcherService(
        tempFileService,
        transferQueue,
        configService,
        profileSettings,
    );

    // ── Providers ─────────────────────────────────────────────────────
    const siteManagerTreeProvider = new SiteManagerTreeProvider(storageService);
    const statusBarProvider = new StatusBarProvider(connectionManager, transferQueue);
    const webviewProvider = new DualPaneWebviewProvider(
        context,
        connectionManager,
        localFs,
        remoteFs,
        transferQueue,
        configService,
        logService,
        tempFileService,
        storageService,
        secretStorageService,
        searchService,
        profileSettings,
    );
    const connectionEditor = new ConnectionEditorProvider(context, secretStorageService);

    // ── Tree views ────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.createTreeView('ftpManager.siteManager', {
            treeDataProvider: siteManagerTreeProvider,
            dragAndDropController: siteManagerTreeProvider,
            canSelectMany: false,
            showCollapseAll: true,
        }),
    );

    // Seed the default FTP / FTPS / SFTP folders on first run. Fire-and-forget:
    // activation must stay synchronous, so refresh the tree once seeding lands.
    void storageService.ensureDefaultFolders().then(
        (seeded) => {
            if (seeded) {
                siteManagerTreeProvider.refresh();
            }
        },
        (err) => logService.error(`Failed to create default folders: ${err}`),
    );

    // ── Commands ──────────────────────────────────────────────────────
    const openPanelCmd = vscode.commands.registerCommand(
        'ftpManager.openPanel',
        () => webviewProvider.openPanel(),
    );
    const navigateRemoteCmd = vscode.commands.registerCommand(
        'ftpManager.navigateRemote',
        (remotePath: string, profileId?: string) => webviewProvider.navigateRemote(remotePath, profileId),
    );
    const openConnectionLogCmd = vscode.commands.registerCommand(
        'ftpManager.openConnectionLog',
        () => logService.showMainChannel(),
    );
    const openTransferLogCmd = vscode.commands.registerCommand(
        'ftpManager.openTransferLog',
        () => logService.showTransferChannel(),
    );

    // ── React to configuration changes ───────────────────────────────
    const configSub = configService.onDidChange(() => {
        transferQueue.setMaxConcurrent(configService.getMaxConcurrentTransfers());
    });

    // ── Pipe adapter protocol chatter into the log channel ────────────
    const adapterLogSub = connectionManager.onAdapterLog(({ level, message }) => {
        if (level === 'command') {
            logService.command(message);
        } else if (level === 'response') {
            logService.response(message);
        } else if (level === 'error') {
            logService.error(message);
        } else {
            logService.info(message);
        }
    });

    // ── Auto-reconnect on unexpected disconnect ──────────────────────
    // If the adapter / keepalive forces a disconnect (network drop, server
    // kicked us, socket wedged) try to reconnect with exponential backoff.
    // Skipped for user-initiated disconnects and for ephemeral profiles.
    const MAX_RECONNECT_ATTEMPTS = 5;
    const reconnectInFlight = new Set<string>();

    async function tryReconnectLoop(profileId: string): Promise<void> {
        if (reconnectInFlight.has(profileId)) {
            return;
        }
        reconnectInFlight.add(profileId);
        try {
            for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
                const profile = storageService.getProfileById(profileId);
                if (!profile) {
                    return; // profile was deleted while we were waiting
                }
                if (connectionManager.isConnected(profileId)) {
                    return; // user (or earlier attempt) restored the connection
                }

                // Exponential backoff with ±20% jitter so multiple windows /
                // profiles that dropped at the same instant don't retry the
                // server in lockstep.
                const backoff = Math.min(60_000, 2_000 * Math.pow(2, attempt - 1));
                const delayMs = Math.round(backoff * (0.8 + Math.random() * 0.4));
                logService.info(
                    `Auto-reconnect to "${profile.name}" attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delayMs / 1000)}s.`,
                );
                await new Promise((r) => setTimeout(r, delayMs));

                if (connectionManager.isConnected(profileId)) {
                    return;
                }

                try {
                    const password = await secretStorageService.getPassword(profileId);
                    const passphrase =
                        profile.authMethod === 'privateKey' || profile.authMethod === 'keyAndPassword'
                            ? await secretStorageService.getPassphrase(profileId)
                            : undefined;
                    await connectionManager.connect(profile, password, passphrase);
                    logService.info(`Auto-reconnected to "${profile.name}".`);
                    return;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logService.error(
                        `Auto-reconnect to "${profile.name}" attempt ${attempt} failed: ${message}`,
                    );
                    // Stop retrying on non-transient errors. Looping on bad
                    // credentials or a host-key mismatch only spams the user.
                    if (/auth|permission|forbidden|denied|password|host key|fingerprint/i.test(message)) {
                        logService.error(
                            `Auto-reconnect to "${profile.name}" stopped: error is not transient.`,
                        );
                        return;
                    }
                }
            }
            const profile = storageService.getProfileById(profileId);
            logService.error(
                `Auto-reconnect to "${profile?.name ?? profileId}" gave up after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
            );
        } finally {
            reconnectInFlight.delete(profileId);
        }
    }

    const reconnectSub = connectionManager.onDidDisconnect(({ profileId, reason, userInitiated }) => {
        if (userInitiated) {
            return;
        }
        if (!storageService.getProfileById(profileId)) {
            return; // ephemeral / quick-connect
        }
        logService.info(`Connection to profile ${profileId} lost (${reason}). Scheduling auto-reconnect.`);
        void tryReconnectLoop(profileId);
    });

    // ── TOFU: verify SFTP host key BEFORE authentication ──────────────
    // Runs inside ssh2's hostVerifier during key exchange, so credentials are
    // never sent to a host the user has not trusted. Trusting an unknown key
    // pins it to the profile for subsequent connects.
    const hostKeyVerifier: HostKeyVerifier = async ({ profileId, host, port, fingerprint }) => {
        const p = storageService.getProfileById(profileId);
        const pretty = fingerprint.match(/.{2}/g)?.join(':') ?? fingerprint;
        const choice = await vscode.window.showWarningMessage(
            `New SSH host key for "${p?.name ?? host}" (${host}:${port}).\n\nSHA256: ${pretty}\n\nVerify this fingerprint with the server administrator before trusting. Credentials are sent only after you trust it.`,
            { modal: true },
            'Trust and Save',
            'Disconnect',
        );
        if (choice === 'Trust and Save') {
            if (p) {
                p.pinnedHostKey = fingerprint;
                await storageService.saveProfile(p);
                logService.info(`Pinned SFTP host key for "${p.name}": ${fingerprint}`);
            } else {
                logService.info(`Trusted SFTP host key for ephemeral ${host}:${port} (not persisted).`);
            }
            return true;
        }
        logService.info(`User rejected unknown host key for "${p?.name ?? host}"; aborting connect.`);
        return false;
    };
    connectionManager.setHostKeyVerifier(hostKeyVerifier);
    connectionEditor.setHostKeyVerifier(hostKeyVerifier);

    // ── Tree refresh commands ─────────────────────────────────────────
    const refreshCmd = vscode.commands.registerCommand('ftpManager.refresh', () => {
        siteManagerTreeProvider.refresh();
    });

    registerAllCommands({
        context,
        connectionManager,
        transferQueue,
        storageService,
        secretStorageService,
        configService,
        logService,
        searchService,
        siteManagerTreeProvider,
        webviewProvider,
        connectionEditor,
    });

    // ── Disposables ───────────────────────────────────────────────────
    context.subscriptions.push(
        logService,
        configService,
        connectionManager,
        transferQueue,
        keepaliveManager,
        tempFileService,
        searchService,
        fileWatcherService,
        siteManagerTreeProvider,
        statusBarProvider,
        webviewProvider,
        connectionEditor,
        configSub,
        adapterLogSub,
        reconnectSub,
        openPanelCmd,
        navigateRemoteCmd,
        openConnectionLogCmd,
        openTransferLogCmd,
        refreshCmd,
    );
}

export function deactivate(): void {}
