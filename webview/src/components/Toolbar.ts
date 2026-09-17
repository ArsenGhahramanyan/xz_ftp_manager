import { Store } from '../state/Store';
import { AppState, PaneState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { PaneSide } from './FilePane';

export class Toolbar {
    private el: HTMLElement;
    private pathInput!: HTMLInputElement;
    private upBtn!: HTMLButtonElement;
    private refreshBtn!: HTMLButtonElement;
    private sortBtn!: HTMLButtonElement;
    private sortMenu!: HTMLElement;
    private disposables: Array<() => void> = [];
    private outsideClick!: (e: MouseEvent) => void;

    constructor(
        private side: PaneSide,
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'toolbar';
        this.buildUI();

        this.disposables.push(this.store.subscribe((state) => {
            const pane = this.side === 'local' ? state.localPane : state.remotePane;
            if (document.activeElement !== this.pathInput) {
                this.pathInput.value = pane.currentPath;
            }
            // Disable up button at root
            const isRoot = pane.currentPath === '/' || /^[A-Za-z]:\/?$/.test(pane.currentPath);
            this.upBtn.disabled = isRoot;
            this.refreshSortMenuLabels();
        }));
    }

    private buildUI(): void {
        // Pane label
        const label = document.createElement('span');
        label.className = 'toolbar-pane-label';
        label.textContent = this.side === 'local' ? 'Local' : 'Remote';

        // Navigation button group
        const navGroup = document.createElement('div');
        navGroup.className = 'toolbar-nav';

        // Up button (parent directory)
        this.upBtn = document.createElement('button');
        this.upBtn.className = 'toolbar-btn';
        this.upBtn.title = 'Parent directory';
        this.upBtn.innerHTML = '&#x2B06;';  // up arrow
        this.upBtn.addEventListener('click', () => this.navigateUp());

        // Refresh button
        this.refreshBtn = document.createElement('button');
        this.refreshBtn.className = 'toolbar-btn';
        this.refreshBtn.title = 'Refresh (F5)';
        this.refreshBtn.innerHTML = '&#x21BB;';  // clockwise arrow
        this.refreshBtn.addEventListener('click', () => {
            this.bus.send({ type: 'refresh', pane: this.side });
        });

        // Sort button — sort menu popover
        this.sortBtn = document.createElement('button');
        this.sortBtn.className = 'toolbar-btn';
        this.sortBtn.title = 'Sort files';
        this.sortBtn.innerHTML = '&#x2195;';  // up-down arrow
        this.sortBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSortMenu();
        });

        navGroup.appendChild(this.upBtn);
        navGroup.appendChild(this.refreshBtn);
        navGroup.appendChild(this.sortBtn);

        // Path input
        this.pathInput = document.createElement('input');
        this.pathInput.type = 'text';
        this.pathInput.className = 'toolbar-path';
        this.pathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.navigateTo(this.pathInput.value.trim());
            }
        });

        // Sort menu (anchored to sort button)
        this.sortMenu = document.createElement('div');
        this.sortMenu.className = 'toolbar-sort-menu is-hidden';
        this.buildSortMenu();
        this.outsideClick = (e: MouseEvent) => {
            if (!this.sortMenu.contains(e.target as Node) && e.target !== this.sortBtn) {
                this.sortMenu.classList.add('is-hidden');
            }
        };
        document.addEventListener('click', this.outsideClick);

        this.el.appendChild(label);
        this.el.appendChild(navGroup);
        this.el.appendChild(this.pathInput);
        this.el.appendChild(this.sortMenu);
    }

    private sortColumns: { key: string; label: string }[] = [];

    private buildSortMenu(): void {
        this.sortColumns = [
            { key: 'name', label: 'Name' },
            { key: 'size', label: 'Size' },
            { key: 'type', label: 'Type' },
            { key: 'modifiedDate', label: 'Modified' },
        ];
        if (this.side === 'remote') {
            this.sortColumns.push({ key: 'permissions', label: 'Permissions' });
            this.sortColumns.push({ key: 'owner', label: 'Owner' });
        }

        const heading = document.createElement('div');
        heading.className = 'toolbar-sort-heading';
        heading.textContent = 'Sort by';
        this.sortMenu.appendChild(heading);

        for (const col of this.sortColumns) {
            const item = document.createElement('button');
            item.className = 'toolbar-sort-item';
            item.dataset.column = col.key;
            item.type = 'button';
            item.addEventListener('click', () => this.applySort(col.key));
            this.sortMenu.appendChild(item);
        }

        const sep = document.createElement('div');
        sep.className = 'toolbar-sort-sep';
        this.sortMenu.appendChild(sep);

        const dirItem = document.createElement('button');
        dirItem.className = 'toolbar-sort-item toolbar-sort-direction';
        dirItem.type = 'button';
        dirItem.addEventListener('click', () => this.toggleDirection());
        this.sortMenu.appendChild(dirItem);

        this.refreshSortMenuLabels();
    }

    private refreshSortMenuLabels(): void {
        if (!this.sortMenu) { return; }
        const pane = this.side === 'local' ? this.store.getState().localPane : this.store.getState().remotePane;
        for (const btn of Array.from(this.sortMenu.querySelectorAll<HTMLButtonElement>('.toolbar-sort-item'))) {
            const k = btn.dataset.column;
            if (!k) {
                btn.textContent = pane.sortAscending ? 'Direction: Ascending' : 'Direction: Descending';
                continue;
            }
            const label = this.sortColumns.find((c) => c.key === k)?.label ?? k;
            btn.textContent = pane.sortColumn === k ? `✓ ${label}` : `   ${label}`;
        }
    }

    private toggleSortMenu(): void {
        this.sortMenu.classList.toggle('is-hidden');
    }

    private applySort(column: string): void {
        const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
        const pane = this.getPaneState();
        const ascending = pane.sortColumn === column ? !pane.sortAscending : true;
        this.store.setState({
            [paneKey]: { ...pane, sortColumn: column, sortAscending: ascending } as PaneState,
        } as Partial<AppState>);
        this.sortMenu.classList.add('is-hidden');
    }

    private toggleDirection(): void {
        const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
        const pane = this.getPaneState();
        this.store.setState({
            [paneKey]: { ...pane, sortAscending: !pane.sortAscending } as PaneState,
        } as Partial<AppState>);
    }

    private computeParent(p: string): string {
        const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');
        const parent = normalized.replace(/\/[^/]+$/, '');
        if (/^[A-Za-z]:$/.test(parent)) { return parent + '/'; }
        return parent || '/';
    }

    private navigateUp(): void {
        const pane = this.getPaneState();
        const parentPath = this.computeParent(pane.currentPath);
        this.navigateTo(parentPath);
    }

    private getPaneState(): PaneState {
        const state = this.store.getState();
        return this.side === 'local' ? state.localPane : state.remotePane;
    }

    private navigateTo(path: string, historyIndex?: number): void {
        if (!path) { return; }
        this.bus.send({
            type: 'navigate',
            pane: this.side,
            path,
        });

        const paneKey = this.side === 'local' ? 'localPane' : 'remotePane';
        const pane = this.getPaneState();

        if (historyIndex !== undefined) {
            this.store.setState({
                [paneKey]: {
                    ...pane,
                    historyIndex,
                    loading: true,
                } as PaneState,
            } as Partial<AppState>);
        } else {
            const newHistory = pane.history.slice(0, pane.historyIndex + 1);
            newHistory.push(path);
            this.store.setState({
                [paneKey]: {
                    ...pane,
                    history: newHistory,
                    historyIndex: newHistory.length - 1,
                    loading: true,
                } as PaneState,
            } as Partial<AppState>);
        }
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        for (const fn of this.disposables) { fn(); }
        document.removeEventListener('click', this.outsideClick);
    }
}
