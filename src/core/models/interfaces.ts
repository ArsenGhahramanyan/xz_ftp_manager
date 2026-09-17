import * as vscode from 'vscode';

export type Protocol = 'ftp' | 'ftps' | 'sftp';
export type EncryptionMode = 'explicit' | 'implicit' | 'none';
export type AuthMethod = 'password' | 'privateKey' | 'keyAndPassword' | 'sshAgent';
export type TransferStatus = 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TransferDirection = 'upload' | 'download';
export type OverwriteRule = 'overwrite' | 'skip' | 'rename' | 'ask' | 'overwriteIfNewer' | 'overwriteIfSizeDiffers' | 'resume';
export type SortColumn = 'name' | 'size' | 'type' | 'date' | 'permissions' | 'owner';
export type ProgressCallback = (transferred: number, total: number) => void;

export interface ConnectionProfile {
    id: string;
    name: string;
    protocol: Protocol;
    host: string;
    port: number;
    username: string;
    encryptionMode: EncryptionMode;
    authMethod: AuthMethod;
    privateKeyPath?: string;
    transferMode: 'auto' | 'binary' | 'ascii';
    initialRemotePath?: string;
    initialLocalPath?: string;
    keepalive: { enabled: boolean; intervalSeconds: number };
    timeoutSeconds: number;
    maxConcurrentTransfers: number;
    encoding: string;
    passiveMode: boolean;
    /** FTPS only: accept self-signed / untrusted certificates. Default false. */
    trustSelfSigned?: boolean;
    /** SFTP only: SHA256 fingerprint of the server's host key (TOFU). */
    pinnedHostKey?: string;
    /**
     * SFTP only: also offer the legacy SHA-1 host-key algorithms
     * (`ssh-rsa`, `ssh-dss`) during key exchange. Off by default — only
     * needed for old servers that never learned RFC 8332 rsa-sha2-*.
     */
    allowLegacyHostKeyAlgorithms?: boolean;
    /**
     * Per-site override for the global `defaultOverwriteRule` setting.
     * `undefined` means: fall back to the workspace setting.
     */
    defaultOverwriteRule?: OverwriteRule;
    /**
     * Per-site override for the global `autoUploadOnSave` setting. Useful
     * for production sites where silent re-uploads are dangerous.
     * `undefined` means: fall back to the workspace setting.
     */
    autoUploadOnSave?: boolean;
}

export interface SiteManagerNode {
    id: string;
    type: 'folder' | 'site';
    name: string;
    parentId: string | null;
    children: string[];
    profileId?: string;
    sortOrder: number;
}

export interface FileEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    modifiedDate: number;
    permissions?: string;
    permissionOctal?: number;
    owner?: string;
    group?: string;
    isHidden: boolean;
    linkTarget?: string;
}

export interface TransferItemData {
    id: string;
    connectionId: string;
    localPath: string;
    remotePath: string;
    direction: TransferDirection;
    status: TransferStatus;
    totalBytes: number;
    transferredBytes: number;
    bytesPerSecond: number;
    error?: string;
    retryCount: number;
    maxRetries: number;
    overwriteRule: OverwriteRule;
    transferMode: 'binary' | 'ascii';
    startedAt?: number;
    completedAt?: number;
    preserveTimestamp: boolean;
}

export interface SearchQuery {
    pattern: string;
    remotePath: string;
    recursive: boolean;
    matchCase: boolean;
    useRegex: boolean;
    minSize?: number;
    maxSize?: number;
    modifiedAfter?: number;
    modifiedBefore?: number;
}

/**
 * Static, protocol-level capabilities. Used by the transfer queue to decide
 * how many transfers may run on one connection and whether an in-flight
 * transfer can be paused without dropping the session.
 */
export interface ProtocolCapabilities {
    /**
     * `true` when the underlying client can run more than one transfer at a
     * time on a single connection. SFTP (ssh2 multiplexes channels) → true;
     * FTP/FTPS (one basic-ftp control/data channel) → false.
     */
    concurrentTransfers: boolean;
    /**
     * `true` when an active transfer can be interrupted and later resumed
     * from a byte offset without tearing down the whole session. SFTP → true
     * (destroy the stream, session stays up); FTP/FTPS → false (the only
     * reliable interrupt is closing the client).
     */
    pauseResume: boolean;
}

/**
 * Verifies a server host key before authentication proceeds. Resolves `true`
 * to trust the key (and continue), `false` to reject (abort the handshake
 * before any credentials are sent). Only invoked for keys that are not
 * already pinned to the profile.
 */
export type HostKeyVerifier = (ctx: {
    profileId: string;
    host: string;
    port: number;
    /** SHA256 fingerprint of the presented host key (hex, lower-case). */
    fingerprint: string;
}) => Promise<boolean>;

export interface IProtocolAdapter extends vscode.Disposable {
    /** Static protocol capabilities (concurrency, pause/resume). */
    readonly capabilities: ProtocolCapabilities;
    connect(profile: ConnectionProfile, password?: string, passphrase?: string): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    pwd(): Promise<string>;
    list(remotePath: string): Promise<FileEntry[]>;
    mkdir(remotePath: string): Promise<void>;
    rmdir(remotePath: string, recursive?: boolean): Promise<void>;
    /**
     * Download a remote file to disk.
     * @param startAt If > 0, resume the transfer at that byte offset on both
     * sides — the local file is opened in append/seek mode and the server
     * sends only the remaining bytes (FTP `REST`, SFTP `start` option).
     * @param transferMode `'ascii'` performs FTP line-ending conversion
     * (TYPE A). Ignored by SFTP, which has no ASCII mode.
     */
    get(remotePath: string, localDest: string, onProgress?: ProgressCallback, signal?: AbortSignal, startAt?: number, transferMode?: 'binary' | 'ascii'): Promise<void>;
    /**
     * Upload a local file to the server.
     * @param startAt If > 0, append-from-offset: the local file is read from
     * `startAt` and the server appends to the existing remote file.
     * @param transferMode `'ascii'` performs FTP line-ending conversion
     * (TYPE A). Ignored by SFTP.
     */
    put(localSrc: string, remotePath: string, onProgress?: ProgressCallback, signal?: AbortSignal, startAt?: number, transferMode?: 'binary' | 'ascii'): Promise<void>;
    delete(remotePath: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    chmod(remotePath: string, mode: number): Promise<void>;
    stat(remotePath: string): Promise<FileEntry>;
    /**
     * SFTP only: install a callback that decides whether to trust an unknown
     * server host key. Must be set before {@link connect} so verification
     * happens during key exchange — i.e. before credentials are transmitted.
     */
    setHostKeyVerifier?(verifier: HostKeyVerifier): void;
    /** `expected: true` marks a disconnect the extension itself caused (e.g. cancelling an FTP transfer), so auto-reconnect can skip it. */
    onDidDisconnect: vscode.Event<{ reason: string; expected?: boolean }>;
    onLog: vscode.Event<{ level: 'info' | 'command' | 'response' | 'error'; message: string }>;
}

// Webview message types
export type Ext2WebMessage =
    | { type: 'connectionStatus'; connected: boolean; profileName?: string; host?: string; username?: string; port?: number; protocol?: string; reason?: string }
    | { type: 'directoryListing'; pane: 'local' | 'remote'; path: string; entries: FileEntry[] }
    | { type: 'directoryError'; pane: 'local' | 'remote'; path: string; error: string }
    | { type: 'transferQueueSnapshot'; items: TransferItemData[] }
    | { type: 'searchResults'; results: FileEntry[]; completed: boolean; pattern?: string }
    | { type: 'settingsUpdate'; showHidden: boolean; transferMode: string }
    | { type: 'childrenListing'; pane: 'local' | 'remote'; parentPath: string; entries: FileEntry[] };

export type Web2ExtMessage =
    | { type: 'navigate'; pane: 'local' | 'remote'; path: string }
    | { type: 'refresh'; pane: 'local' | 'remote' }
    | { type: 'upload'; localPaths: string[]; remotePath: string }
    | { type: 'download'; remotePaths: string[]; localPath: string }
    | { type: 'deleteItems'; pane: 'local' | 'remote'; paths: string[] }
    | { type: 'rename'; pane: 'local' | 'remote'; oldPath: string; newName: string }
    | { type: 'createDirectory'; pane: 'local' | 'remote'; parentPath: string; name: string }
    | { type: 'chmod'; remotePath: string; mode: number }
    | { type: 'openFile'; pane: 'local' | 'remote'; path: string }
    | { type: 'dragDropTransfer'; sourcePaths: string[]; sourcePane: 'local' | 'remote'; targetPath: string; targetPane: 'local' | 'remote' }
    | { type: 'transferAction'; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'; itemId: string }
    | { type: 'transferBulkAction'; action: 'pauseAll' | 'resumeAll' | 'cancelAll' | 'retryAllFailed' | 'clearCompleted' }
    | { type: 'overwriteResponse'; transferId: string; rule: OverwriteRule; applyToAll: boolean }
    | { type: 'quickConnect'; host: string; port: number; username: string; password: string; protocol: Protocol }
    | { type: 'disconnect' }
    | { type: 'sort'; pane: 'local' | 'remote'; column: SortColumn; ascending: boolean }
    | { type: 'filter'; pane: 'local' | 'remote'; pattern: string }
    | { type: 'toggleHidden'; show: boolean }
    | { type: 'search'; query: SearchQuery }
    | { type: 'cancelSearch' }
    | { type: 'listChildren'; pane: 'local' | 'remote'; path: string }
    | { type: 'ready' };
