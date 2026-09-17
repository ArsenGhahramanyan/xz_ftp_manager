import * as vscode from 'vscode';

const PASSWORD_PREFIX = 'ftpManager.password.';
const PASSPHRASE_PREFIX = 'ftpManager.passphrase.';

/**
 * Thin wrapper around VS Code SecretStorage for securely persisting
 * connection passwords and private-key passphrases.
 */
export class SecretStorageService {
    private readonly secrets: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secrets = context.secrets;
    }

    // ── Passwords ────────────────────────────────────────────────────

    async storePassword(id: string, password: string): Promise<void> {
        await this.secrets.store(`${PASSWORD_PREFIX}${id}`, password);
    }

    async getPassword(id: string): Promise<string | undefined> {
        return this.secrets.get(`${PASSWORD_PREFIX}${id}`);
    }

    async deletePassword(id: string): Promise<void> {
        await this.secrets.delete(`${PASSWORD_PREFIX}${id}`);
    }

    // ── Passphrases ──────────────────────────────────────────────────

    async storePassphrase(id: string, passphrase: string): Promise<void> {
        await this.secrets.store(`${PASSPHRASE_PREFIX}${id}`, passphrase);
    }

    async getPassphrase(id: string): Promise<string | undefined> {
        return this.secrets.get(`${PASSPHRASE_PREFIX}${id}`);
    }

    async deletePassphrase(id: string): Promise<void> {
        await this.secrets.delete(`${PASSPHRASE_PREFIX}${id}`);
    }
}
