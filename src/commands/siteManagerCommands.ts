import * as vscode from 'vscode';
import { SiteManagerNode, ConnectionProfile, Protocol } from '../core/models/interfaces';
import { StorageService, DEFAULT_PROTOCOL_FOLDERS } from '../services/StorageService';
import { SecretStorageService } from '../services/SecretStorageService';
import { SiteManagerTreeProvider } from '../providers/SiteManagerTreeProvider';
import { ConnectionEditorProvider } from '../providers/ConnectionEditorProvider';
import { makeId } from '../utils/idUtils';
import { sanitizeForUi } from '../utils/messageSanitizer';

const EXPORT_SCHEMA_VERSION = 1;
interface ExportBundle {
    schemaVersion: number;
    exportedAt: string;
    profiles: ConnectionProfile[];
    nodes: SiteManagerNode[];
}

/**
 * Registers site-manager tree commands:
 *   - ftpManager.addSite
 *   - ftpManager.editSite
 *   - ftpManager.deleteSite
 *   - ftpManager.addFolder
 *
 * Add/Edit open the ConnectionEditor webview, which shows every profile
 * field (name, protocol, host, port, auth, keepalive, timeouts, encoding,
 * transfer mode, etc.) and supports testing the connection before saving.
 */
export function registerSiteManagerCommands(
    context: vscode.ExtensionContext,
    storageService: StorageService,
    secretStorageService: SecretStorageService,
    treeProvider: SiteManagerTreeProvider,
    connectionEditor: ConnectionEditorProvider,
): void {

    // ── Add Site ──────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.addSite', async (folderNode?: SiteManagerNode) => {
            const parentId = folderNode?.type === 'folder' ? folderNode.id : null;

            const result = await connectionEditor.showEditor();
            if (!result) {
                return;
            }

            const { profile, password, passphrase } = result;

            await storageService.saveProfile(profile);
            if (password) {
                await secretStorageService.storePassword(profile.id, password);
            }
            if (passphrase) {
                await secretStorageService.storePassphrase(profile.id, passphrase);
            }

            const nodes = storageService.getSiteNodes();
            const siteNode: SiteManagerNode = {
                id: makeId('site'),
                type: 'site',
                name: profile.name,
                parentId: parentId,
                children: [],
                profileId: profile.id,
                sortOrder: nodes.filter((n) => n.parentId === parentId).length,
            };

            nodes.push(siteNode);
            await storageService.saveSiteNodes(nodes);

            treeProvider.refresh();
            vscode.window.showInformationMessage(`Site "${profile.name}" added.`);
        }),
    );

    // ── Edit Site ─────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.editSite', async (node: SiteManagerNode) => {
            if (!node || node.type !== 'site' || !node.profileId) {
                vscode.window.showErrorMessage('Select a site to edit.');
                return;
            }

            const existing = storageService.getProfileById(node.profileId);
            if (!existing) {
                vscode.window.showErrorMessage('Profile not found.');
                return;
            }

            const result = await connectionEditor.showEditor(existing);
            if (!result) {
                return;
            }

            const { profile, password, passphrase } = result;

            await storageService.saveProfile(profile);
            if (password) {
                await secretStorageService.storePassword(profile.id, password);
            }
            if (passphrase) {
                await secretStorageService.storePassphrase(profile.id, passphrase);
            }
            // Purge secrets the new auth method no longer needs, so credentials
            // don't linger in the OS keychain after switching auth type.
            if (profile.authMethod === 'privateKey' || profile.authMethod === 'sshAgent') {
                await secretStorageService.deletePassword(profile.id);
            }
            if (profile.authMethod === 'password' || profile.authMethod === 'sshAgent') {
                await secretStorageService.deletePassphrase(profile.id);
            }

            // Keep the tree-node label in sync with the profile name.
            const nodes = storageService.getSiteNodes();
            const siteNode = nodes.find((n) => n.id === node.id);
            if (siteNode && siteNode.name !== profile.name) {
                siteNode.name = profile.name;
                await storageService.saveSiteNodes(nodes);
            }

            treeProvider.refresh();
            vscode.window.showInformationMessage(`Site "${profile.name}" updated.`);
        }),
    );

    // ── Delete Site ───────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.deleteSite', async (node: SiteManagerNode) => {
            if (!node) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete "${node.name}"?`,
                { modal: true },
                'Delete',
            );
            if (confirm !== 'Delete') {
                return;
            }

            const nodes = storageService.getSiteNodes();

            // Collect all descendant ids (for folders)
            const idsToRemove = new Set<string>();
            const collectDescendants = (parentId: string) => {
                idsToRemove.add(parentId);
                for (const child of nodes.filter((n) => n.parentId === parentId)) {
                    collectDescendants(child.id);
                }
            };
            collectDescendants(node.id);

            // Delete associated profiles and secrets
            for (const id of idsToRemove) {
                const n = nodes.find((nd) => nd.id === id);
                if (n?.profileId) {
                    await storageService.deleteProfile(n.profileId);
                    await secretStorageService.deletePassword(n.profileId);
                    await secretStorageService.deletePassphrase(n.profileId);
                }
            }

            // Remove nodes
            const remaining = nodes.filter((n) => !idsToRemove.has(n.id));
            await storageService.saveSiteNodes(remaining);

            treeProvider.refresh();
            vscode.window.showInformationMessage(`"${node.name}" deleted.`);
        }),
    );

    // ── Add Folder ────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.addFolder', async (parentNode?: SiteManagerNode) => {
            const parentId = parentNode?.type === 'folder' ? parentNode.id : null;

            const name = await vscode.window.showInputBox({
                prompt: 'Folder name',
                placeHolder: 'My Servers',
                validateInput: (v) => (v.trim() ? undefined : 'Name is required'),
            });
            if (!name) {
                return;
            }

            const nodes = storageService.getSiteNodes();
            const folderNode: SiteManagerNode = {
                id: makeId('folder'),
                type: 'folder',
                name: name.trim(),
                parentId: parentId,
                children: [],
                sortOrder: nodes.filter((n) => n.parentId === parentId).length,
            };

            nodes.push(folderNode);
            await storageService.saveSiteNodes(nodes);

            treeProvider.refresh();
        }),
    );

    // ── Export Sites ──────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.exportSites', async () => {
            const profiles = storageService.getProfiles();
            const nodes = storageService.getSiteNodes();
            if (profiles.length === 0 && nodes.length === 0) {
                vscode.window.showInformationMessage('Nothing to export — site manager is empty.');
                return;
            }

            const target = await vscode.window.showSaveDialog({
                saveLabel: 'Export',
                filters: { JSON: ['json'] },
                defaultUri: vscode.Uri.file('ftp-manager-sites.json'),
            });
            if (!target) {
                return;
            }

            const bundle: ExportBundle = {
                schemaVersion: EXPORT_SCHEMA_VERSION,
                exportedAt: new Date().toISOString(),
                profiles,
                nodes,
            };

            const payload = Buffer.from(JSON.stringify(bundle, null, 2), 'utf-8');
            await vscode.workspace.fs.writeFile(target, payload);

            vscode.window.showInformationMessage(
                `Exported ${profiles.length} site(s) to ${target.fsPath}. Passwords are NOT included — re-enter them on the target machine.`,
            );
        }),
    );

    // ── Import Sites ──────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('ftpManager.importSites', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { JSON: ['json'] },
                openLabel: 'Import',
            });
            if (!picked || picked.length === 0) {
                return;
            }

            let bundle: ExportBundle;
            try {
                const raw = await vscode.workspace.fs.readFile(picked[0]);
                bundle = JSON.parse(Buffer.from(raw).toString('utf-8'));
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to read file: ${sanitizeForUi(err)}`);
                return;
            }

            if (!bundle || !Array.isArray(bundle.profiles) || !Array.isArray(bundle.nodes)) {
                vscode.window.showErrorMessage('Not a valid xZ FTP Manager export.');
                return;
            }

            // Per-field validation. The bundle is attacker-controlled JSON,
            // so we cannot trust shapes. Reject prototype-pollution keys and
            // out-of-range values up front.
            try {
                bundle.profiles.forEach(validateImportedProfile);
                bundle.nodes.forEach(validateImportedNode);
            } catch (err) {
                vscode.window.showErrorMessage(`Import rejected: ${sanitizeForUi(err)}`);
                return;
            }

            if (bundle.schemaVersion !== EXPORT_SCHEMA_VERSION) {
                const proceed = await vscode.window.showWarningMessage(
                    `Export schema v${bundle.schemaVersion} may not be fully compatible (expected v${EXPORT_SCHEMA_VERSION}). Continue?`,
                    { modal: true },
                    'Import anyway',
                );
                if (proceed !== 'Import anyway') {
                    return;
                }
            }

            // Re-id every incoming profile so we never collide with existing ids.
            const profileIdMap = new Map<string, string>();
            for (const p of bundle.profiles) {
                const newId = makeId('profile');
                profileIdMap.set(p.id, newId);
                p.id = newId;
            }
            const protocolByProfileId = new Map<string, Protocol>(
                bundle.profiles.map((p) => [p.id, p.protocol] as [string, Protocol]),
            );

            // Folders from the file are discarded: every incoming site is filed under
            // the default folder for its protocol, whatever the exporting tree looked
            // like. Existing local nodes are untouched.
            const nodes = storageService.getSiteNodes();
            const childCount = (parentId: string | null) =>
                nodes.filter((n) => n.parentId === parentId).length;

            /**
             * Default folder for a protocol, created if missing. Lookup is by the
             * stable id, so a folder the user renamed is reused under its own name
             * and one the user deleted comes back.
             */
            const folderIdFor = (protocol: Protocol): string => {
                const def = DEFAULT_PROTOCOL_FOLDERS[protocol];
                if (!nodes.some((n) => n.id === def.id)) {
                    nodes.push({
                        id: def.id,
                        type: 'folder',
                        name: def.name,
                        parentId: null,
                        children: [],
                        sortOrder: childCount(null),
                    });
                }
                return def.id;
            };

            const importedSites = bundle.nodes.filter((n) => n.type === 'site');
            const droppedFolders = bundle.nodes.length - importedSites.length;
            let unsorted = 0;

            for (const site of importedSites) {
                site.id = makeId('site');
                site.children = [];
                const profileId = site.profileId ? profileIdMap.get(site.profileId) : undefined;
                site.profileId = profileId;

                // A site whose profile did not come along has no protocol to sort by;
                // keep it at root rather than dropping it silently.
                const protocol = profileId ? protocolByProfileId.get(profileId) : undefined;
                if (!protocol) {
                    unsorted++;
                }
                const parentId = protocol ? folderIdFor(protocol) : null;
                site.parentId = parentId;
                site.sortOrder = childCount(parentId);
                nodes.push(site);
            }

            for (const p of bundle.profiles) {
                await storageService.saveProfile(p);
            }
            await storageService.saveSiteNodes(nodes);

            treeProvider.refresh();
            const notes = [
                droppedFolders > 0 ? `${droppedFolders} folder(s) from the file were not recreated.` : '',
                unsorted > 0 ? `${unsorted} site(s) had no profile and stayed at the top level.` : '',
            ].filter(Boolean);
            vscode.window.showInformationMessage(
                `Imported ${importedSites.length} site(s) into the FTP / FTPS / SFTP folders. ` +
                    `Re-enter passwords before connecting.${notes.length ? ' ' + notes.join(' ') : ''}`,
            );
        }),
    );
}

const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'];

function rejectPollutionKeys(obj: unknown, label: string): void {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    for (const key of FORBIDDEN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            throw new Error(`${label} contains forbidden key "${key}"`);
        }
    }
}

function validateImportedProfile(p: unknown): void {
    if (!p || typeof p !== 'object') {
        throw new Error('Profile is not an object');
    }
    rejectPollutionKeys(p, 'Profile');
    const prof = p as Record<string, unknown>;
    if (typeof prof.id !== 'string' || !prof.id) {
        throw new Error('Profile.id missing');
    }
    if (typeof prof.name !== 'string' || prof.name.length === 0 || prof.name.length > 200) {
        throw new Error('Profile.name invalid');
    }
    if (typeof prof.host !== 'string' || prof.host.length === 0 || prof.host.length > 255) {
        throw new Error('Profile.host invalid');
    }
    if (/[\r\n\0]/.test(prof.host)) {
        throw new Error('Profile.host contains control characters');
    }
    if (!Number.isInteger(prof.port) || (prof.port as number) < 1 || (prof.port as number) > 65535) {
        throw new Error('Profile.port out of range');
    }
    if (typeof prof.username !== 'string' || prof.username.length > 255) {
        throw new Error('Profile.username invalid');
    }
    if (/[\r\n\0]/.test(prof.username)) {
        throw new Error('Profile.username contains control characters');
    }
    if (!['ftp', 'ftps', 'sftp'].includes(prof.protocol as string)) {
        throw new Error('Profile.protocol invalid');
    }
    if (prof.defaultOverwriteRule !== undefined) {
        const allowed = ['overwrite', 'skip', 'rename', 'ask', 'overwriteIfNewer', 'overwriteIfSizeDiffers', 'resume'];
        if (!allowed.includes(prof.defaultOverwriteRule as string)) {
            throw new Error('Profile.defaultOverwriteRule invalid');
        }
    }
    if (prof.autoUploadOnSave !== undefined && typeof prof.autoUploadOnSave !== 'boolean') {
        throw new Error('Profile.autoUploadOnSave must be boolean');
    }
    if (
        prof.allowLegacyHostKeyAlgorithms !== undefined &&
        typeof prof.allowLegacyHostKeyAlgorithms !== 'boolean'
    ) {
        throw new Error('Profile.allowLegacyHostKeyAlgorithms must be boolean');
    }
}

function validateImportedNode(n: unknown): void {
    if (!n || typeof n !== 'object') {
        throw new Error('Node is not an object');
    }
    rejectPollutionKeys(n, 'Node');
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id) {
        throw new Error('Node.id missing');
    }
    if (node.type !== 'folder' && node.type !== 'site') {
        throw new Error('Node.type invalid');
    }
    if (typeof node.name !== 'string' || node.name.length === 0 || node.name.length > 200) {
        throw new Error('Node.name invalid');
    }
    if (node.parentId !== undefined && node.parentId !== null && typeof node.parentId !== 'string') {
        throw new Error('Node.parentId invalid');
    }
    if (node.profileId !== undefined && node.profileId !== null && typeof node.profileId !== 'string') {
        throw new Error('Node.profileId invalid');
    }
}
