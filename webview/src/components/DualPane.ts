import { Store } from '../state/Store';
import { AppState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';
import { FilePane } from './FilePane';

export class DualPane {
    private el: HTMLElement;
    private leftPane: FilePane;
    private rightPane: FilePane;
    private splitHandle: HTMLElement;
    private leftContainer: HTMLElement;
    private rightContainer: HTMLElement;
    private splitPercent = 50;
    private dragging = false;

    constructor(
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'dual-pane';

        this.leftContainer = document.createElement('div');
        this.leftContainer.className = 'pane-container pane-left';

        this.splitHandle = document.createElement('div');
        this.splitHandle.className = 'split-handle';

        this.rightContainer = document.createElement('div');
        this.rightContainer.className = 'pane-container pane-right';

        this.leftPane = new FilePane('local', this.store, this.bus);
        this.rightPane = new FilePane('remote', this.store, this.bus);

        this.leftContainer.appendChild(this.leftPane.getElement());
        this.rightContainer.appendChild(this.rightPane.getElement());

        this.el.appendChild(this.leftContainer);
        this.el.appendChild(this.splitHandle);
        this.el.appendChild(this.rightContainer);

        this.applySplit();
        this.setupDrag();
    }

    private applySplit(): void {
        // CSS sets `flex: 1 1 50%` on .pane-container, which overrides any
        // width property. Set the flex shorthand directly so explicit drag
        // sizes actually take effect.
        this.leftContainer.style.flex = `0 0 calc(${this.splitPercent}% - 2px)`;
        this.rightContainer.style.flex = `0 0 calc(${100 - this.splitPercent}% - 2px)`;
    }

    private setupDrag(): void {
        const onMouseMove = (e: MouseEvent) => {
            if (!this.dragging) { return; }
            const rect = this.el.getBoundingClientRect();
            let pct = ((e.clientX - rect.left) / rect.width) * 100;
            pct = Math.max(20, Math.min(80, pct));
            this.splitPercent = pct;
            this.applySplit();
        };

        const onMouseUp = () => {
            this.dragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        this.splitHandle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            this.dragging = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.leftPane.dispose();
        this.rightPane.dispose();
    }
}
