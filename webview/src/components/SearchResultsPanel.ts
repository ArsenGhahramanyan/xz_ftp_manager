import { Store } from '../state/Store';
import { AppState, FileEntry } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';

/**
 * Modal overlay that shows results from `ftpManager.searchRemote`. Replaces
 * the old QuickPick UX so users can browse 100+ hits without losing focus.
 * Click a row to navigate the remote pane to its parent directory.
 */
export class SearchResultsPanel {
    private el: HTMLElement;
    private body!: HTMLElement;
    private title!: HTMLElement;
    private filterInput!: HTMLInputElement;
    private filter = '';
    private unsubscribe: () => void;
    private keydownHandler: (e: KeyboardEvent) => void;

    constructor(
        private store: Store<AppState>,
        private bus: MessageBus,
    ) {
        this.el = document.createElement('div');
        this.el.className = 'search-results-overlay is-hidden';
        this.buildUI();

        this.unsubscribe = this.store.subscribe(() => this.render());

        this.keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.store.getState().searchOpen) {
                this.close();
                e.stopPropagation();
            }
        };
        document.addEventListener('keydown', this.keydownHandler);
    }

    private buildUI(): void {
        const card = document.createElement('div');
        card.className = 'search-results-card';

        const header = document.createElement('div');
        header.className = 'search-results-header';
        this.title = document.createElement('span');
        this.title.className = 'search-results-title';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'search-results-close';
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close (Esc)';
        closeBtn.addEventListener('click', () => this.close());
        header.appendChild(this.title);
        header.appendChild(closeBtn);

        this.filterInput = document.createElement('input');
        this.filterInput.type = 'text';
        this.filterInput.className = 'search-results-filter';
        this.filterInput.placeholder = 'Filter results…';
        this.filterInput.addEventListener('input', () => {
            this.filter = this.filterInput.value;
            this.render();
        });

        this.body = document.createElement('div');
        this.body.className = 'search-results-body';

        card.appendChild(header);
        card.appendChild(this.filterInput);
        card.appendChild(this.body);
        this.el.appendChild(card);

        // Click outside the card closes the panel.
        this.el.addEventListener('mousedown', (e) => {
            if (e.target === this.el) {
                this.close();
            }
        });
    }

    getElement(): HTMLElement {
        return this.el;
    }

    private render(): void {
        const state = this.store.getState();
        const open = !!state.searchOpen;
        this.el.classList.toggle('is-hidden', !open);
        if (!open) {
            return;
        }
        const all = state.searchResults ?? [];
        const filter = this.filter.toLowerCase().trim();
        const visible = filter
            ? all.filter((e) => e.name.toLowerCase().includes(filter) || e.path.toLowerCase().includes(filter))
            : all;
        this.title.textContent = state.searchPattern
            ? `Search: "${state.searchPattern}" — ${visible.length} of ${all.length} result(s)`
            : `${visible.length} of ${all.length} result(s)`;

        this.body.innerHTML = '';
        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'search-results-empty';
            empty.textContent = all.length === 0 ? 'No results.' : 'No matches for filter.';
            this.body.appendChild(empty);
            return;
        }

        for (const entry of visible) {
            const row = this.makeRow(entry);
            this.body.appendChild(row);
        }
    }

    private makeRow(entry: FileEntry): HTMLElement {
        const row = document.createElement('button');
        row.className = 'search-results-row';
        row.type = 'button';

        const icon = document.createElement('span');
        icon.className = 'search-results-icon';
        icon.textContent = entry.type === 'directory' ? '\u{1F4C1}' : '\u{1F4C4}';
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'search-results-name';
        name.textContent = entry.name;
        row.appendChild(name);

        const path = document.createElement('span');
        path.className = 'search-results-path';
        path.textContent = entry.path;
        row.appendChild(path);

        row.addEventListener('click', () => {
            const target = entry.type === 'directory'
                ? entry.path
                : entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
            this.bus.send({ type: 'navigate', pane: 'remote', path: target });
            this.close();
        });
        return row;
    }

    open(results: FileEntry[], pattern: string | undefined): void {
        this.filter = '';
        this.filterInput.value = '';
        this.store.setState({
            searchResults: results,
            searchOpen: true,
            searchPattern: pattern,
        });
        // Focus filter on next frame so the modal is visible first.
        setTimeout(() => this.filterInput.focus(), 0);
    }

    close(): void {
        this.store.setState({ searchOpen: false });
    }

    dispose(): void {
        this.unsubscribe();
        document.removeEventListener('keydown', this.keydownHandler);
    }
}
