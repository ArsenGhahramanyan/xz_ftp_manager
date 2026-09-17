import { Store } from './state/Store';
import { AppState, PaneState } from './state/AppState';
import { MessageBus } from './services/MessageBus';
import { QuickConnectBar } from './components/QuickConnectBar';
import { DualPane } from './components/DualPane';
import { TransferPanel } from './components/TransferPanel';
import { PermissionDialog } from './components/PermissionDialog';
import { validateEntryName } from './components/ContextMenu';
import { SearchResultsPanel } from './components/SearchResultsPanel';

export class App {
    private el: HTMLElement;
    private quickConnectBar: QuickConnectBar;
    private dualPane: DualPane;
    private transferPanel: TransferPanel;
    private permissionDialog: PermissionDialog;
    private searchPanel: SearchResultsPanel;
    private offlineBanner: HTMLElement;
    private unsubscribeMessage: () => void;
    private unsubscribeBanner: () => void;

    constructor(
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'app-root';

        this.quickConnectBar = new QuickConnectBar(store, bus);
        this.dualPane = new DualPane(store, bus);
        this.transferPanel = new TransferPanel(store, bus);
        this.permissionDialog = new PermissionDialog();
        this.searchPanel = new SearchResultsPanel(store, bus);

        this.offlineBanner = document.createElement('div');
        this.offlineBanner.className = 'offline-banner is-hidden';
        this.offlineBanner.setAttribute('role', 'alert');

        this.el.appendChild(this.quickConnectBar.getElement());
        this.el.appendChild(this.offlineBanner);
        this.el.appendChild(this.dualPane.getElement());
        this.el.appendChild(this.transferPanel.getElement());
        this.el.appendChild(this.searchPanel.getElement());

        this.unsubscribeBanner = this.store.subscribe(() => this.renderOfflineBanner());
        this.renderOfflineBanner();

        // Handle messages from extension
        this.unsubscribeMessage = this.bus.onMessage((msg) => this.handleMessage(msg));

        // Listen for in-webview requests to open the permission dialog
        // (dispatched by ContextMenu so it can stay decoupled from App).
        window.addEventListener('ftp:openPermissionDialog', this.handleOpenPermissionDialog as EventListener);

        // Keyboard shortcuts: Enter triggers transfer of the selection in
        // the active pane, Ctrl+A selects all entries in it.
        // Bind on `window` in capture phase — `window` fires before `document`
        // in the capture sequence, so any later document-level listener (like
        // a context-menu Esc handler) cannot pre-empt our preventDefault. Also
        // bind on `document` as a belt-and-braces fallback for environments
        // where window keydown is not delivered for some reason.
        window.addEventListener('keydown', this.handleKeydown, true);
        document.addEventListener('keydown', this.handleKeydown, true);

        // Signal ready
        this.bus.send({ type: 'ready' });
    }

    private handleKeydown = (e: KeyboardEvent): void => {
        // Don't hijack typing in inputs, textareas, contenteditables, or modals.
        const target = e.target as HTMLElement | null;
        if (target) {
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
                return;
            }
        }

        const isCtrlA = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a';
        if (isCtrlA) {
            // Stop the browser's native "select all text on the page" — it
            // would otherwise highlight breadcrumb / toolbar / filename text
            // alongside our row-level selection. stopImmediatePropagation also
            // blocks any later capture-phase listener on the same target from
            // running (we're double-bound to window+document so the second
            // bubble won't fire either).
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            window.getSelection()?.removeAllRanges();
            this.selectAllInActivePane();
            return;
        }

        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            e.stopPropagation();
            this.transferActiveSelection(e);
            return;
        }

        if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            const side = this.store.getState().activePane;
            this.bus.send({ type: 'refresh', pane: side });
            return;
        }

        if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            this.renameActiveSelection();
            return;
        }

        // Accept plain Delete and Shift+Delete (Shift+Delete is the common
        // "skip trash" shortcut in other file managers; we don't have a
        // trash, so both go to the same server-side delete with the modal
        // confirmation provided by the extension). `'Del'` is not a valid
        // `KeyboardEvent.key` value, but some older WebKit builds emitted
        // it — keep the alias for safety.
        // stopPropagation is critical: handleKeydown is bound on both window
        // and document in capture phase as a belt-and-braces fallback, and
        // without it the document listener would fire too and we'd send a
        // second `deleteItems` (→ two confirmation modals).
        if ((e.key === 'Delete' || e.key === 'Del') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            this.deleteActiveSelection();
            return;
        }
    };

    private renameActiveSelection(): void {
        const state = this.store.getState();
        const side = state.activePane;
        const pane = side === 'local' ? state.localPane : state.remotePane;
        if (pane.selectedPaths.length !== 1) {
            return;
        }
        const target = pane.entries.find((e) => e.path === pane.selectedPaths[0]);
        if (!target) { return; }

        let suggestion = target.name;
        for (;;) {
            const raw = prompt('Enter new name:', suggestion);
            if (raw === null) { return; }
            const trimmed = raw.trim();
            const err = validateEntryName(trimmed);
            if (!err) {
                if (trimmed === target.name) { return; }
                this.bus.send({ type: 'rename', pane: side, oldPath: target.path, newName: trimmed });
                return;
            }
            alert(err);
            suggestion = raw;
        }
    }

    private deleteActiveSelection(): void {
        const state = this.store.getState();
        const side = state.activePane;
        const pane = side === 'local' ? state.localPane : state.remotePane;
        if (pane.selectedPaths.length === 0) {
            return;
        }
        // The extension already shows a native modal `showWarningMessage`
        // before deleting (`DualPaneWebviewProvider.handleDeleteItems`), so
        // an extra client-side confirm() would just be a second annoying
        // prompt. Send straight through.
        this.bus.send({ type: 'deleteItems', pane: side, paths: [...pane.selectedPaths] });
    }

    private selectAllInActivePane(): void {
        const state = this.store.getState();
        const side = state.activePane;
        const paneKey = side === 'local' ? 'localPane' : 'remotePane';
        const pane = state[paneKey];
        const visible = pane.entries.filter((entry) => state.showHidden || !entry.isHidden);
        const matchedFilter = pane.filterPattern
            ? visible.filter((e) => e.name.toLowerCase().includes(pane.filterPattern.toLowerCase()))
            : visible;
        this.store.setState({
            [paneKey]: { ...pane, selectedPaths: matchedFilter.map((e) => e.path) } as PaneState,
        } as Partial<AppState>);
    }

    private transferActiveSelection(e: KeyboardEvent): void {
        const state = this.store.getState();
        const side = state.activePane;
        const paneKey = side === 'local' ? 'localPane' : 'remotePane';
        const pane = state[paneKey];
        if (pane.selectedPaths.length === 0) {
            return;
        }

        // Single directory selected → navigate into it instead of transferring.
        if (pane.selectedPaths.length === 1) {
            const sole = pane.entries.find((entry) => entry.path === pane.selectedPaths[0]);
            if (sole && sole.type === 'directory') {
                e.preventDefault();
                this.bus.send({ type: 'navigate', pane: side, path: sole.path });
                return;
            }
        }

        e.preventDefault();
        if (side === 'local') {
            const remotePath = state.remotePane.currentPath || '/';
            this.bus.send({ type: 'upload', localPaths: pane.selectedPaths, remotePath });
        } else {
            const localPath = state.localPane.currentPath;
            this.bus.send({ type: 'download', remotePaths: pane.selectedPaths, localPath });
        }
    }

    private handleOpenPermissionDialog = (e: Event): void => {
        const detail = (e as CustomEvent).detail as {
            path: string;
            name?: string;
            isDirectory?: boolean;
            currentMode: number;
        };
        this.permissionDialog.show(
            detail.currentMode,
            (newMode: number) => {
                this.bus.send({
                    type: 'chmod',
                    remotePath: detail.path,
                    mode: newMode,
                });
            },
            detail.name,
            detail.isDirectory
        );
    };

    private handleMessage(msg: any): void {
        switch (msg.type) {
            case 'directoryListing':
                this.handleDirectoryListing(msg);
                break;

            case 'directoryError':
                this.handleDirectoryError(msg);
                break;

            case 'connectionStatus': {
                const prev = this.store.getState();
                this.store.setState({
                    connected: msg.connected,
                    profileName: msg.profileName || '',
                    host: msg.host || '',
                    username: msg.username || '',
                    port: msg.port || 22,
                    protocol: msg.protocol || 'sftp',
                    everConnected: prev.everConnected || msg.connected === true,
                    disconnectReason: msg.connected ? undefined : (msg.reason || prev.disconnectReason),
                });
                break;
            }

            case 'transferQueueSnapshot':
                // Extension publishes the full queue under `items`; the field
                // was previously read as `transfers` and silently produced an
                // empty list, breaking the Active/Queued/Failed/Completed tabs.
                this.store.setState({
                    transfers: msg.items || msg.transfers || [],
                });
                break;

            case 'settingsUpdate':
                this.store.setState({
                    showHidden: msg.showHidden ?? this.store.getState().showHidden,
                    transferMode: msg.transferMode ?? this.store.getState().transferMode,
                });
                break;

            case 'searchResults':
                this.searchPanel.open(msg.results || [], msg.pattern);
                break;

            case 'error':
                console.error('[App] Error from extension:', msg.message);
                break;
        }
    }

    private handleDirectoryListing(msg: any): void {
        const side: 'local' | 'remote' = msg.pane;
        const paneKey = side === 'local' ? 'localPane' : 'remotePane';
        const currentPane = this.store.getState()[paneKey];

        const updatedPane: PaneState = {
            ...currentPane,
            currentPath: msg.path,
            entries: msg.entries || [],
            loading: false,
            selectedPaths: [],
        };

        this.store.setState({
            [paneKey]: updatedPane,
        } as Partial<AppState>);
    }

    private handleDirectoryError(msg: any): void {
        const side: 'local' | 'remote' = msg.pane;
        const paneKey = side === 'local' ? 'localPane' : 'remotePane';
        const currentPane = this.store.getState()[paneKey];

        this.store.setState({
            [paneKey]: {
                ...currentPane,
                loading: false,
                entries: [],
            } as PaneState,
        } as Partial<AppState>);

        console.error(`[App] Directory error (${side}): ${msg.error}`);
    }

    private renderOfflineBanner(): void {
        const state = this.store.getState();
        const show = !state.connected && state.everConnected;
        if (!show) {
            this.offlineBanner.classList.add('is-hidden');
            this.offlineBanner.textContent = '';
            return;
        }
        this.offlineBanner.classList.remove('is-hidden');
        const reason = state.disconnectReason ? ` — ${state.disconnectReason}` : '';
        this.offlineBanner.textContent = `Connection lost${reason}. Reconnect to resume browsing.`;
    }

    mount(container: HTMLElement): void {
        container.appendChild(this.el);
    }

    dispose(): void {
        this.unsubscribeMessage();
        this.unsubscribeBanner();
        window.removeEventListener('ftp:openPermissionDialog', this.handleOpenPermissionDialog as EventListener);
        window.removeEventListener('keydown', this.handleKeydown, true);
        document.removeEventListener('keydown', this.handleKeydown, true);
        this.quickConnectBar.dispose();
        this.dualPane.dispose();
        this.transferPanel.dispose();
        this.permissionDialog.dispose();
        this.searchPanel.dispose();
    }
}
