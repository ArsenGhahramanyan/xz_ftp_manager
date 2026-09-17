import { Store } from '../state/Store';
import { AppState, TransferItemView } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';

type TransferTab = 'active' | 'queued' | 'failed' | 'completed';

export class TransferPanel {
    private el: HTMLElement;
    private tabBar!: HTMLElement;
    private transferBody!: HTMLElement;
    private resizeHandle!: HTMLElement;
    private dragging = false;
    private panelHeight = 200;
    private unsubscribe: () => void;

    constructor(
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'transfer-panel';
        this.el.style.height = `${this.panelHeight}px`;

        this.buildUI();
        this.setupResize();

        this.unsubscribe = this.store.subscribe(() => {
            this.renderTabs();
            this.renderTransfers();
        });
    }

    private buildUI(): void {
        // Resize handle
        this.resizeHandle = document.createElement('div');
        this.resizeHandle.className = 'transfer-resize-handle';
        this.el.appendChild(this.resizeHandle);

        // Header with tabs and actions
        const header = document.createElement('div');
        header.className = 'transfer-header';

        this.tabBar = document.createElement('div');
        this.tabBar.className = 'transfer-tabs';
        header.appendChild(this.tabBar);

        // Action buttons
        const actions = document.createElement('div');
        actions.className = 'transfer-actions';

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'transfer-action-btn';
        pauseBtn.textContent = 'Pause All';
        pauseBtn.addEventListener('click', () => {
            this.bus.send({ type: 'transferBulkAction', action: 'pauseAll' });
        });

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'transfer-action-btn';
        resumeBtn.textContent = 'Resume All';
        resumeBtn.addEventListener('click', () => {
            this.bus.send({ type: 'transferBulkAction', action: 'resumeAll' });
        });

        actions.appendChild(pauseBtn);
        actions.appendChild(resumeBtn);
        header.appendChild(actions);

        this.el.appendChild(header);

        // Transfer list body
        this.transferBody = document.createElement('div');
        this.transferBody.className = 'transfer-body';
        this.el.appendChild(this.transferBody);

        // Initial tab render
        this.renderTabs();
    }

    private renderTabs(): void {
        const state = this.store.getState();
        const counts = this.getCounts(state.transfers);

        this.tabBar.innerHTML = '';
        const tabs: { key: TransferTab; label: string; count: number }[] = [
            { key: 'active', label: 'Active', count: counts.active },
            { key: 'queued', label: 'Queued', count: counts.queued },
            { key: 'failed', label: 'Failed', count: counts.failed },
            { key: 'completed', label: 'Completed', count: counts.completed },
        ];

        for (const tab of tabs) {
            const tabEl = document.createElement('div');
            tabEl.className = 'transfer-tab';
            if (state.activeTransferTab === tab.key) {
                tabEl.classList.add('active');
            }
            tabEl.textContent = `${tab.label} (${tab.count})`;
            tabEl.addEventListener('click', () => {
                this.store.setState({ activeTransferTab: tab.key });
            });
            this.tabBar.appendChild(tabEl);
        }
    }

    private getCounts(transfers: TransferItemView[]): Record<TransferTab, number> {
        const counts: Record<TransferTab, number> = { active: 0, queued: 0, failed: 0, completed: 0 };
        for (const t of transfers) {
            const status = t.status.toLowerCase();
            if (status === 'transferring' || status === 'active' || status === 'paused') {
                counts.active++;
            } else if (status === 'queued' || status === 'pending') {
                counts.queued++;
            } else if (status === 'failed' || status === 'error') {
                counts.failed++;
            } else if (status === 'completed' || status === 'done' || status === 'cancelled') {
                counts.completed++;
            }
        }
        return counts;
    }

    private getFilteredTransfers(): TransferItemView[] {
        const state = this.store.getState();
        const tab = state.activeTransferTab;
        return state.transfers.filter((t) => {
            const status = t.status.toLowerCase();
            switch (tab) {
                case 'active':
                    return status === 'transferring' || status === 'active' || status === 'paused';
                case 'queued':
                    return status === 'queued' || status === 'pending';
                case 'failed':
                    return status === 'failed' || status === 'error';
                case 'completed':
                    return status === 'completed' || status === 'done' || status === 'cancelled';
                default:
                    return false;
            }
        });
    }

    private renderTransfers(): void {
        const transfers = this.getFilteredTransfers();
        this.transferBody.innerHTML = '';

        if (transfers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'transfer-empty';
            empty.textContent = 'No transfers';
            this.transferBody.appendChild(empty);
            return;
        }

        for (const transfer of transfers) {
            const row = document.createElement('div');
            row.className = 'transfer-row';

            // Direction arrow
            const arrow = document.createElement('span');
            arrow.className = `transfer-direction ${transfer.direction}`;
            arrow.textContent = transfer.direction === 'upload' ? '\u2191' : '\u2193';
            row.appendChild(arrow);

            // Filename
            const fileName = document.createElement('span');
            fileName.className = 'transfer-filename';
            const path = transfer.direction === 'upload' ? transfer.localPath : transfer.remotePath;
            fileName.textContent = path.split('/').pop() || path;
            fileName.title = `${transfer.localPath} \u2194 ${transfer.remotePath}`;
            row.appendChild(fileName);

            // Size
            const size = document.createElement('span');
            size.className = 'transfer-size';
            size.textContent = this.formatSize(transfer.totalBytes);
            row.appendChild(size);

            // Progress bar
            const progressContainer = document.createElement('div');
            progressContainer.className = 'transfer-progress-container';
            const progressBar = document.createElement('div');
            progressBar.className = 'transfer-progress-bar';
            const pct = transfer.totalBytes > 0
                ? Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)
                : 0;
            progressBar.style.width = `${pct}%`;
            progressContainer.appendChild(progressBar);
            const progressText = document.createElement('span');
            progressText.className = 'transfer-progress-text';
            progressText.textContent = `${pct}%`;
            progressContainer.appendChild(progressText);
            row.appendChild(progressContainer);

            // Speed
            const speed = document.createElement('span');
            speed.className = 'transfer-speed';
            speed.textContent = transfer.bytesPerSecond > 0
                ? `${this.formatSize(transfer.bytesPerSecond)}/s`
                : '';
            row.appendChild(speed);

            // ETA — only when actively transferring with a known total
            const eta = document.createElement('span');
            eta.className = 'transfer-eta';
            eta.textContent = this.formatEta(transfer);
            row.appendChild(eta);

            // Status
            const status = document.createElement('span');
            status.className = `transfer-status status-${transfer.status.toLowerCase()}`;
            status.textContent = transfer.status;
            if (transfer.error) {
                status.title = transfer.error;
            }
            row.appendChild(status);

            this.transferBody.appendChild(row);
        }
    }

    private setupResize(): void {
        const onMouseMove = (e: MouseEvent) => {
            if (!this.dragging) { return; }
            const windowHeight = window.innerHeight;
            let newHeight = windowHeight - e.clientY;
            newHeight = Math.max(100, Math.min(windowHeight * 0.6, newHeight));
            this.panelHeight = newHeight;
            this.el.style.height = `${newHeight}px`;
        };

        const onMouseUp = () => {
            this.dragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            this.dragging = true;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    private formatSize(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        const val = bytes / Math.pow(1024, i);
        return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    private formatEta(t: TransferItemView): string {
        const status = t.status.toLowerCase();
        if (status !== 'active' && status !== 'transferring') {
            return '';
        }
        if (t.bytesPerSecond <= 0 || t.totalBytes <= 0) {
            return '';
        }
        const remaining = Math.max(0, t.totalBytes - t.transferredBytes);
        const seconds = Math.round(remaining / t.bytesPerSecond);
        if (seconds < 1) { return '< 1s'; }
        if (seconds < 60) { return `${seconds}s`; }
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        if (m < 60) { return `${m}m ${s}s`; }
        const h = Math.floor(m / 60);
        const mm = m % 60;
        return `${h}h ${mm}m`;
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.unsubscribe();
    }
}
