import { Store } from '../state/Store';
import { AppState, FileEntry, PaneState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { PaneSide } from './FilePane';
import { getDragPayload, clearDragPayload } from '../services/DragState';

interface TreeNode {
    name: string;
    path: string;
    children: TreeNode[];
    expanded: boolean;
    loaded: boolean;
    loading: boolean;
}

export class FolderTree {
    private el: HTMLElement;
    private treeBody: HTMLElement;
    private roots: TreeNode[] = [];
    private unsubscribe: () => void;
    private busUnsub: () => void;
    private activePath = '';

    constructor(
        private side: PaneSide,
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'folder-tree';

        // Tree body (scrollable)
        this.treeBody = document.createElement('div');
        this.treeBody.className = 'folder-tree-body';

        this.el.appendChild(this.treeBody);

        // Listen for child listing responses
        this.busUnsub = this.bus.onMessage((msg: any) => {
            if (msg.type === 'childrenListing' && msg.pane === this.side) {
                this.handleChildrenResponse(msg.parentPath, msg.entries);
            }
        });

        this.unsubscribe = this.store.subscribe(() => {
            this.syncWithState();
        });
    }

    private getPaneState(): PaneState {
        const state = this.store.getState();
        return this.side === 'local' ? state.localPane : state.remotePane;
    }

    /** Sync tree structure when the active path changes */
    private syncWithState(): void {
        const pane = this.getPaneState();
        const newPath = pane.currentPath;

        if (newPath === this.activePath && this.roots.length > 0) {
            // Path unchanged — just re-render to pick up selection highlight
            this.renderTree();
            return;
        }

        this.activePath = newPath;

        // Build path segments and ensure tree nodes exist along the path
        const segments = this.getPathSegments(newPath);
        this.ensurePathExpanded(segments);

        // Update children of the active node from the current entries
        const node = this.findNode(newPath);
        if (node) {
            const state = this.store.getState();
            let dirs = pane.entries.filter(e => e.type === 'directory');
            if (!state.showHidden) {
                dirs = dirs.filter(e => !e.isHidden);
            }
            dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

            this.mergeChildren(node, dirs);
            node.loaded = true;
            node.loading = false;
            node.expanded = true;
        }

        this.renderTree();
    }

    /** Parse a path into segments: "/" -> ["/"], "/In/dev" -> ["/", "/In", "/In/dev"] */
    private getPathSegments(p: string): string[] {
        const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        const segments: string[] = [];

        // Handle Windows drive roots like C:/
        const driveMatch = normalized.match(/^([A-Za-z]:)/);
        if (driveMatch) {
            segments.push(driveMatch[1] + '/');
            const rest = normalized.slice(driveMatch[1].length + 1);
            if (rest) {
                const parts = rest.split('/').filter(Boolean);
                let current = driveMatch[1];
                for (const part of parts) {
                    current += '/' + part;
                    segments.push(current);
                }
            }
        } else {
            segments.push('/');
            const parts = normalized.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current += '/' + part;
                segments.push(current);
            }
        }
        return segments;
    }

    /** Ensure tree nodes exist along a path and mark them expanded */
    private ensurePathExpanded(segments: string[]): void {
        if (segments.length === 0) { return; }

        // Ensure root
        const rootPath = segments[0];
        let rootNode = this.roots.find(r => r.path === rootPath);
        if (!rootNode) {
            rootNode = { name: rootPath, path: rootPath, children: [], expanded: true, loaded: false, loading: false };
            this.roots = [rootNode];
        }
        rootNode.expanded = true;

        // Walk the rest of the segments
        let parent = rootNode;
        for (let i = 1; i < segments.length; i++) {
            const segPath = segments[i];
            const segName = segPath.split('/').filter(Boolean).pop() || segPath;
            let child = parent.children.find(c => c.path === segPath);
            if (!child) {
                child = { name: segName, path: segPath, children: [], expanded: false, loaded: false, loading: false };
                parent.children.push(child);
                parent.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            }
            child.expanded = true;
            parent = child;
        }
    }

    /** Merge directory entries into a node's children, preserving existing expanded subtrees */
    private mergeChildren(node: TreeNode, dirs: FileEntry[]): void {
        const existing = new Map(node.children.map(c => [c.path, c]));
        const updated: TreeNode[] = [];
        for (const dir of dirs) {
            const ex = existing.get(dir.path);
            if (ex) {
                ex.name = dir.name;
                updated.push(ex);
            } else {
                updated.push({
                    name: dir.name,
                    path: dir.path,
                    children: [],
                    expanded: false,
                    loaded: false,
                    loading: false,
                });
            }
        }
        node.children = updated;
    }

    /** Find a node by path */
    private findNode(path: string): TreeNode | null {
        const search = (nodes: TreeNode[]): TreeNode | null => {
            for (const n of nodes) {
                if (n.path === path) { return n; }
                const found = search(n.children);
                if (found) { return found; }
            }
            return null;
        };
        return search(this.roots);
    }

    /** Handle response from backend with children of a folder */
    private handleChildrenResponse(parentPath: string, entries: FileEntry[]): void {
        const node = this.findNode(parentPath);
        if (!node) { return; }

        const state = this.store.getState();
        let dirs = entries.filter(e => e.type === 'directory');
        if (!state.showHidden) {
            dirs = dirs.filter(e => !e.isHidden);
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        this.mergeChildren(node, dirs);
        node.loaded = true;
        node.loading = false;
        this.renderTree();
    }

    /** Request children of a node from the backend */
    private requestChildren(node: TreeNode): void {
        node.loading = true;
        this.renderTree();
        this.bus.send({ type: 'listChildren', pane: this.side, path: node.path });
    }

    /** Render the entire tree */
    private renderTree(): void {
        this.treeBody.innerHTML = '';
        for (const root of this.roots) {
            this.renderNode(root, 0);
        }
    }

    /** Render a single tree node and its children recursively */
    private renderNode(node: TreeNode, depth: number): void {
        const item = document.createElement('div');
        item.className = 'folder-tree-item';
        if (node.path === this.activePath) {
            item.classList.add('folder-tree-active');
        }
        item.style.paddingLeft = `${4 + depth * 16}px`;

        // Expand/collapse toggle
        const toggle = document.createElement('span');
        toggle.className = 'folder-tree-expand';
        if (node.loading) {
            toggle.textContent = '\u23F3'; // hourglass
        } else if (node.children.length > 0 || !node.loaded) {
            toggle.textContent = node.expanded ? '\u25BC' : '\u25B6';
        } else {
            toggle.textContent = ' '; // leaf
        }

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (node.expanded) {
                node.expanded = false;
                this.renderTree();
            } else {
                node.expanded = true;
                if (!node.loaded && !node.loading) {
                    this.requestChildren(node);
                } else {
                    this.renderTree();
                }
            }
        });

        // Folder icon
        const icon = document.createElement('span');
        icon.className = 'folder-tree-icon';
        icon.textContent = node.expanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1';

        // Label
        const label = document.createElement('span');
        label.className = 'folder-tree-label';
        label.textContent = node.name;

        item.appendChild(toggle);
        item.appendChild(icon);
        item.appendChild(label);

        // Click navigates to this folder
        item.addEventListener('click', () => {
            this.bus.send({ type: 'navigate', pane: this.side, path: node.path });
        });

        // Drop target: cross-pane DnD into this tree folder
        item.addEventListener('dragover', (e) => {
            const payload = getDragPayload();
            if (!payload || payload.side === this.side) { return; }
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
            item.classList.add('drop-over-folder');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drop-over-folder');
        });

        item.addEventListener('drop', (e) => {
            item.classList.remove('drop-over-folder');
            const payload = getDragPayload();
            if (!payload || payload.side === this.side) { return; }
            e.preventDefault();
            e.stopPropagation();

            if (payload.side === 'local' && this.side === 'remote') {
                this.bus.send({ type: 'upload', localPaths: payload.paths, remotePath: node.path });
            } else if (payload.side === 'remote' && this.side === 'local') {
                this.bus.send({ type: 'download', remotePaths: payload.paths, localPath: node.path });
            }
            clearDragPayload();
        });

        this.treeBody.appendChild(item);

        // Render children if expanded
        if (node.expanded) {
            for (const child of node.children) {
                this.renderNode(child, depth + 1);
            }
        }
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.unsubscribe();
        this.busUnsub();
    }
}
