import { Store } from '../state/Store';
import { AppState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { Toolbar } from './Toolbar';
import { FolderTree } from './FolderTree';
import { FileList } from './FileList';
import { getDragPayload, clearDragPayload } from '../services/DragState';

export type PaneSide = 'local' | 'remote';

export class FilePane {
    private el: HTMLElement;
    private toolbar: Toolbar;
    private folderTree: FolderTree;
    private fileList: FileList;
    private treeContainer: HTMLElement;
    private listContainer: HTMLElement;
    private hSplitHandle: HTMLElement;
    private splitPercent = 35;
    private dragging = false;
    private unsubscribeActive: () => void;

    constructor(
        private side: PaneSide,
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = `file-pane file-pane-${side}`;

        // Mark this pane active on any mousedown inside it. Capture phase so
        // we react before the row's own click handler reads activePane state.
        this.el.addEventListener('mousedown', () => {
            if (this.store.getState().activePane !== this.side) {
                this.store.setState({ activePane: this.side });
            }
        }, true);

        this.unsubscribeActive = this.store.subscribe(() => {
            const isActive = this.store.getState().activePane === this.side;
            this.el.classList.toggle('pane-inactive', !isActive);
        });
        // Apply initial state.
        this.el.classList.toggle('pane-inactive', this.store.getState().activePane !== this.side);

        // Toolbar
        this.toolbar = new Toolbar(side, store, bus);
        this.el.appendChild(this.toolbar.getElement());

        // Vertical split area (tree + splitter + file list)
        const splitArea = document.createElement('div');
        splitArea.className = 'file-pane-split-area';

        // Tree container (top)
        this.treeContainer = document.createElement('div');
        this.treeContainer.className = 'file-pane-tree-container';
        this.folderTree = new FolderTree(side, store, bus);
        this.treeContainer.appendChild(this.folderTree.getElement());

        // Horizontal split handle
        this.hSplitHandle = document.createElement('div');
        this.hSplitHandle.className = 'h-split-handle';

        // List container (bottom)
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'file-pane-list-container';
        this.fileList = new FileList(side, store, bus);
        this.listContainer.appendChild(this.fileList.getElement());

        splitArea.appendChild(this.treeContainer);
        splitArea.appendChild(this.hSplitHandle);
        splitArea.appendChild(this.listContainer);
        this.el.appendChild(splitArea);

        this.applyHSplit();
        this.setupHDrag();
        this.setupPaneDrop();
    }

    private setupPaneDrop(): void {
        this.el.addEventListener('dragover', (e) => {
            const payload = getDragPayload();
            if (!payload || payload.side === this.side) { return; }
            e.preventDefault();
            if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
            this.el.classList.add('drop-target-pane');
        });

        this.el.addEventListener('dragleave', (e) => {
            // Only remove the highlight when the cursor truly leaves the pane,
            // not when crossing between child elements.
            if (!this.el.contains(e.relatedTarget as Node | null)) {
                this.el.classList.remove('drop-target-pane');
            }
        });

        this.el.addEventListener('drop', (e) => {
            this.el.classList.remove('drop-target-pane');
            const payload = getDragPayload();
            if (!payload || payload.side === this.side) { return; }
            e.preventDefault();

            const state = this.store.getState();
            if (payload.side === 'local' && this.side === 'remote') {
                const remotePath = state.remotePane.currentPath || '/';
                this.bus.send({ type: 'upload', localPaths: payload.paths, remotePath });
            } else if (payload.side === 'remote' && this.side === 'local') {
                const localPath = state.localPane.currentPath;
                this.bus.send({ type: 'download', remotePaths: payload.paths, localPath });
            }
            clearDragPayload();
        });
    }

    private applyHSplit(): void {
        this.treeContainer.style.height = `calc(${this.splitPercent}% - 2px)`;
        this.listContainer.style.height = `calc(${100 - this.splitPercent}% - 2px)`;
    }

    private setupHDrag(): void {
        const onMouseMove = (e: MouseEvent) => {
            if (!this.dragging) { return; }
            const splitArea = this.treeContainer.parentElement;
            if (!splitArea) { return; }
            const rect = splitArea.getBoundingClientRect();
            let pct = ((e.clientY - rect.top) / rect.height) * 100;
            pct = Math.max(10, Math.min(80, pct));
            this.splitPercent = pct;
            this.applyHSplit();
        };

        const onMouseUp = () => {
            this.dragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        this.hSplitHandle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            this.dragging = true;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.unsubscribeActive();
        this.toolbar.dispose();
        this.folderTree.dispose();
        this.fileList.dispose();
    }
}
