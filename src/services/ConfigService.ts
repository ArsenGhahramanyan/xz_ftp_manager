import * as vscode from 'vscode';
import { OverwriteRule } from '../core/models/interfaces';

const SECTION = 'ftpManager';

/**
 * Typed accessor layer over the `ftpManager.*` VS Code workspace settings.
 * Fires `onDidChange` whenever relevant configuration values change.
 */
export class ConfigService implements vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    private readonly subscription: vscode.Disposable;

    constructor() {
        this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(SECTION)) {
                this._onDidChange.fire();
            }
        });
    }

    // ── Transfer settings ────────────────────────────────────────────

    getMaxConcurrentTransfers(): number {
        return this.getNumber('maxConcurrentTransfers', 2, 1, 10);
    }

    getDefaultOverwriteRule(): OverwriteRule {
        return this.get<OverwriteRule>('defaultOverwriteRule', 'ask');
    }

    getPreserveTimestamp(): boolean {
        return this.get<boolean>('preserveTimestamp', true);
    }

    getTransferMode(): 'auto' | 'binary' | 'ascii' {
        return this.get<'auto' | 'binary' | 'ascii'>('transferMode', 'auto');
    }

    getAsciiExtensions(): string[] {
        return this.get<string[]>('asciiFileExtensions', [
            '.txt', '.html', '.htm', '.css', '.js', '.ts', '.json', '.xml',
            '.csv', '.md', '.yaml', '.yml', '.svg', '.php', '.py', '.rb',
            '.java', '.c', '.cpp', '.h', '.sh', '.bat',
        ]);
    }

    // ── File display ─────────────────────────────────────────────────

    getShowHiddenFiles(): boolean {
        return this.get<boolean>('showHiddenFiles', false);
    }

    getDefaultLocalDirectory(): string {
        return this.get<string>('defaultLocalDirectory', '');
    }

    // ── Connection ───────────────────────────────────────────────────

    getConnectionTimeout(): number {
        return this.getNumber('connectionTimeout', 30, 5);
    }

    getKeepaliveInterval(): number {
        return this.getNumber('keepaliveInterval', 60, 0);
    }

    // ── Retry ────────────────────────────────────────────────────────

    getRetryCount(): number {
        return this.getNumber('retryCount', 3, 0);
    }

    getRetryDelay(): number {
        return this.getNumber('retryDelay', 5, 1);
    }

    // ── Logging / auto-upload ────────────────────────────────────────

    getLogLevel(): 'off' | 'error' | 'info' | 'debug' {
        return this.get<'off' | 'error' | 'info' | 'debug'>('logLevel', 'info');
    }

    getAutoUploadOnSave(): boolean {
        return this.get<boolean>('autoUploadOnSave', true);
    }

    // ── Disposal ─────────────────────────────────────────────────────

    dispose(): void {
        this.subscription.dispose();
        this._onDidChange.dispose();
    }

    // ── Private ──────────────────────────────────────────────────────

    private get<T>(key: string, defaultValue: T): T {
        return vscode.workspace.getConfiguration(SECTION).get<T>(key, defaultValue);
    }

    /**
     * Read a numeric setting and clamp it to a sane range. Guards against a
     * hand-edited `settings.json` carrying a non-number, NaN, or out-of-range
     * value that VS Code's schema validation does not enforce at read time.
     */
    private getNumber(key: string, def: number, min: number, max = Number.POSITIVE_INFINITY): number {
        const raw = this.get<unknown>(key, def);
        const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
        return Math.min(max, Math.max(min, n));
    }
}
