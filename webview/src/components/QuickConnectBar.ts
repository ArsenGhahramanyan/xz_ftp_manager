import { Store } from '../state/Store';
import { AppState } from '../state/AppState';
import { MessageBus } from '../services/MessageBus';

export class QuickConnectBar {
    private el: HTMLElement;
    private protocolSelect!: HTMLSelectElement;
    private hostInput!: HTMLInputElement;
    private portInput!: HTMLInputElement;
    private usernameInput!: HTMLInputElement;
    private passwordInput!: HTMLInputElement;
    private connectBtn!: HTMLButtonElement;
    private unsubscribe: () => void;

    constructor(
        private store: Store<AppState>,
        private bus: MessageBus
    ) {
        this.el = document.createElement('div');
        this.el.className = 'quick-connect-bar';
        this.buildUI();

        this.unsubscribe = this.store.subscribe((state) => {
            this.updateConnectionState(state);
        });
    }

    private buildUI(): void {
        // Protocol select
        this.protocolSelect = document.createElement('select');
        this.protocolSelect.className = 'qc-select';
        for (const proto of ['SFTP', 'FTP', 'FTPS']) {
            const opt = document.createElement('option');
            opt.value = proto.toLowerCase();
            opt.textContent = proto;
            this.protocolSelect.appendChild(opt);
        }

        // Host input
        this.hostInput = document.createElement('input');
        this.hostInput.type = 'text';
        this.hostInput.className = 'qc-input qc-host';
        this.hostInput.placeholder = 'Host';

        // Port input
        this.portInput = document.createElement('input');
        this.portInput.type = 'number';
        this.portInput.className = 'qc-input qc-port';
        this.portInput.placeholder = 'Port';
        this.portInput.value = '22';

        // Username input
        this.usernameInput = document.createElement('input');
        this.usernameInput.type = 'text';
        this.usernameInput.className = 'qc-input qc-username';
        this.usernameInput.placeholder = 'Username';

        // Password input
        this.passwordInput = document.createElement('input');
        this.passwordInput.type = 'password';
        this.passwordInput.className = 'qc-input qc-password';
        this.passwordInput.placeholder = 'Password';

        // Connect button
        this.connectBtn = document.createElement('button');
        this.connectBtn.className = 'qc-connect-btn';
        this.connectBtn.textContent = 'Connect';
        this.connectBtn.addEventListener('click', () => this.handleConnect());

        // Update port when protocol changes
        this.protocolSelect.addEventListener('change', () => {
            const proto = this.protocolSelect.value;
            if (proto === 'sftp') {
                this.portInput.value = '22';
            } else {
                this.portInput.value = '21';
            }
        });

        // Allow Enter key to connect
        const handleEnter = (e: KeyboardEvent) => {
            if (e.key === 'Enter') { this.handleConnect(); }
        };
        this.hostInput.addEventListener('keydown', handleEnter);
        this.usernameInput.addEventListener('keydown', handleEnter);
        this.passwordInput.addEventListener('keydown', handleEnter);

        this.el.appendChild(this.protocolSelect);
        this.el.appendChild(this.hostInput);
        this.el.appendChild(this.portInput);
        this.el.appendChild(this.usernameInput);
        this.el.appendChild(this.passwordInput);
        this.el.appendChild(this.connectBtn);
    }

    private handleConnect(): void {
        const state = this.store.getState();
        if (state.connected) {
            this.bus.send({ type: 'disconnect' });
        } else {
            const host = this.hostInput.value.trim();
            if (!host) {
                this.hostInput.focus();
                return;
            }
            this.bus.send({
                type: 'quickConnect',
                protocol: this.protocolSelect.value,
                host,
                port: parseInt(this.portInput.value, 10) || 22,
                username: this.usernameInput.value.trim() || 'anonymous',
                password: this.passwordInput.value,
            });
        }
    }

    private updateConnectionState(state: AppState): void {
        const connected = state.connected;

        this.connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
        this.connectBtn.classList.toggle('connected', connected);

        // When connected, show connection info and disable inputs
        this.protocolSelect.disabled = connected;
        this.hostInput.disabled = connected;
        this.portInput.disabled = connected;
        this.usernameInput.disabled = connected;
        this.passwordInput.disabled = connected;

        if (connected) {
            // Fill in connection details from state
            if (state.protocol) {
                this.protocolSelect.value = state.protocol;
            }
            if (state.host) {
                this.hostInput.value = state.host;
            }
            if (state.port) {
                this.portInput.value = String(state.port);
            }
            if (state.username) {
                this.usernameInput.value = state.username;
            }
            // Show asterisks for password when connected
            this.passwordInput.value = '********';
        } else {
            // Clear fields on disconnect
            this.passwordInput.value = '';
        }
    }

    getElement(): HTMLElement {
        return this.el;
    }

    dispose(): void {
        this.unsubscribe();
    }
}
