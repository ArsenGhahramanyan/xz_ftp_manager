import * as vscode from 'vscode';
import * as path from 'path';
import {
    Web2ExtMessage,
    Ext2WebMessage,
    ConnectionProfile,
    Protocol,
    TransferItemData,
    SearchQuery,
    OverwriteRule,
} from '../core/models/interfaces';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { LocalFileSystem } from '../core/filesystem/LocalFileSystem';
import { RemoteFileSystem } from '../core/filesystem/RemoteFileSystem';
import { TransferQueue } from '../core/transfer/TransferQueue';
import { TransferItem } from '../core/transfer/TransferItem';
import { ConfigService } from '../services/ConfigService';
import { LogService } from '../services/LogService';
import { TempFileService } from '../services/TempFileService';
import { StorageService } from '../services/StorageService';
import { SecretStorageService } from '../services/SecretStorageService';
import { SearchService } from '../services/SearchService';
import { joinRemotePath, getParentPath, assertSafeEntryName, assertWithinDirectory } from '../utils/pathUtils';
import { makeId, makeNonce } from '../utils/idUtils';
import { sanitizeForUi } from '../utils/messageSanitizer';
import { ProfileSettings } from '../utils/profileSettings';

/**
 * One webview panel per connection. Each panel keeps its own local/remote
 * directory state, search, overwrite-prompt resolvers, and transfer queue
 * filter. Unbound panels (no `profileId`) show the Quick Connect bar; once
 * the user connects, the panel binds to that profile.
 */
interface PanelSession {
    panel: vscode.WebviewPanel;
    profileId: string | undefined;
    currentLocalPath: string;
    currentRemotePath: string;
    completedTransferIds: Set<string>;
    pendingOverwrite: Map<string, (rule: OverwriteRule | undefined) => void>;
    searchCts?: vscode.CancellationTokenSource;
    disposables: vscode.Disposable[];
}

export class DualPaneWebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'ftpManager.dualPane';

    private readonly sessionByPanel = new Map<vscode.WebviewPanel, PanelSession>();
    private readonly sessionByProfileId = new Map<string, PanelSession>();
    private readonly defaultLocalPath: string;
    private readonly globalDisposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly localFs: LocalFileSystem,
        private readonly remoteFs: RemoteFileSystem,
        private readonly transferQueue: TransferQueue,
        private readonly configService: ConfigService,
        private readonly logService: LogService,
        private readonly tempFileService: TempFileService,
        private readonly storageService: StorageService,
        _secretStorageService: SecretStorageService,
        private readonly searchService: SearchService,
        private readonly profileSettings: ProfileSettings,
    ) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        this.defaultLocalPath =
            this.configService.getDefaultLocalDirectory() ||
            (workspaceFolders?.[0]?.uri.fsPath ?? 'C:/');

        this.globalDisposables.push(
            this.connectionManager.onDidConnect(({ profileId, profile }) => {
                const session = this.sessionByProfileId.get(profileId);
                if (session) {
                    this.refreshConnectionStatus(session, profile);
                    void this.listRemote(session, session.currentRemotePath);
                }
            }),
            this.connectionManager.onDidDisconnect(({ profileId, reason }) => {
                const session = this.sessionByProfileId.get(profileId);
                if (!session) {
                    return;
                }
                this.unbindSession(session);
                this.postMessage(session, { type: 'connectionStatus', connected: false, reason });
                this.postMessage(session, {
                    type: 'directoryListing',
                    pane: 'remote',
                    path: '/',
                    entries: [],
                });
                this.postMessage(session, { type: 'transferQueueSnapshot', items: [] });
            }),
            this.transferQueue.onDidChange((items) => {
                for (const session of this.sessionByPanel.values()) {
                    const filtered = session.profileId
                        ? items.filter((i) => i.connectionId === session.profileId)
                        : [];
                    this.postMessage(session, { type: 'transferQueueSnapshot', items: filtered });
                    this.handleTransferQueueChange(session, filtered);
                }
            }),
        );
    }

    // ── Public API ────────────────────────────────────────────────────

    /** Open a new unbound panel — Quick Connect mode. */
    openPanel(): void {
        this.createPanel(undefined);
    }

    /**
     * Push search results into the panel bound to `profileId`. Returns
     * `true` if a panel existed (and was revealed); callers fall back to
     * a QuickPick when this returns `false`.
     */
    presentSearchResults(profileId: string, results: import('../core/models/interfaces').FileEntry[], pattern: string): boolean {
        const session = this.sessionByProfileId.get(profileId);
        if (!session) {
            return false;
        }
        session.panel.reveal(session.panel.viewColumn ?? vscode.ViewColumn.Active);
        this.postMessage(session, {
            type: 'searchResults',
            results,
            completed: true,
            pattern,
        });
        return true;
    }

    /** Open or focus a panel bound to the given profile. */
    openPanelForProfile(profileId: string): void {
        const existing = this.sessionByProfileId.get(profileId);
        if (existing) {
            existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
            return;
        }
        this.createPanel(profileId);
    }

    /**
     * Navigate the remote pane of a panel to `remotePath`. If `profileId` is
     * given, that panel is targeted (or created); otherwise the first
     * connected panel is used.
     */
    async navigateRemote(remotePath: string, profileId?: string): Promise<void> {
        let session: PanelSession | undefined;
        if (profileId) {
            session = this.sessionByProfileId.get(profileId);
            if (!session) {
                this.openPanelForProfile(profileId);
                session = this.sessionByProfileId.get(profileId);
            }
        } else {
            session = this.firstBoundSession();
        }
        if (!session?.profileId) {
            vscode.window.showWarningMessage('xZ FTP Manager: connect to a site first.');
            return;
        }
        session.panel.reveal(session.panel.viewColumn ?? vscode.ViewColumn.Active);
        await this.listRemote(session, remotePath);
    }

    dispose(): void {
        for (const session of [...this.sessionByPanel.values()]) {
            session.panel.dispose();
        }
        for (const d of this.globalDisposables) {
            d.dispose();
        }
    }

    // ── Panel lifecycle ───────────────────────────────────────────────

    private createPanel(profileId: string | undefined): PanelSession {
        const profile = profileId ? this.storageService.getProfileById(profileId) : undefined;
        const title = profile?.name ?? 'xZ FTP Manager';
        const panel = vscode.window.createWebviewPanel(
            DualPaneWebviewProvider.viewType,
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
                ],
            },
        );
        panel.iconPath = new vscode.ThemeIcon('files');
        panel.webview.html = this.getHtmlContent(panel.webview);

        const savedRemote = profileId
            ? this.storageService.getWorkspaceData<string | undefined>(
                `lastRemotePath.${profileId}`,
                undefined,
            )
            : undefined;
        const initialRemote = savedRemote || profile?.initialRemotePath || '/';

        const session: PanelSession = {
            panel,
            profileId,
            currentLocalPath: profile?.initialLocalPath || this.defaultLocalPath,
            currentRemotePath: initialRemote,
            completedTransferIds: new Set(),
            pendingOverwrite: new Map(),
            disposables: [],
        };

        this.sessionByPanel.set(panel, session);
        if (profileId) {
            this.sessionByProfileId.set(profileId, session);
        }

        session.disposables.push(
            panel.webview.onDidReceiveMessage((msg: Web2ExtMessage) => this.handleMessage(session, msg)),
            panel.onDidDispose(() => this.disposeSession(session)),
        );

        return session;
    }

    private disposeSession(session: PanelSession): void {
        const profileId = session.profileId;
        this.sessionByPanel.delete(session.panel);
        if (profileId) {
            this.sessionByProfileId.delete(profileId);
        }
        for (const d of session.disposables) {
            d.dispose();
        }
        session.searchCts?.dispose();

        // Closing the panel tears down the user's view of the connection — keep
        // the underlying socket aligned. Cancel in-flight transfers for this
        // profile before disconnecting so they fail fast instead of timing out.
        if (profileId && this.connectionManager.isConnected(profileId)) {
            const busy = this.transferQueue
                .getItems()
                .filter((i) => i.connectionId === profileId && (i.status === 'active' || i.status === 'queued'));
            if (busy.length > 0) {
                this.logService.info(
                    `Panel closed for profile ${profileId} with ${busy.length} in-flight transfer(s); cancelling.`,
                );
                for (const item of busy) {
                    try { this.transferQueue.cancel(item.id); } catch { /* skip */ }
                }
            }
            void this.connectionManager.disconnect(profileId).catch((err) => {
                this.logService.error(
                    `Disconnect on panel close failed for ${profileId}: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }
    }

    private bindSession(session: PanelSession, profileId: string): void {
        if (session.profileId === profileId) {
            return;
        }
        if (session.profileId) {
            this.sessionByProfileId.delete(session.profileId);
        }
        session.profileId = profileId;
        this.sessionByProfileId.set(profileId, session);
    }

    private unbindSession(session: PanelSession): void {
        if (session.profileId) {
            this.sessionByProfileId.delete(session.profileId);
            session.profileId = undefined;
        }
    }

    private firstBoundSession(): PanelSession | undefined {
        for (const session of this.sessionByPanel.values()) {
            if (session.profileId && this.connectionManager.isConnected(session.profileId)) {
                return session;
            }
        }
        return undefined;
    }

    private refreshConnectionStatus(session: PanelSession, profile: ConnectionProfile): void {
        session.panel.title = profile.name;
        const savedRemote = this.storageService.getWorkspaceData<string | undefined>(
            `lastRemotePath.${profile.id}`,
            undefined,
        );
        session.currentRemotePath = savedRemote || profile.initialRemotePath || '/';
        this.postMessage(session, {
            type: 'connectionStatus',
            connected: true,
            profileName: profile.name,
            host: profile.host,
            username: profile.username,
            port: profile.port,
            protocol: profile.protocol,
        });
    }

    // ── Message handling ──────────────────────────────────────────────

    private async handleMessage(session: PanelSession, msg: Web2ExtMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'ready':
                    await this.handleReady(session);
                    break;
                case 'navigate':
                    await this.handleNavigate(session, msg.pane, msg.path);
                    break;
                case 'refresh':
                    await this.handleRefresh(session, msg.pane);
                    break;
                case 'quickConnect':
                    await this.handleQuickConnect(session, msg.host, msg.port, msg.username, msg.password, msg.protocol);
                    break;
                case 'disconnect':
                    await this.handleDisconnect(session);
                    break;
                case 'upload':
                    await this.handleUpload(session, msg.localPaths, msg.remotePath);
                    break;
                case 'download':
                    await this.handleDownload(session, msg.remotePaths, msg.localPath);
                    break;
                case 'deleteItems':
                    await this.handleDeleteItems(session, msg.pane, msg.paths);
                    break;
                case 'rename':
                    await this.handleRename(session, msg.pane, msg.oldPath, msg.newName);
                    break;
                case 'createDirectory':
                    await this.handleCreateDirectory(session, msg.pane, msg.parentPath, msg.name);
                    break;
                case 'chmod':
                    await this.handleChmod(session, msg.remotePath, msg.mode);
                    break;
                case 'openFile':
                    await this.handleOpenFile(session, msg.pane, msg.path);
                    break;
                case 'toggleHidden':
                    await this.handleToggleHidden(session, msg.show);
                    break;
                case 'transferBulkAction':
                    this.handleTransferBulkAction(session, msg.action);
                    break;
                case 'transferAction':
                    this.handleTransferAction(msg.action, msg.itemId);
                    break;
                case 'dragDropTransfer':
                    await this.handleDragDrop(session, msg.sourcePaths, msg.sourcePane, msg.targetPath, msg.targetPane);
                    break;
                case 'listChildren':
                    await this.handleListChildren(session, msg.pane, msg.path);
                    break;
                case 'search':
                    await this.handleSearch(session, msg.query);
                    break;
                case 'cancelSearch':
                    session.searchCts?.cancel();
                    break;
                case 'overwriteResponse': {
                    const resolver = session.pendingOverwrite.get(msg.transferId);
                    if (resolver) {
                        session.pendingOverwrite.delete(msg.transferId);
                        resolver(msg.rule);
                    }
                    break;
                }
                case 'sort':
                case 'filter':
                    // Client-side concerns; accept silently.
                    break;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logService.error(`Webview message error [${msg.type}]: ${message}`);
            vscode.window.showErrorMessage(`xZ FTP Manager: ${sanitizeForUi(message)}`);
        }
    }

    // ── Handlers ──────────────────────────────────────────────────────

    private async handleReady(session: PanelSession): Promise<void> {
        if (session.profileId && this.connectionManager.isConnected(session.profileId)) {
            const profile = this.storageService.getProfileById(session.profileId);
            const live = this.connectionManager.getAdapter(session.profileId);
            if (profile && live) {
                this.postMessage(session, {
                    type: 'connectionStatus',
                    connected: true,
                    profileName: profile.name,
                    host: profile.host,
                    username: profile.username,
                    port: profile.port,
                    protocol: profile.protocol,
                });
            } else {
                this.postMessage(session, { type: 'connectionStatus', connected: false });
            }
        } else {
            this.postMessage(session, { type: 'connectionStatus', connected: false });
        }

        const items = session.profileId
            ? this.transferQueue.getItemsData().filter((i) => i.connectionId === session.profileId)
            : [];
        this.postMessage(session, { type: 'transferQueueSnapshot', items });

        this.postMessage(session, {
            type: 'settingsUpdate',
            showHidden: this.configService.getShowHiddenFiles(),
            transferMode: this.configService.getTransferMode(),
        });

        await this.listLocal(session, session.currentLocalPath);
        if (session.profileId && this.connectionManager.isConnected(session.profileId)) {
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private async handleNavigate(session: PanelSession, pane: 'local' | 'remote', dirPath: string): Promise<void> {
        if (pane === 'local') {
            await this.listLocal(session, dirPath);
        } else {
            await this.listRemote(session, dirPath);
        }
    }

    private async handleRefresh(session: PanelSession, pane: 'local' | 'remote'): Promise<void> {
        if (pane === 'local') {
            await this.listLocal(session, session.currentLocalPath);
        } else {
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private async handleDisconnect(session: PanelSession): Promise<void> {
        if (!session.profileId) {
            return;
        }
        const profileId = session.profileId;
        const busy = this.transferQueue
            .getItems()
            .filter((i) => i.connectionId === profileId && (i.status === 'active' || i.status === 'queued')).length;
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
        this.logService.info(`Disconnect requested from panel (${profileId})`);
        await this.connectionManager.disconnect(profileId);
    }

    private async handleQuickConnect(
        session: PanelSession,
        host: string,
        port: number,
        username: string,
        password: string,
        protocol: Protocol,
    ): Promise<void> {
        if (session.profileId && this.connectionManager.isConnected(session.profileId)) {
            vscode.window.showWarningMessage('This panel is already connected. Disconnect first.');
            return;
        }
        // Validate webview-provided inputs. For text-based FTP, CR/LF/NUL in
        // username could splice extra commands; refuse them outright.
        if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\r\n\0]/.test(host)) {
            vscode.window.showErrorMessage('Invalid host.');
            return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            vscode.window.showErrorMessage('Port must be an integer between 1 and 65535.');
            return;
        }
        if (typeof username !== 'string' || username.length > 255 || /[\r\n\0]/.test(username)) {
            vscode.window.showErrorMessage('Invalid username.');
            return;
        }
        // Reject control characters in the password too — for text-based FTP a
        // CR/LF could splice extra commands onto the control channel. (basic-ftp
        // also blocks this at the wire, but validate consistently up front.)
        if (typeof password !== 'string' || password.length > 1024 || /[\r\n\0]/.test(password)) {
            vscode.window.showErrorMessage('Invalid password.');
            return;
        }
        if (!['ftp', 'ftps', 'sftp'].includes(protocol)) {
            vscode.window.showErrorMessage('Invalid protocol.');
            return;
        }
        const tempProfile: ConnectionProfile = {
            id: makeId('quick'),
            name: `${username}@${host}`,
            protocol,
            host,
            port,
            username,
            encryptionMode: protocol === 'ftps' ? 'explicit' : 'none',
            authMethod: 'password',
            transferMode: 'auto',
            initialRemotePath: '/',
            keepalive: { enabled: true, intervalSeconds: 60 },
            timeoutSeconds: this.configService.getConnectionTimeout(),
            maxConcurrentTransfers: this.configService.getMaxConcurrentTransfers(),
            encoding: 'utf-8',
            passiveMode: true,
        };

        // Bind the panel BEFORE connecting so that `onDidConnect` finds it
        // and updates this panel rather than nothing.
        this.bindSession(session, tempProfile.id);

        this.logService.info(`Quick connect: ${username}@${host}:${port} (${protocol})`);
        try {
            await this.connectionManager.connect(tempProfile, password);
        } catch (err) {
            this.unbindSession(session);
            throw err;
        }
    }

    private async handleUpload(session: PanelSession, localPaths: string[], remotePath: string): Promise<void> {
        const profileId = this.requireConnection(session);
        for (const localPath of localPaths) {
            const fileName = path.basename(localPath);
            const remote = joinRemotePath(remotePath, fileName);
            const item = new TransferItem({
                connectionId: profileId,
                localPath,
                remotePath: remote,
                direction: 'upload',
                overwriteRule: this.profileSettings.overwriteRule(profileId),
                transferMode: this.profileSettings.transferMode(profileId) === 'ascii' ? 'ascii' : 'binary',
                preserveTimestamp: this.configService.getPreserveTimestamp(),
                maxRetries: this.configService.getRetryCount(),
            });
            this.transferQueue.enqueue(item);
        }
    }

    private async handleDownload(session: PanelSession, remotePaths: string[], localPath: string): Promise<void> {
        const profileId = this.requireConnection(session);
        for (const remoteSrc of remotePaths) {
            const fileName = path.basename(remoteSrc);
            // A server entry named exactly ".." would make path.join land in the
            // parent of the chosen directory. Reject traversal names and verify
            // the resolved target stays inside the destination.
            try {
                assertSafeEntryName(fileName);
                assertWithinDirectory(localPath, path.join(localPath, fileName));
            } catch (err) {
                this.logService.error(`Refusing unsafe download target for "${remoteSrc}": ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            const local = path.join(localPath, fileName);
            const item = new TransferItem({
                connectionId: profileId,
                localPath: local,
                remotePath: remoteSrc,
                direction: 'download',
                overwriteRule: this.profileSettings.overwriteRule(profileId),
                transferMode: this.profileSettings.transferMode(profileId) === 'ascii' ? 'ascii' : 'binary',
                preserveTimestamp: this.configService.getPreserveTimestamp(),
                maxRetries: this.configService.getRetryCount(),
            });
            this.transferQueue.enqueue(item);
        }
    }

    private async handleDeleteItems(session: PanelSession, pane: 'local' | 'remote', paths: string[]): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete ${paths.length} item(s)?`,
            { modal: true },
            'Delete',
        );
        if (confirm !== 'Delete') {
            return;
        }

        if (pane === 'local') {
            for (const p of paths) {
                try {
                    const stat = await this.localFs.stat(p);
                    await this.localFs.deleteItem(p, stat.type === 'directory');
                } catch (err) {
                    this.logService.error(`Failed to delete local item ${p}: ${err}`);
                }
            }
            await this.listLocal(session, session.currentLocalPath);
        } else {
            const profileId = this.requireConnection(session);
            for (const p of paths) {
                try {
                    const stat = await this.remoteFs.stat(profileId, p);
                    await this.remoteFs.deleteItem(profileId, p, stat.type === 'directory');
                } catch (err) {
                    this.logService.error(`Failed to delete remote item ${p}: ${err}`);
                }
            }
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private async handleRename(session: PanelSession, pane: 'local' | 'remote', oldPath: string, newName: string): Promise<void> {
        if (pane === 'local') {
            const dir = path.dirname(oldPath);
            const newPath = path.join(dir, newName);
            await this.localFs.rename(oldPath, newPath);
            await this.listLocal(session, session.currentLocalPath);
        } else {
            const profileId = this.requireConnection(session);
            const dir = getParentPath(oldPath);
            const newPath = joinRemotePath(dir, newName);
            await this.remoteFs.rename(profileId, oldPath, newPath);
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private async handleCreateDirectory(
        session: PanelSession,
        pane: 'local' | 'remote',
        parentPath: string,
        name: string,
    ): Promise<void> {
        if (pane === 'local') {
            const dirPath = path.join(parentPath, name);
            await this.localFs.createDirectory(dirPath);
            await this.listLocal(session, session.currentLocalPath);
        } else {
            const profileId = this.requireConnection(session);
            const dirPath = joinRemotePath(parentPath, name);
            await this.remoteFs.createDirectory(profileId, dirPath);
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private async handleChmod(session: PanelSession, remotePath: string, mode: number): Promise<void> {
        const profileId = this.requireConnection(session);
        await this.remoteFs.chmod(profileId, remotePath, mode);
        await this.listRemote(session, session.currentRemotePath);
    }

    private async handleOpenFile(session: PanelSession, pane: 'local' | 'remote', filePath: string): Promise<void> {
        if (pane === 'local') {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        } else {
            const profileId = this.requireConnection(session);
            const adapter = this.connectionManager.getAdapter(profileId);
            if (!adapter) {
                throw new Error('No active adapter');
            }
            await this.tempFileService.downloadAndOpen(profileId, filePath, adapter);
        }
    }

    private async handleToggleHidden(session: PanelSession, show: boolean): Promise<void> {
        await vscode.workspace
            .getConfiguration('ftpManager')
            .update('showHiddenFiles', show, vscode.ConfigurationTarget.Global);
        await this.listLocal(session, session.currentLocalPath);
        if (session.profileId && this.connectionManager.isConnected(session.profileId)) {
            await this.listRemote(session, session.currentRemotePath);
        }
    }

    private handleTransferBulkAction(
        session: PanelSession,
        action: 'pauseAll' | 'resumeAll' | 'cancelAll' | 'retryAllFailed' | 'clearCompleted',
    ): void {
        // Bulk actions affect only this panel's connection.
        const profileId = session.profileId;
        if (!profileId) {
            return;
        }
        const own = this.transferQueue.getItems().filter((i) => i.connectionId === profileId);
        switch (action) {
            case 'pauseAll':
                own.forEach((i) => this.transferQueue.pause(i.id));
                break;
            case 'resumeAll':
                own.forEach((i) => this.transferQueue.resume(i.id));
                break;
            case 'cancelAll':
                own.forEach((i) => this.transferQueue.cancel(i.id));
                break;
            case 'retryAllFailed':
                own.filter((i) => i.status === 'failed').forEach((i) => this.transferQueue.retry(i.id));
                break;
            case 'clearCompleted':
                own.filter((i) => i.status === 'completed').forEach((i) => this.transferQueue.remove(i.id));
                break;
        }
    }

    private handleTransferAction(
        action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove',
        itemId: string,
    ): void {
        switch (action) {
            case 'pause':
                this.transferQueue.pause(itemId);
                break;
            case 'resume':
                this.transferQueue.resume(itemId);
                break;
            case 'cancel':
                this.transferQueue.cancel(itemId);
                break;
            case 'retry':
                this.transferQueue.retry(itemId);
                break;
            case 'remove':
                this.transferQueue.remove(itemId);
                break;
        }
    }

    private async handleDragDrop(
        session: PanelSession,
        sourcePaths: string[],
        sourcePane: 'local' | 'remote',
        targetPath: string,
        _targetPane: 'local' | 'remote',
    ): Promise<void> {
        if (sourcePane === 'local') {
            await this.handleUpload(session, sourcePaths, targetPath);
        } else {
            await this.handleDownload(session, sourcePaths, targetPath);
        }
    }

    // ── Transfer completion → auto-refresh ────────────────────────────

    private handleTransferQueueChange(session: PanelSession, items: TransferItemData[]): void {
        const liveIds = new Set<string>();
        let refreshLocal = false;
        let refreshRemote = false;

        for (const item of items) {
            liveIds.add(item.id);
            if (item.status !== 'completed' || session.completedTransferIds.has(item.id)) {
                continue;
            }
            session.completedTransferIds.add(item.id);

            if (item.direction === 'upload') {
                const parent = getParentPath(item.remotePath);
                if (samePosix(parent, session.currentRemotePath)) {
                    refreshRemote = true;
                }
            } else {
                const parent = path.dirname(item.localPath);
                if (sameLocal(parent, session.currentLocalPath)) {
                    refreshLocal = true;
                }
            }
        }

        for (const id of session.completedTransferIds) {
            if (!liveIds.has(id)) {
                session.completedTransferIds.delete(id);
            }
        }

        if (refreshLocal) {
            void this.listLocal(session, session.currentLocalPath);
        }
        if (refreshRemote) {
            void this.listRemote(session, session.currentRemotePath);
        }
    }

    // ── Search ────────────────────────────────────────────────────────

    private async handleSearch(session: PanelSession, query: SearchQuery): Promise<void> {
        const profileId = this.requireConnection(session);

        session.searchCts?.cancel();
        session.searchCts = new vscode.CancellationTokenSource();
        const token = session.searchCts.token;

        try {
            const results = await this.searchService.search(profileId, query, token);
            this.postMessage(session, {
                type: 'searchResults',
                results,
                completed: !token.isCancellationRequested,
                pattern: query.pattern,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logService.error(`Search failed: ${message}`);
            this.postMessage(session, { type: 'searchResults', results: [], completed: true, pattern: query.pattern });
        } finally {
            if (session.searchCts?.token === token) {
                session.searchCts.dispose();
                session.searchCts = undefined;
            }
        }
    }

    // ── Directory listing helpers ─────────────────────────────────────

    private async listLocal(session: PanelSession, dirPath: string): Promise<void> {
        try {
            const entries = await this.localFs.listDirectory(dirPath);
            session.currentLocalPath = dirPath;
            this.postMessage(session, { type: 'directoryListing', pane: 'local', path: dirPath, entries });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.postMessage(session, { type: 'directoryError', pane: 'local', path: dirPath, error: message });
        }
    }

    private async listRemote(session: PanelSession, dirPath: string): Promise<void> {
        if (!session.profileId) {
            return;
        }
        const profileId = session.profileId;
        try {
            const entries = await this.remoteFs.listDirectory(profileId, dirPath);
            session.currentRemotePath = dirPath;
            await this.storageService.setWorkspaceData(`lastRemotePath.${profileId}`, dirPath);
            this.postMessage(session, { type: 'directoryListing', pane: 'remote', path: dirPath, entries });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.postMessage(session, { type: 'directoryError', pane: 'remote', path: dirPath, error: message });
        }
    }

    private async handleListChildren(session: PanelSession, pane: 'local' | 'remote', dirPath: string): Promise<void> {
        try {
            let entries: any[];
            if (pane === 'local') {
                entries = await this.localFs.listDirectory(dirPath);
            } else {
                if (!session.profileId) { return; }
                entries = await this.remoteFs.listDirectory(session.profileId, dirPath);
            }
            this.postMessage(session, { type: 'childrenListing', pane, parentPath: dirPath, entries });
        } catch (err) {
            this.logService.info(`Failed to list children of ${dirPath}: ${err}`);
        }
    }

    // ── Webview communication ─────────────────────────────────────────

    private postMessage(session: PanelSession, msg: Ext2WebMessage): void {
        session.panel.webview.postMessage(msg);
    }

    // ── Utilities ─────────────────────────────────────────────────────

    private requireConnection(session: PanelSession): string {
        if (!session.profileId || !this.connectionManager.isConnected(session.profileId)) {
            throw new Error('No active connection. Please connect first.');
        }
        return session.profileId;
    }

    // ── HTML generation ───────────────────────────────────────────────

    private getHtmlContent(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.css'),
        );

        const nonce = makeNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource};
                   script-src 'nonce-${nonce}';
                   font-src ${webview.cspSource};
                   img-src ${webview.cspSource} data:;">
    <title>xZ FTP Manager</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

function samePosix(a: string, b: string): boolean {
    const norm = (p: string) => (p.replace(/\/+$/, '') || '/');
    return norm(a) === norm(b);
}

function sameLocal(a: string, b: string): boolean {
    const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

