import { Store } from '../state/Store';
import { AppState, FileEntry, PaneState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { PaneSide } from './FilePane';
import { ContextMenu } from './ContextMenu';
import { setDragPayload, getDragPayload, clearDragPayload } from '../services/DragState';

interface ColumnSpec {
    key: string;
    label: string;
    defaultWidth: number;
    minWidth: number;
}

const ALL_COLUMNS: ColumnSpec[] = [
    { key: 'name',         label: 'Name',        defaultWidth: 240, minWidth: 80 },
    { key: 'size',         label: 'Size',        defaultWidth: 80,  minWidth: 50 },
    { key: 'type',         label: 'Type',        defaultWidth: 80,  minWidth: 50 },
    { key: 'modifiedDate', label: 'Modified',    defaultWidth: 140, minWidth: 80 },
    { key: 'permissions',  label: 'Permissions', defaultWidth: 100, minWidth: 60 },
    { key: 'owner',        label: 'Owner',       defaultWidth: 80,  minWidth: 50 },
];

// Local pane has no remote-style permission/owner metadata, so hide those
// columns there entirely.
const LOCAL_HIDDEN_COLUMNS = new Set(['permissions', 'owner']);

export class FileList {
    private el: HTMLElement;
    private tableEl!: HTMLElement;
    private tableBody!: HTMLElement;
    private headerRow!: HTMLElement;
    private unsubscribe: () => void;
    private contextMenu: ContextMenu;
    private lastClickedIndex = -1;
    private widths: Record<string, number> = {};
    private storageKey: string;
    private columns: ColumnSpec[];

    constructor(
        private side: PaneSide,
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'file-list';

        this.columns = side === 'local'
            ? ALL_COLUMNS.filter((c) => !LOCAL_HIDDEN_COLUMNS.has(c.key))
            : ALL_COLUMNS;

        this.contextMenu = new ContextMenu(side, store, bus);

        this.storageKey = `ftpManager.columnWidths.${side}`;
        this.loadWidths();

        this.buildTable();
        this.applyWidths();

        this.unsubscribe = this.store.subscribe(() => {
            this.renderRows();
        });

        this.el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.handleContextMenu(e);
        });
    }

    private buildTable(): void {
        const table = document.createElement('div');
        table.className = 'file-table';
        this.tableEl = table;

        // Header
        this.headerRow = document.createElement('div');
        this.headerRow.className = 'file-table-header';

        for (const col of this.columns) {
            const cell = document.createElement('div');
            cell.className = 'file-table-cell file-table-header-cell';
            cell.dataset.column = col.key;
            cell.style.flex = `0 0 var(--col-${col.key}-w, ${col.defaultWidth}px)`;

            const label = document.createElement('span');
            label.className = 'file-table-header-label';
            label.textContent = col.label;
            cell.appendChild(label);

            cell.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).classList.contains('column-resizer')) { return; }
                this.toggleSort(col.key);
            });

            const resizer = document.createElement('div');
            resizer.className = 'column-resizer';
            resizer.dataset.column = col.key;
            resizer.addEventListener('click', (e) => e.stopPropagation());
            resizer.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.resetColumnWidth(col);
            });
            resizer.addEventListener('mousedown', (e) => this.startColumnResize(e, col, resizer));
            cell.appendChild(resizer);

            this.headerRow.appendChild(cell);
        }

        // Body
        this.tableBody = document.createElement('div');
        this.tableBody.className = 'file-table-body';

        table.appendChild(this.headerRow);
        table.appendChild(this.tableBody);
        this.el.appendChild(table);
    }

    private loadWidths(): void {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) { return; }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') { return; }
            for (const col of this.columns) {
                const v = (parsed as Record<string, unknown>)[col.key];
                if (typeof v === 'number' && isFinite(v) && v >= col.minWidth) {
                    this.widths[col.key] = Math.round(v);
                }
            }
        } catch {
            /* ignore */
        }
    }

    private saveWidths(): void {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.widths));
        } catch {
            /* ignore */
        }
    }

    private applyWidths(): void {
        for (const col of this.columns) {
            const w = this.widths[col.key];
            if (w !== undefined) {
                this.tableEl.style.setProperty(`--col-${col.key}-w`, `${w}px`);
            } else {
                this.tableEl.style.removeProperty(`--col-${col.key}-w`);
            }
        }
    }

    private startColumnResize(e: MouseEvent, col: ColumnSpec, resizer: HTMLElement): void {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = this.widths[col.key] ?? col.defaultWidth;

        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = (ev: MouseEvent) => {
            const delta = ev.clientX - startX;
            const next = Math.max(col.minWidth, Math.round(startWidth + delta));
            this.widths[col.key] = next;
            this.tableEl.style.setProperty(`--col-${col.key}-w`, `${next}px`);
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this.saveWidths();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    private resetColumnWidth(col: ColumnSpec): void {
        delete this.widths[col.key];
        this.tableEl.style.removeProperty(`--col-${col.key}-w`);
        this.saveWidths();
    }

    private toggleSort(column: string): void {
        const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
        const pane = this.getPaneState();
        const ascending = pane.sortColumn === column ? !pane.sortAscending : true;
        this.store.setState({
            [paneKey]: { ...pane, sortColumn: column, sortAscending: ascending } as PaneState,
        } as Partial<AppState>);
    }

    private getPaneState(): PaneState {
        const state = this.store.getState();
        return this.side === 'local' ? state.localPane : state.remotePane;
    }

    private getFilteredEntries(): FileEntry[] {
        const state = this.store.getState();
        const pane = this.side === 'local' ? state.localPane : state.remotePane;
        let entries = [...pane.entries];

        // Filter hidden files
        if (!state.showHidden) {
            entries = entries.filter((e) => !e.isHidden);
        }

        // Filter by pattern
        if (pane.filterPattern) {
            const pattern = pane.filterPattern.toLowerCase();
            entries = entries.filter((e) => e.name.toLowerCase().includes(pattern));
        }

        // Sort
        entries.sort((a, b) => {
            // Directories first
            if (a.type === 'directory' && b.type !== 'directory') { return -1; }
            if (a.type !== 'directory' && b.type === 'directory') { return 1; }

            let cmp = 0;
            switch (pane.sortColumn) {
                case 'name':
                    cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                    break;
                case 'size':
                    cmp = a.size - b.size;
                    break;
                case 'type':
                    cmp = a.type.localeCompare(b.type);
                    break;
                case 'modifiedDate':
                    cmp = a.modifiedDate - b.modifiedDate;
                    break;
                case 'permissions':
                    cmp = (a.permissions || '').localeCompare(b.permissions || '');
                    break;
                case 'owner':
                    cmp = (a.owner || '').localeCompare(b.owner || '');
                    break;
                default:
                    cmp = a.name.localeCompare(b.name);
            }
            return pane.sortAscending ? cmp : -cmp;
        });

        return entries;
    }

    private renderRows(): void {
        const pane = this.getPaneState();
        const entries = this.getFilteredEntries();
        const selectedSet = new Set(pane.selectedPaths);

        this.tableBody.innerHTML = '';

        // Update sort indicator in header
        const headerCells = this.headerRow.querySelectorAll('.file-table-header-cell');
        headerCells.forEach((cell) => {
            const el = cell as HTMLElement;
            el.classList.remove('sort-asc', 'sort-desc');
            if (el.dataset.column === pane.sortColumn) {
                el.classList.add(pane.sortAscending ? 'sort-asc' : 'sort-desc');
            }
        });

        // ".." parent directory entry
        const isRoot = pane.currentPath === '/' || /^[A-Za-z]:\/?$/.test(pane.currentPath);
        if (!isRoot) {
            const computeParent = (p: string): string => {
                const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');
                const parent = normalized.replace(/\/[^/]+$/, '');
                // If we stripped down to just "C:", add trailing slash
                if (/^[A-Za-z]:$/.test(parent)) { return parent + '/'; }
                return parent || '/';
            };
            const parentPath = computeParent(pane.currentPath);
            const parentRow = this.createRow(
                {
                    name: '..', path: parentPath,
                    type: 'directory', size: 0, modifiedDate: 0, isHidden: false,
                },
                false,
                -1
            );
            parentRow.classList.add('file-table-row-parent');
            parentRow.style.cursor = 'pointer';
            parentRow.addEventListener('click', () => {
                this.bus.send({ type: 'navigate', pane: this.side, path: parentPath });
            });
            this.tableBody.appendChild(parentRow);
        }

        // Loading state
        if (pane.loading) {
            const loadingRow = document.createElement('div');
            loadingRow.className = 'file-table-row loading-row';
            loadingRow.textContent = 'Loading...';
            this.tableBody.appendChild(loadingRow);
            return;
        }

        // File entries
        entries.forEach((entry, index) => {
            const selected = selectedSet.has(entry.path);
            const row = this.createRow(entry, selected, index);

            row.addEventListener('click', (e) => this.handleRowClick(e, entry, index, entries));
            row.addEventListener('dblclick', () => this.handleRowDblClick(entry));

            row.draggable = true;
            row.addEventListener('dragstart', (e) => this.handleRowDragStart(e, entry));
            row.addEventListener('dragend', () => this.handleRowDragEnd(row));

            if (entry.type === 'directory') {
                row.addEventListener('dragover', (e) => this.handleFolderDragOver(e, row));
                row.addEventListener('dragleave', () => row.classList.remove('drop-over-folder'));
                row.addEventListener('drop', (e) => this.handleFolderDrop(e, entry, row));
            }

            this.tableBody.appendChild(row);
        });

        // Empty state
        if (entries.length === 0 && !pane.loading) {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'file-table-row empty-row';
            emptyRow.textContent = pane.filterPattern ? 'No matching files' : 'Empty directory';
            this.tableBody.appendChild(emptyRow);
        }
    }

    private createRow(entry: FileEntry, selected: boolean, _index: number): HTMLElement {
        const row = document.createElement('div');
        row.className = 'file-table-row';
        row.dataset.path = entry.path;
        if (selected) { row.classList.add('selected'); }

        const cellFlex = (key: string, defaultWidth: number) =>
            `0 0 var(--col-${key}-w, ${defaultWidth}px)`;

        // Name cell with icon
        const nameCell = document.createElement('div');
        nameCell.className = 'file-table-cell';
        nameCell.style.flex = cellFlex('name', 240);
        const icon = document.createElement('span');
        icon.className = `file-icon ${this.getIconClass(entry)}`;
        nameCell.appendChild(icon);
        const nameText = document.createElement('span');
        nameText.className = 'file-name';
        nameText.textContent = entry.name;
        nameCell.appendChild(nameText);
        row.appendChild(nameCell);

        // Size cell
        const sizeCell = document.createElement('div');
        sizeCell.className = 'file-table-cell';
        sizeCell.style.flex = cellFlex('size', 80);
        sizeCell.textContent = entry.type === 'directory' ? '' : this.formatSize(entry.size);
        row.appendChild(sizeCell);

        // Type cell
        const typeCell = document.createElement('div');
        typeCell.className = 'file-table-cell';
        typeCell.style.flex = cellFlex('type', 80);
        typeCell.textContent = entry.type === 'directory' ? 'Folder' : this.getFileType(entry.name);
        row.appendChild(typeCell);

        // Modified cell
        const modCell = document.createElement('div');
        modCell.className = 'file-table-cell';
        modCell.style.flex = cellFlex('modifiedDate', 140);
        modCell.textContent = entry.modifiedDate ? this.formatDate(entry.modifiedDate) : '';
        row.appendChild(modCell);

        // Permissions / Owner cells (remote pane only)
        if (this.side === 'remote') {
            const permCell = document.createElement('div');
            permCell.className = 'file-table-cell';
            permCell.style.flex = cellFlex('permissions', 100);
            permCell.textContent = entry.permissions || '';
            row.appendChild(permCell);

            const ownerCell = document.createElement('div');
            ownerCell.className = 'file-table-cell';
            ownerCell.style.flex = cellFlex('owner', 80);
            ownerCell.textContent = entry.owner || '';
            row.appendChild(ownerCell);
        }

        return row;
    }

    private handleRowClick(e: MouseEvent, entry: FileEntry, index: number, entries: FileEntry[]): void {
        const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
        const pane = this.getPaneState();
        let selected: string[];

        if (e.ctrlKey || e.metaKey) {
            // Toggle selection
            const set = new Set(pane.selectedPaths);
            if (set.has(entry.path)) {
                set.delete(entry.path);
            } else {
                set.add(entry.path);
            }
            selected = Array.from(set);
        } else if (e.shiftKey && this.lastClickedIndex >= 0) {
            // Range selection
            const start = Math.min(this.lastClickedIndex, index);
            const end = Math.max(this.lastClickedIndex, index);
            selected = entries.slice(start, end + 1).map((e) => e.path);
        } else {
            // Single selection
            selected = [entry.path];
        }

        this.lastClickedIndex = index;
        this.store.setState({
            [paneKey]: { ...pane, selectedPaths: selected } as PaneState,
        } as Partial<AppState>);
    }

    private handleRowDblClick(entry: FileEntry): void {
        if (entry.type === 'directory') {
            this.bus.send({ type: 'navigate', pane: this.side, path: entry.path });
            return;
        }
        // File(s): transfer to the opposite pane's current directory.
        // If the dbl-clicked entry is part of the multi-selection, transfer
        // every selected path; otherwise transfer just this one file.
        const state = this.store.getState();
        const pane = this.side === 'local' ? state.localPane : state.remotePane;
        const paths = pane.selectedPaths.includes(entry.path) && pane.selectedPaths.length > 1
            ? pane.selectedPaths
            : [entry.path];

        if (this.side === 'local') {
            const remotePath = state.remotePane.currentPath || '/';
            this.bus.send({ type: 'upload', localPaths: paths, remotePath });
        } else {
            const localPath = state.localPane.currentPath;
            this.bus.send({ type: 'download', remotePaths: paths, localPath });
        }
    }

    private handleRowDragStart(e: DragEvent, entry: FileEntry): void {
        const pane = this.getPaneState();
        const paths = pane.selectedPaths.includes(entry.path) && pane.selectedPaths.length > 1
            ? [...pane.selectedPaths]
            : [entry.path];

        setDragPayload({ side: this.side, paths });

        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copy';
            // Some browsers require a payload for the drag to start.
            e.dataTransfer.setData('text/plain', paths.join('\n'));
        }

        const row = e.currentTarget as HTMLElement | null;
        row?.classList.add('dragging');
    }

    private handleRowDragEnd(row: HTMLElement): void {
        row.classList.remove('dragging');
        clearDragPayload();
        // Clean up any stray hover styles.
        this.tableBody.querySelectorAll('.drop-over-folder').forEach((el) => {
            el.classList.remove('drop-over-folder');
        });
    }

    private handleFolderDragOver(e: DragEvent, row: HTMLElement): void {
        const payload = getDragPayload();
        if (!payload || payload.side === this.side) { return; }
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
        row.classList.add('drop-over-folder');
    }

    private handleFolderDrop(e: DragEvent, entry: FileEntry, row: HTMLElement): void {
        row.classList.remove('drop-over-folder');
        const payload = getDragPayload();
        if (!payload || payload.side === this.side) { return; }
        e.preventDefault();
        e.stopPropagation();

        if (payload.side === 'local' && this.side === 'remote') {
            this.bus.send({ type: 'upload', localPaths: payload.paths, remotePath: entry.path });
        } else if (payload.side === 'remote' && this.side === 'local') {
            this.bus.send({ type: 'download', remotePaths: payload.paths, localPath: entry.path });
        }
        clearDragPayload();
    }

    private handleContextMenu(e: MouseEvent): void {
        const row = (e.target as HTMLElement).closest('.file-table-row') as HTMLElement | null;
        let targetEntry: FileEntry | null = null;

        if (row && row.dataset.path) {
            const pane = this.getPaneState();
            targetEntry = pane.entries.find((en) => en.path === row.dataset.path) || null;

            // If right-clicked entry not in selection, select it
            if (targetEntry && !pane.selectedPaths.includes(targetEntry.path)) {
                const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
                this.store.setState({
                    [paneKey]: { ...pane, selectedPaths: [targetEntry.path] } as PaneState,
                } as Partial<AppState>);
            }
        }

        this.contextMenu.show(e.clientX, e.clientY, targetEntry);
    }

    private getIconClass(entry: FileEntry): string {
        if (entry.name === '..') { return 'icon-parent'; }
        if (entry.type === 'directory') { return 'icon-folder'; }
        if (entry.type === 'symlink') { return 'icon-symlink'; }

        const ext = entry.name.split('.').pop()?.toLowerCase() || '';
        const extMap: Record<string, string> = {
            ts: 'icon-typescript', js: 'icon-javascript', json: 'icon-json',
            html: 'icon-html', css: 'icon-css', md: 'icon-markdown',
            py: 'icon-python', rs: 'icon-rust', go: 'icon-go',
            jpg: 'icon-image', jpeg: 'icon-image', png: 'icon-image',
            gif: 'icon-image', svg: 'icon-image', webp: 'icon-image',
            zip: 'icon-archive', tar: 'icon-archive', gz: 'icon-archive',
            pdf: 'icon-pdf', txt: 'icon-text', log: 'icon-text',
            xml: 'icon-xml', yaml: 'icon-yaml', yml: 'icon-yaml',
            sh: 'icon-script', bash: 'icon-script',
        };
        return extMap[ext] || 'icon-file';
    }

    private formatSize(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        const val = bytes / Math.pow(1024, i);
        return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    private formatDate(timestamp: number): string {
        const d = new Date(timestamp);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    private getFileType(name: string): string {
        const ext = name.split('.').pop()?.toLowerCase() || '';
        if (!ext || !name.includes('.')) { return 'File'; }
        return ext.toUpperCase() + ' File';
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.unsubscribe();
        this.contextMenu.dispose();
    }
}
