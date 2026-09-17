import { Store } from '../state/Store';
import { AppState, FileEntry } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { PaneSide } from './FilePane';

interface MenuItem {
    label: string;
    action: () => void;
    separator?: boolean;
}

export class ContextMenu {
    private el: HTMLElement;
    private dismissHandler: (e: MouseEvent) => void;
    private escHandler: (e: KeyboardEvent) => void;

    constructor(
        private side: PaneSide,
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'context-menu';
        this.el.style.display = 'none';
        document.body.appendChild(this.el);

        this.dismissHandler = (e: MouseEvent) => {
            if (!this.el.contains(e.target as Node)) {
                this.hide();
            }
        };

        this.escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.hide();
            }
        };
    }

    show(x: number, y: number, entry: FileEntry | null): void {
        const items = this.buildItems(entry);
        this.el.innerHTML = '';

        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                this.el.appendChild(sep);
            }
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';
            menuItem.textContent = item.label;
            menuItem.addEventListener('click', () => {
                item.action();
                this.hide();
            });
            this.el.appendChild(menuItem);
        }

        // Position with viewport bounds checking
        this.el.style.display = 'block';
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;

        // Adjust if menu goes off screen
        requestAnimationFrame(() => {
            const rect = this.el.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                this.el.style.left = `${x - rect.width}px`;
            }
            if (rect.bottom > window.innerHeight) {
                this.el.style.top = `${y - rect.height}px`;
            }
        });

        // Add dismiss listeners with delay to avoid immediate dismissal
        setTimeout(() => {
            document.addEventListener('click', this.dismissHandler);
            document.addEventListener('keydown', this.escHandler);
        }, 0);
    }

    hide(): void {
        this.el.style.display = 'none';
        document.removeEventListener('click', this.dismissHandler);
        document.removeEventListener('keydown', this.escHandler);
    }

    private getSelectedPaths(): string[] {
        const state = this.store.getState();
        const pane = this.side === 'local' ? state.localPane : state.remotePane;
        return pane.selectedPaths;
    }

    /**
     * Resolve which paths a context-menu action should target.
     * If the right-clicked entry is already part of the multi-selection,
     * operate on the whole selection. Otherwise operate on just the entry.
     * (FileList.handleContextMenu reduces selection to the entry when
     * right-clicking outside the selection, so `selectedPaths` is reliable.)
     */
    private resolveTargets(entry: FileEntry): string[] {
        const selected = this.getSelectedPaths();
        if (selected.length > 0 && selected.includes(entry.path)) {
            return selected;
        }
        return [entry.path];
    }

    private buildItems(entry: FileEntry | null): MenuItem[] {
        const items: MenuItem[] = [];
        const pane = this.side === 'local'
            ? this.store.getState().localPane
            : this.store.getState().remotePane;

        if (this.side === 'remote') {
            if (entry === null) {
                // Remote background
                items.push({
                    label: 'Upload Here',
                    action: () => {
                        const localPane = this.store.getState().localPane;
                        if (localPane.selectedPaths.length > 0) {
                            this.bus.send({
                                type: 'upload',
                                localPaths: localPane.selectedPaths,
                                remotePath: pane.currentPath,
                            });
                        }
                    },
                });
                items.push({
                    label: 'New Folder',
                    action: () => this.promptNewFolder(pane.currentPath),
                });
                items.push({
                    label: 'Refresh',
                    separator: true,
                    action: () => this.bus.send({
                        type: 'refresh',
                        pane: this.side,
                    }),
                });
            } else if (entry.type === 'directory') {
                // Remote directory
                const targets = this.resolveTargets(entry);
                const multi = targets.length > 1;
                items.push({
                    label: 'Open',
                    action: () => this.bus.send({
                        type: 'navigate',
                        pane: this.side,
                        path: entry.path,
                    }),
                });
                items.push({
                    label: multi ? `Download (${targets.length})` : 'Download',
                    action: () => {
                        const localPane = this.store.getState().localPane;
                        this.bus.send({
                            type: 'download',
                            remotePaths: targets,
                            localPath: localPane.currentPath,
                        });
                    },
                });
                items.push({
                    label: 'Rename',
                    separator: true,
                    action: () => this.promptRename(entry),
                });
                items.push({
                    label: multi ? `Delete (${targets.length})` : 'Delete',
                    action: () => this.bus.send({
                        type: 'deleteItems',
                        pane: this.side,
                        paths: targets,
                    }),
                });
                if (!multi) {
                    items.push({
                        label: 'File Permissions...',
                        separator: true,
                        action: () => this.openPermissionDialog(entry, 0o755),
                    });
                }
            } else {
                // Remote file
                const targets = this.resolveTargets(entry);
                const multi = targets.length > 1;
                items.push({
                    label: multi ? `Download (${targets.length})` : 'Download',
                    action: () => {
                        const localPane = this.store.getState().localPane;
                        this.bus.send({
                            type: 'download',
                            remotePaths: targets,
                            localPath: localPane.currentPath,
                        });
                    },
                });
                items.push({
                    label: 'Open',
                    action: () => this.bus.send({
                        type: 'openFile',
                        pane: this.side,
                        path: entry.path,
                    }),
                });
                items.push({
                    label: 'Rename',
                    separator: true,
                    action: () => this.promptRename(entry),
                });
                items.push({
                    label: multi ? `Delete (${targets.length})` : 'Delete',
                    action: () => this.bus.send({
                        type: 'deleteItems',
                        pane: this.side,
                        paths: targets,
                    }),
                });
                if (!multi) {
                    items.push({
                        label: 'File Permissions...',
                        separator: true,
                        action: () => this.openPermissionDialog(entry, 0o644),
                    });
                }
            }
        } else {
            // Local side
            if (entry === null) {
                // Local background
                items.push({
                    label: 'New Folder',
                    action: () => this.promptNewFolder(pane.currentPath),
                });
                items.push({
                    label: 'Refresh',
                    separator: true,
                    action: () => this.bus.send({
                        type: 'refresh',
                        pane: this.side,
                    }),
                });
            } else if (entry.type === 'directory') {
                // Local directory
                const targets = this.resolveTargets(entry);
                const multi = targets.length > 1;
                items.push({
                    label: 'Open',
                    action: () => this.bus.send({
                        type: 'navigate',
                        pane: this.side,
                        path: entry.path,
                    }),
                });
                items.push({
                    label: multi ? `Upload (${targets.length})` : 'Upload',
                    action: () => {
                        const remotePane = this.store.getState().remotePane;
                        this.bus.send({
                            type: 'upload',
                            localPaths: targets,
                            remotePath: remotePane.currentPath,
                        });
                    },
                });
                items.push({
                    label: 'Rename',
                    separator: true,
                    action: () => this.promptRename(entry),
                });
                items.push({
                    label: multi ? `Delete (${targets.length})` : 'Delete',
                    action: () => this.bus.send({
                        type: 'deleteItems',
                        pane: this.side,
                        paths: targets,
                    }),
                });
            } else {
                // Local file
                const targets = this.resolveTargets(entry);
                const multi = targets.length > 1;
                items.push({
                    label: multi ? `Upload (${targets.length})` : 'Upload',
                    action: () => {
                        const remotePane = this.store.getState().remotePane;
                        this.bus.send({
                            type: 'upload',
                            localPaths: targets,
                            remotePath: remotePane.currentPath,
                        });
                    },
                });
                items.push({
                    label: 'Open',
                    action: () => this.bus.send({
                        type: 'openFile',
                        pane: this.side,
                        path: entry.path,
                    }),
                });
                items.push({
                    label: 'Rename',
                    separator: true,
                    action: () => this.promptRename(entry),
                });
                items.push({
                    label: multi ? `Delete (${targets.length})` : 'Delete',
                    action: () => this.bus.send({
                        type: 'deleteItems',
                        pane: this.side,
                        paths: targets,
                    }),
                });
            }
        }

        return items;
    }

    private openPermissionDialog(entry: FileEntry, defaultMode: number): void {
        // Permission editing lives in App (it owns the singleton dialog).
        // Dispatch a custom event so we don't have to plumb the dialog
        // reference through DualPane → FilePane → FileList → ContextMenu.
        window.dispatchEvent(new CustomEvent('ftp:openPermissionDialog', {
            detail: {
                path: entry.path,
                name: entry.name,
                isDirectory: entry.type === 'directory',
                currentMode: entry.permissionOctal ?? defaultMode,
            },
        }));
    }

    private promptRename(entry: FileEntry): void {
        const newName = this.promptEntryName('Enter new name:', entry.name);
        if (newName && newName !== entry.name) {
            this.bus.send({
                type: 'rename',
                pane: this.side,
                oldPath: entry.path,
                newName,
            });
        }
    }

    private promptNewFolder(parentPath: string): void {
        const name = this.promptEntryName('Enter folder name:');
        if (name) {
            this.bus.send({
                type: 'createDirectory',
                pane: this.side,
                parentPath,
                name,
            });
        }
    }

    /**
     * Show a `prompt()` for a file/directory name and validate the input
     * client-side. The server applies the same checks via `assertSafeEntryName`,
     * but doing it here gives a clearer error message before the round-trip.
     */
    private promptEntryName(label: string, defaultValue?: string): string | null {
        for (;;) {
            const raw = prompt(label, defaultValue);
            if (raw === null) { return null; }
            const trimmed = raw.trim();
            const error = validateEntryName(trimmed);
            if (!error) { return trimmed; }
            alert(error);
            defaultValue = raw;
        }
    }

    dispose(): void {
        this.hide();
        if (this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }
    }
}

export function validateEntryName(name: string): string | null {
    if (!name) {
        return 'Name cannot be empty.';
    }
    if (name.length > 255) {
        return 'Name is too long (255 characters max).';
    }
    if (name === '.' || name === '..') {
        return 'Name cannot be "." or "..".';
    }
    // Path separators, NUL, colons (Windows drive letters / SFTP path delim).
    if (/[\\/\0:]/.test(name)) {
        return 'Name cannot contain \\, /, : or NUL.';
    }
    // Windows-reserved characters; SFTP/FTP servers also reject these often.
    if (/[<>"|?*]/.test(name)) {
        return 'Name cannot contain < > " | ? *.';
    }
    // Control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(name)) {
        return 'Name cannot contain control characters.';
    }
    return null;
}
