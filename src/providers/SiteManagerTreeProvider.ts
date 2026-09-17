import * as vscode from 'vscode';
import { SiteManagerNode } from '../core/models/interfaces';
import { StorageService } from '../services/StorageService';

/**
 * Tree node displayed in the Site Manager sidebar view.
 */
class SiteManagerTreeItem extends vscode.TreeItem {
    constructor(
        public readonly node: SiteManagerNode,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(node.name, collapsibleState);

        this.contextValue = node.type; // 'site' | 'folder'
        this.id = node.id;

        if (node.type === 'folder') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else {
            this.iconPath = new vscode.ThemeIcon('server');
        }

        if (node.type === 'site') {
            this.tooltip = `Connect to ${node.name}`;
            this.command = {
                command: 'ftpManager.connect',
                title: 'Connect',
                arguments: [node],
            };
        }
    }
}

const MIME_TYPE = 'application/vnd.code.tree.ftpmanager.sitemanager';

/**
 * Provides the tree data for the Site Manager sidebar view.
 * Displays a hierarchical tree of folders and server connection profiles.
 * Supports drag-and-drop to move sites/folders between parents.
 */
export class SiteManagerTreeProvider
    implements vscode.TreeDataProvider<SiteManagerNode>, vscode.TreeDragAndDropController<SiteManagerNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SiteManagerNode | undefined | void>();
    public readonly onDidChangeTreeData: vscode.Event<SiteManagerNode | undefined | void> =
        this._onDidChangeTreeData.event;

    public readonly dragMimeTypes = [MIME_TYPE];
    public readonly dropMimeTypes = [MIME_TYPE];

    private readonly storageService: StorageService;

    constructor(storageService: StorageService) {
        this.storageService = storageService;
    }

    /**
     * Signal the tree view to re-render all or part of the tree.
     */
    refresh(node?: SiteManagerNode): void {
        this._onDidChangeTreeData.fire(node);
    }

    getTreeItem(node: SiteManagerNode): vscode.TreeItem {
        const hasChildren = node.children.length > 0 || node.type === 'folder';
        const collapsibleState = hasChildren
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        return new SiteManagerTreeItem(node, collapsibleState);
    }

    getChildren(node?: SiteManagerNode): SiteManagerNode[] {
        const allNodes = this.storageService.getSiteNodes();

        if (!node) {
            // Root level: nodes with no parent
            return allNodes
                .filter((n) => n.parentId === null)
                .sort((a, b) => a.sortOrder - b.sortOrder);
        }

        // Children of the given folder node
        return allNodes
            .filter((n) => n.parentId === node.id)
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    getParent(node: SiteManagerNode): SiteManagerNode | undefined {
        if (!node.parentId) {
            return undefined;
        }
        const allNodes = this.storageService.getSiteNodes();
        return allNodes.find((n) => n.id === node.parentId);
    }

    // ── Drag-and-drop ─────────────────────────────────────────────────

    handleDrag(source: readonly SiteManagerNode[], dataTransfer: vscode.DataTransfer): void {
        dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(source.map((n) => n.id)));
    }

    async handleDrop(
        target: SiteManagerNode | undefined,
        dataTransfer: vscode.DataTransfer,
    ): Promise<void> {
        const item = dataTransfer.get(MIME_TYPE);
        if (!item) {
            return;
        }

        let ids: string[];
        try {
            const raw = await item.asString();
            ids = JSON.parse(raw);
        } catch {
            ids = Array.isArray(item.value) ? (item.value as string[]) : [];
        }
        if (!Array.isArray(ids) || ids.length === 0) {
            return;
        }

        const nodes = this.storageService.getSiteNodes();

        // Dropping on a folder moves into that folder; anywhere else moves to root.
        const newParentId: string | null = target && target.type === 'folder' ? target.id : null;

        // Reject drops that would create a cycle (folder into its own descendant / self).
        for (const id of ids) {
            if (id === newParentId) {
                return;
            }
            if (newParentId && this.isDescendant(newParentId, id, nodes)) {
                return;
            }
        }

        let mutated = false;
        for (const id of ids) {
            const n = nodes.find((x) => x.id === id);
            if (!n || n.parentId === newParentId) {
                continue;
            }
            n.parentId = newParentId;
            n.sortOrder = nodes.filter((x) => x.parentId === newParentId && x.id !== id).length;
            mutated = true;
        }

        if (mutated) {
            await this.storageService.saveSiteNodes(nodes);
            this.refresh();
        }
    }

    /** True if `candidateId` lies in the ancestor chain of `ancestorId`. */
    private isDescendant(candidateId: string, ancestorId: string, nodes: SiteManagerNode[]): boolean {
        let curr = nodes.find((n) => n.id === candidateId);
        while (curr && curr.parentId) {
            if (curr.parentId === ancestorId) {
                return true;
            }
            const parentId: string = curr.parentId;
            curr = nodes.find((n) => n.id === parentId);
        }
        return false;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
