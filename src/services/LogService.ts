import * as vscode from 'vscode';
import { ConfigService } from './ConfigService';

type LogLevel = 'INFO' | 'ERROR' | 'CMD' | 'RSP';
type ConfigLogLevel = 'off' | 'error' | 'info' | 'debug';

const LEVEL_RANK: Record<ConfigLogLevel, number> = {
    off: 0,
    error: 1,
    info: 2,
    debug: 3,
};

/**
 * Centralized logging service that writes to two VS Code output channels:
 *   - "xZ FTP Manager" for connection / general messages
 *   - "xZ FTP Manager - Transfers" for transfer-specific messages
 *
 * Respects the `ftpManager.logLevel` setting:
 *   - `off`    — suppress everything except transfer-channel messages
 *   - `error`  — ERROR only
 *   - `info`   — ERROR + INFO
 *   - `debug`  — all, including protocol CMD/RSP chatter from adapters
 */
export class LogService implements vscode.Disposable {
    private readonly mainChannel: vscode.OutputChannel;
    private readonly transferChannel: vscode.OutputChannel;

    constructor(private readonly configService?: ConfigService) {
        this.mainChannel = vscode.window.createOutputChannel('xZ FTP Manager');
        this.transferChannel = vscode.window.createOutputChannel('xZ FTP Manager - Transfers');
    }

    // ── Main channel helpers ─────────────────────────────────────────

    info(message: string): void {
        if (this.shouldLog('info')) {
            this.write(this.mainChannel, 'INFO', message);
        }
    }

    error(message: string): void {
        if (this.shouldLog('error')) {
            this.write(this.mainChannel, 'ERROR', message);
        }
    }

    command(message: string): void {
        if (this.shouldLog('debug')) {
            this.write(this.mainChannel, 'CMD', message);
        }
    }

    response(message: string): void {
        if (this.shouldLog('debug')) {
            this.write(this.mainChannel, 'RSP', message);
        }
    }

    // ── Transfer channel (always visible) ────────────────────────────

    transfer(message: string): void {
        this.write(this.transferChannel, 'INFO', message);
    }

    // ── Channel visibility ───────────────────────────────────────────

    showMainChannel(): void {
        this.mainChannel.show(true);
    }

    showTransferChannel(): void {
        this.transferChannel.show(true);
    }

    // ── Disposal ─────────────────────────────────────────────────────

    dispose(): void {
        this.mainChannel.dispose();
        this.transferChannel.dispose();
    }

    // ── Private ──────────────────────────────────────────────────────

    private shouldLog(level: Exclude<ConfigLogLevel, 'off'>): boolean {
        const configured = this.configService?.getLogLevel() ?? 'info';
        return LEVEL_RANK[configured] >= LEVEL_RANK[level];
    }

    private write(channel: vscode.OutputChannel, level: LogLevel, message: string): void {
        const timestamp = new Date().toISOString().replace('Z', '').slice(0, 19);
        channel.appendLine(`[${timestamp}] [${level}] ${message}`);
    }
}
