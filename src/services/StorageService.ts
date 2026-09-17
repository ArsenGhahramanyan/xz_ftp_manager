import * as vscode from 'vscode';
import { SiteManagerNode, ConnectionProfile, Protocol } from '../core/models/interfaces';

const SITES_KEY = 'ftpManager.siteNodes';
const PROFILES_KEY = 'ftpManager.profiles';
const SCHEMA_VERSION_KEY = 'ftpManager.schemaVersion';
const DEFAULT_FOLDERS_SEEDED_KEY = 'ftpManager.defaultFoldersSeeded';

/** Current persistence schema version. Bump whenever ConnectionProfile shape changes. */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Folders created once, on first run, so the Site Manager starts with a slot
 * per protocol instead of an empty tree. Ids are stable so a re-seed can never
 * duplicate them; the seeded flag means a user who deletes or renames a folder
 * does not get it back on the next activation.
 */
export const DEFAULT_PROTOCOL_FOLDERS: Record<Protocol, { id: string; name: string }> = {
    ftp: { id: 'folder-default-ftp', name: 'FTP' },
    ftps: { id: 'folder-default-ftps', name: 'FTPS' },
    sftp: { id: 'folder-default-sftp', name: 'SFTP' },
};

const DEFAULT_FOLDERS: { id: string; name: string }[] = [
    DEFAULT_PROTOCOL_FOLDERS.ftp,
    DEFAULT_PROTOCOL_FOLDERS.ftps,
    DEFAULT_PROTOCOL_FOLDERS.sftp,
];

/**
 * Wraps `ExtensionContext.globalState` and `workspaceState` for typed persistence
 * of site-manager nodes and connection profiles.
 *
 * Runs lightweight migrations on startup when the stored schema version
 * is below `CURRENT_SCHEMA_VERSION`.
 */
export class StorageService {
    private readonly globalState: vscode.Memento;
    private readonly workspaceState: vscode.Memento;

    constructor(context: vscode.ExtensionContext) {
        this.globalState = context.globalState;
        this.workspaceState = context.workspaceState;
        void this.migrate();
    }

    // ── Migrations ───────────────────────────────────────────────────

    private async migrate(): Promise<void> {
        const from = this.globalState.get<number>(SCHEMA_VERSION_KEY, 1);
        if (from >= CURRENT_SCHEMA_VERSION) {
            return;
        }

        // v1 -> v2: profiles gained optional `trustSelfSigned` field.
        // Earlier builds implicitly accepted self-signed FTPS certificates.
        // We deliberately do NOT carry that forward: leaving the field
        // `undefined` means `rejectUnauthorized: true` (strict validation in
        // FtpsAdapter). A user who genuinely relies on a self-signed cert must
        // re-enable "Trust self-signed" per profile — a visible, conscious
        // opt-in rather than a silent security downgrade on upgrade.
        // No data rewrite is required for this migration.

        await this.globalState.update(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
    }

    // ── Site Manager nodes ───────────────────────────────────────────

    getSiteNodes(): SiteManagerNode[] {
        return this.globalState.get<SiteManagerNode[]>(SITES_KEY, []);
    }

    async saveSiteNodes(nodes: SiteManagerNode[]): Promise<void> {
        await this.globalState.update(SITES_KEY, nodes);
    }

    /**
     * Create the default FTP / FTPS / SFTP root folders on first run.
     * Idempotent: runs at most once per install, and skips any folder whose id
     * already exists. Resolves `true` when the tree changed (caller refreshes).
     */
    async ensureDefaultFolders(): Promise<boolean> {
        if (this.globalState.get<boolean>(DEFAULT_FOLDERS_SEEDED_KEY, false)) {
            return false;
        }

        const nodes = this.getSiteNodes();
        const existingIds = new Set(nodes.map((n) => n.id));
        // Root order starts after whatever the user already has at root level.
        let sortOrder = nodes.filter((n) => n.parentId === null).length;

        let added = false;
        for (const def of DEFAULT_FOLDERS) {
            if (existingIds.has(def.id)) {
                continue;
            }
            nodes.push({
                id: def.id,
                type: 'folder',
                name: def.name,
                parentId: null,
                children: [],
                sortOrder: sortOrder++,
            });
            added = true;
        }

        if (added) {
            await this.saveSiteNodes(nodes);
        }
        await this.globalState.update(DEFAULT_FOLDERS_SEEDED_KEY, true);
        return added;
    }

    // ── Connection profiles ──────────────────────────────────────────

    getProfiles(): ConnectionProfile[] {
        return this.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
    }

    getProfileById(id: string): ConnectionProfile | undefined {
        return this.getProfiles().find((p) => p.id === id);
    }

    async saveProfile(profile: ConnectionProfile): Promise<void> {
        const profiles = this.getProfiles();
        const idx = profiles.findIndex((p) => p.id === profile.id);
        if (idx >= 0) {
            profiles[idx] = profile;
        } else {
            profiles.push(profile);
        }
        await this.globalState.update(PROFILES_KEY, profiles);
    }

    async deleteProfile(id: string): Promise<void> {
        const profiles = this.getProfiles().filter((p) => p.id !== id);
        await this.globalState.update(PROFILES_KEY, profiles);
    }

    // ── Workspace-scoped data ────────────────────────────────────────

    getWorkspaceData<T>(key: string, defaultValue: T): T {
        return this.workspaceState.get<T>(key, defaultValue);
    }

    async setWorkspaceData<T>(key: string, value: T): Promise<void> {
        await this.workspaceState.update(key, value);
    }
}
