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

export interface TransferItemView {
    id: string;
    localPath: string;
    remotePath: string;
    direction: 'upload' | 'download';
    status: string;
    totalBytes: number;
    transferredBytes: number;
    bytesPerSecond: number;
    error?: string;
}

export interface PaneState {
    currentPath: string;
    entries: FileEntry[];
    selectedPaths: string[];
    sortColumn: string;
    sortAscending: boolean;
    filterPattern: string;
    history: string[];
    historyIndex: number;
    loading: boolean;
}

export interface AppState {
    connected: boolean;
    profileName: string;
    host: string;
    username: string;
    port: number;
    protocol: string;
    localPane: PaneState;
    remotePane: PaneState;
    transfers: TransferItemView[];
    showHidden: boolean;
    transferMode: string;
    activeTransferTab: 'active' | 'queued' | 'failed' | 'completed';
    /**
     * Which file pane currently has focus. Drives active-pane behavior:
     * the inactive pane's selection renders in a muted color, and global
     * keyboard shortcuts (Enter, Ctrl+A) target this pane.
     */
    activePane: 'local' | 'remote';
    /**
     * `true` once we have ever observed a successful connection in this
     * session — used to gate the offline banner so it only appears after
     * a real disconnect, not on first-load state.
     */
    everConnected: boolean;
    /**
     * Optional reason text shown alongside the offline banner.
     */
    disconnectReason?: string;
    /** Results last delivered for `ftpManager.searchRemote`. */
    searchResults?: FileEntry[];
    /** Visibility flag for the SearchResultsPanel modal. */
    searchOpen?: boolean;
    /** Pattern that produced the current results — shown in the panel header. */
    searchPattern?: string;
}

function createInitialPaneState(rootPath: string): PaneState {
    return {
        currentPath: rootPath,
        entries: [],
        selectedPaths: [],
        sortColumn: 'name',
        sortAscending: true,
        filterPattern: '',
        history: [rootPath],
        historyIndex: 0,
        loading: false,
    };
}

export function createInitialState(): AppState {
    return {
        connected: false,
        profileName: '',
        host: '',
        username: '',
        port: 22,
        protocol: 'sftp',
        localPane: createInitialPaneState('/'),
        remotePane: createInitialPaneState('/'),
        transfers: [],
        showHidden: false,
        transferMode: 'auto',
        activeTransferTab: 'active',
        activePane: 'local',
        everConnected: false,
        disconnectReason: undefined,
        searchResults: undefined,
        searchOpen: false,
        searchPattern: undefined,
    };
}
