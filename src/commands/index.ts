import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { TransferQueue } from '../core/transfer/TransferQueue';
import { StorageService } from '../services/StorageService';
import { SecretStorageService } from '../services/SecretStorageService';
import { ConfigService } from '../services/ConfigService';
import { LogService } from '../services/LogService';
import { SearchService } from '../services/SearchService';
import { SiteManagerTreeProvider } from '../providers/SiteManagerTreeProvider';
import { DualPaneWebviewProvider } from '../providers/DualPaneWebviewProvider';
import { ConnectionEditorProvider } from '../providers/ConnectionEditorProvider';

import { registerConnectionCommands } from './connectionCommands';
import { registerSiteManagerCommands } from './siteManagerCommands';
import { registerFileCommands } from './fileCommands';
import { registerTransferCommands } from './transferCommands';
import { registerSearchCommands } from './searchCommands';

/**
 * One-shot helper that registers every command group with the extension context.
 */
export function registerAllCommands(deps: {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    transferQueue: TransferQueue;
    storageService: StorageService;
    secretStorageService: SecretStorageService;
    configService: ConfigService;
    logService: LogService;
    searchService: SearchService;
    siteManagerTreeProvider: SiteManagerTreeProvider;
    webviewProvider: DualPaneWebviewProvider;
    connectionEditor: ConnectionEditorProvider;
}): void {
    registerConnectionCommands(
        deps.context,
        deps.connectionManager,
        deps.storageService,
        deps.secretStorageService,
        deps.logService,
        deps.webviewProvider,
        deps.transferQueue,
    );

    registerSiteManagerCommands(
        deps.context,
        deps.storageService,
        deps.secretStorageService,
        deps.siteManagerTreeProvider,
        deps.connectionEditor,
    );

    registerFileCommands(
        deps.context,
        deps.configService,
    );

    registerTransferCommands(
        deps.context,
        deps.transferQueue,
    );

    registerSearchCommands(
        deps.context,
        deps.searchService,
        deps.connectionManager,
        deps.webviewProvider,
    );
}
