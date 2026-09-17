import * as vscode from 'vscode';
import * as path from 'path';
import { TempFileService } from './TempFileService';
import { ConfigService } from './ConfigService';
import { ProfileSettings } from '../utils/profileSettings';
import { TransferItem } from '../core/transfer/TransferItem';

/** Minimal interface for the transfer queue so we don't create a circular dependency. */
export interface ITransferQueue {
    enqueue(item: TransferItem): void;
}

/**
 * Watches for text-document saves and, when the saved file is a tracked temp
 * file (remote edit), automatically enqueues an upload transfer.
 */
export class FileWatcherService implements vscode.Disposable {
    private readonly subscription: vscode.Disposable;

    constructor(
        private readonly tempFileService: TempFileService,
        private readonly transferQueue: ITransferQueue,
        private readonly configService: ConfigService,
        private readonly profileSettings: ProfileSettings,
    ) {
        this.subscription = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.handleSave(doc);
        });
    }

    dispose(): void {
        this.subscription.dispose();
    }

    // ── Private ──────────────────────────────────────────────────────

    private handleSave(doc: vscode.TextDocument): void {
        const localPath = doc.uri.fsPath;
        const mapping = this.tempFileService.getTempMapping(localPath);
        if (!mapping) {
            return;
        }
        // Per-site override wins; missing override falls back to the global
        // `ftpManager.autoUploadOnSave` setting.
        if (!this.profileSettings.autoUploadOnSave(mapping.connectionId)) {
            return;
        }

        const item = new TransferItem({
            connectionId: mapping.connectionId,
            localPath,
            remotePath: mapping.remotePath,
            direction: 'upload',
            maxRetries: this.configService.getRetryCount(),
            overwriteRule: 'overwrite',
            transferMode: this.resolveTransferMode(mapping.connectionId, localPath),
            preserveTimestamp: this.configService.getPreserveTimestamp(),
        });

        this.transferQueue.enqueue(item);
    }

    private resolveTransferMode(connectionId: string, filePath: string): 'binary' | 'ascii' {
        const mode = this.profileSettings.transferMode(connectionId);
        if (mode === 'binary' || mode === 'ascii') {
            return mode;
        }
        // "auto": decide based on extension
        const ext = path.extname(filePath).toLowerCase();
        const asciiExts = this.configService.getAsciiExtensions();
        return asciiExts.includes(ext) ? 'ascii' : 'binary';
    }
}
