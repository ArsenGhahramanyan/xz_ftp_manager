export class PermissionDialog {
    private overlay: HTMLElement;
    private dialog: HTMLElement;
    private titleEl!: HTMLElement;
    private subtitleEl!: HTMLElement;
    private checkboxes: HTMLInputElement[][] = [];
    private octalInput!: HTMLInputElement;
    private symbolicEl!: HTMLElement;
    private onApplyCallback: ((mode: number) => void) | null = null;
    private isDirectory = false;

    constructor() {
        // Overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'dialog-overlay';
        this.overlay.style.display = 'none';
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) { this.hide(); }
        });

        // Dialog
        this.dialog = document.createElement('div');
        this.dialog.className = 'permission-dialog';

        this.buildUI();

        this.overlay.appendChild(this.dialog);
        document.body.appendChild(this.overlay);
    }

    private buildUI(): void {
        // Title
        this.titleEl = document.createElement('h3');
        this.titleEl.className = 'dialog-title';
        this.titleEl.textContent = 'File Permissions';
        this.dialog.appendChild(this.titleEl);

        // Subtitle (file path / name)
        this.subtitleEl = document.createElement('div');
        this.subtitleEl.className = 'dialog-subtitle';
        this.dialog.appendChild(this.subtitleEl);

        // Permission grid
        const grid = document.createElement('div');
        grid.className = 'permission-grid';

        // Header row
        const headerRow = document.createElement('div');
        headerRow.className = 'permission-grid-row permission-grid-header';
        for (const label of ['', 'Read', 'Write', 'Execute']) {
            const cell = document.createElement('div');
            cell.className = 'permission-grid-cell';
            cell.textContent = label;
            headerRow.appendChild(cell);
        }
        grid.appendChild(headerRow);

        // Permission rows: Owner, Group, Other
        const rowLabels = ['Owner', 'Group', 'Other'];
        this.checkboxes = [];

        for (let i = 0; i < 3; i++) {
            const row = document.createElement('div');
            row.className = 'permission-grid-row';

            const labelCell = document.createElement('div');
            labelCell.className = 'permission-grid-cell permission-label';
            labelCell.textContent = rowLabels[i];
            row.appendChild(labelCell);

            const rowCbs: HTMLInputElement[] = [];
            for (let j = 0; j < 3; j++) {
                const cell = document.createElement('div');
                cell.className = 'permission-grid-cell';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'permission-checkbox';
                cb.addEventListener('change', () => this.updateOctalDisplay());
                cell.appendChild(cb);
                row.appendChild(cell);
                rowCbs.push(cb);
            }

            this.checkboxes.push(rowCbs);
            grid.appendChild(row);
        }

        this.dialog.appendChild(grid);

        // Numeric input + symbolic display
        const octalRow = document.createElement('div');
        octalRow.className = 'permission-octal-row';

        const octalLabel = document.createElement('label');
        octalLabel.textContent = 'Numeric:';
        octalRow.appendChild(octalLabel);

        this.octalInput = document.createElement('input');
        this.octalInput.type = 'text';
        this.octalInput.className = 'permission-octal-value';
        this.octalInput.maxLength = 4;
        this.octalInput.spellcheck = false;
        this.octalInput.value = '644';
        this.octalInput.addEventListener('input', () => this.handleOctalInput());
        octalRow.appendChild(this.octalInput);

        this.symbolicEl = document.createElement('span');
        this.symbolicEl.className = 'permission-symbolic';
        octalRow.appendChild(this.symbolicEl);

        this.dialog.appendChild(octalRow);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'dialog-buttons';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'dialog-btn dialog-btn-primary';
        applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', () => {
            if (this.onApplyCallback) {
                this.onApplyCallback(this.getOctalValue());
            }
            this.hide();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'dialog-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.hide());

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(applyBtn);
        this.dialog.appendChild(btnRow);
    }

    show(
        currentMode: number,
        onApply: (mode: number) => void,
        name?: string,
        isDirectory?: boolean
    ): void {
        this.onApplyCallback = onApply;
        this.isDirectory = !!isDirectory;
        this.titleEl.textContent = isDirectory ? 'Directory Permissions' : 'File Permissions';
        this.subtitleEl.textContent = name || '';
        this.subtitleEl.style.display = name ? 'block' : 'none';
        this.setFromOctal(currentMode);
        this.updateOctalDisplay();
        this.overlay.style.display = 'flex';
    }

    hide(): void {
        this.overlay.style.display = 'none';
        this.onApplyCallback = null;
    }

    private setFromOctal(mode: number): void {
        // mode is e.g. 0o755 = 493 decimal
        // Owner: bits 8,7,6 (read,write,execute)
        // Group: bits 5,4,3
        // Other: bits 2,1,0
        for (let i = 0; i < 3; i++) {
            const shift = (2 - i) * 3; // owner=6, group=3, other=0
            const triplet = (mode >> shift) & 0o7;
            this.checkboxes[i][0].checked = !!(triplet & 4); // read
            this.checkboxes[i][1].checked = !!(triplet & 2); // write
            this.checkboxes[i][2].checked = !!(triplet & 1); // execute
        }
    }

    private getOctalValue(): number {
        let mode = 0;
        for (let i = 0; i < 3; i++) {
            const shift = (2 - i) * 3;
            let triplet = 0;
            if (this.checkboxes[i][0].checked) { triplet |= 4; }
            if (this.checkboxes[i][1].checked) { triplet |= 2; }
            if (this.checkboxes[i][2].checked) { triplet |= 1; }
            mode |= (triplet << shift);
        }
        return mode;
    }

    private updateOctalDisplay(): void {
        const mode = this.getOctalValue();
        this.octalInput.value = mode.toString(8).padStart(3, '0');
        this.symbolicEl.textContent = this.toSymbolic(mode);
    }

    private handleOctalInput(): void {
        // Strip everything but octal digits, keep only the last 3.
        const cleaned = this.octalInput.value.replace(/[^0-7]/g, '').slice(-3);
        if (cleaned !== this.octalInput.value) {
            this.octalInput.value = cleaned;
        }
        if (cleaned.length === 0) {
            this.symbolicEl.textContent = '';
            return;
        }
        const mode = parseInt(cleaned, 8);
        this.setFromOctal(mode);
        this.symbolicEl.textContent = this.toSymbolic(mode);
    }

    private toSymbolic(mode: number): string {
        const triplet = (t: number) =>
            ((t & 4) ? 'r' : '-') +
            ((t & 2) ? 'w' : '-') +
            ((t & 1) ? 'x' : '-');
        const owner = (mode >> 6) & 0o7;
        const group = (mode >> 3) & 0o7;
        const other = mode & 0o7;
        const prefix = this.isDirectory ? 'd' : '-';
        return prefix + triplet(owner) + triplet(group) + triplet(other);
    }

    dispose(): void {
        if (this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
    }
}
