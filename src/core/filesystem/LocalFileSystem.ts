import * as fs from 'fs/promises';
import * as path from 'path';
import { FileEntry } from '../models/interfaces';

/**
 * Wraps Node.js file-system operations, returning results
 * in the FileEntry format used throughout the extension.
 */
export class LocalFileSystem {

    /**
     * List directory contents and return an array of FileEntry objects.
     */
    async listDirectory(dir: string): Promise<FileEntry[]> {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const entries: FileEntry[] = [];

        for (const dirent of dirents) {
            const fullPath = path.join(dir, dirent.name);
            try {
                const stat = await fs.stat(fullPath);
                entries.push(this.statToEntry(dirent.name, fullPath, stat, dirent));
            } catch {
                // Skip entries we cannot stat (e.g. broken symlinks)
            }
        }

        return entries;
    }

    /**
     * Create a directory, including any intermediate parents.
     */
    async createDirectory(dir: string): Promise<void> {
        await fs.mkdir(dir, { recursive: true });
    }

    /**
     * Delete a file or directory.
     * Directories are removed recursively.
     */
    async deleteItem(itemPath: string, isDir: boolean): Promise<void> {
        if (isDir) {
            await fs.rm(itemPath, { recursive: true, force: true });
        } else {
            await fs.rm(itemPath, { force: true });
        }
    }

    /**
     * Rename (or move) a file or directory.
     */
    async rename(oldPath: string, newPath: string): Promise<void> {
        await fs.rename(oldPath, newPath);
    }

    /**
     * Stat a single path and return a FileEntry.
     */
    async stat(itemPath: string): Promise<FileEntry> {
        const statResult = await fs.stat(itemPath);
        const name = path.basename(itemPath);
        return this.statToEntry(name, itemPath, statResult);
    }

    /**
     * Check whether a file or directory exists at the given path.
     */
    async fileExists(itemPath: string): Promise<boolean> {
        try {
            await fs.access(itemPath);
            return true;
        } catch {
            return false;
        }
    }

    // ── Private ───────────────────────────────────────────────────────

    private statToEntry(
        name: string,
        fullPath: string,
        stat: import('fs').Stats,
        dirent?: import('fs').Dirent
    ): FileEntry {
        let type: FileEntry['type'] = 'file';
        if (dirent) {
            if (dirent.isDirectory()) {
                type = 'directory';
            } else if (dirent.isSymbolicLink()) {
                type = 'symlink';
            }
        } else {
            if (stat.isDirectory()) {
                type = 'directory';
            } else if (stat.isSymbolicLink()) {
                type = 'symlink';
            }
        }

        return {
            name,
            path: fullPath,
            type,
            size: stat.size,
            modifiedDate: stat.mtimeMs,
            isHidden: name.startsWith('.'),
        };
    }
}
