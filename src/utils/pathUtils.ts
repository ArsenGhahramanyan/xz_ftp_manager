import * as nodePath from 'path';

/**
 * Normalize a remote path: convert backslashes to forward slashes and strip
 * any trailing slash (except for the root "/").
 */
export function normalizeRemotePath(p: string): string {
    let normalized = p.replace(/\\/g, '/');
    // Collapse consecutive slashes
    normalized = normalized.replace(/\/+/g, '/');
    // Remove trailing slash unless it is the root
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized || '/';
}

/**
 * Join one or more path segments using forward slashes.
 */
export function joinRemotePath(...parts: string[]): string {
    const joined = parts
        .map((p) => p.replace(/\\/g, '/'))
        .join('/');
    return normalizeRemotePath(joined);
}

/**
 * Return the parent directory of the given remote path.
 */
export function getParentPath(p: string): string {
    const normalized = normalizeRemotePath(p);
    if (normalized === '/') {
        return '/';
    }
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
        return '/';
    }
    return normalized.slice(0, lastSlash);
}

/**
 * Return the file (or directory) name of the given remote path.
 */
export function getFileName(p: string): string {
    const normalized = normalizeRemotePath(p);
    if (normalized === '/') {
        return '/';
    }
    const lastSlash = normalized.lastIndexOf('/');
    return normalized.slice(lastSlash + 1);
}

/**
 * Reject CR, LF and NUL in remote paths. Text-based FTP commands are
 * delimited by CRLF, so these bytes can be used to inject extra commands
 * (e.g. `chmod 0o755 file\r\nDELE /etc/passwd`).
 */
export function assertSafeRemotePath(p: string, label = 'remote path'): void {
    if (typeof p !== 'string') {
        throw new Error(`Invalid ${label}: must be a string`);
    }
    if (/[\r\n\0]/.test(p)) {
        throw new Error(`Invalid ${label}: contains CR, LF or NUL`);
    }
}

/**
 * Validate a single directory entry name returned by the server before it is
 * joined with a local path. Prevents FTP-Slip / Zip-Slip attacks where a
 * malicious server returns "../" or absolute names to escape the download
 * directory.
 */
export function assertSafeEntryName(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error('Invalid entry name: empty');
    }
    if (name === '.' || name === '..') {
        throw new Error('Invalid entry name: traversal');
    }
    if (/[\\/\0]/.test(name)) {
        throw new Error(`Invalid entry name: contains separator or NUL (${JSON.stringify(name)})`);
    }
    // Windows device names / drive letters; refuse colons to be safe.
    if (/^[A-Za-z]:/.test(name) || name.includes(':')) {
        throw new Error(`Invalid entry name: contains colon (${JSON.stringify(name)})`);
    }
    // Control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(name)) {
        throw new Error('Invalid entry name: contains control characters');
    }
}

/**
 * Verify that `child` resolves inside `parent` after path normalization.
 * Used as belt-and-braces after `assertSafeEntryName` to defend against
 * symlink-style or platform-specific escapes.
 */
export function assertWithinDirectory(parent: string, child: string): void {
    const resolvedParent = nodePath.resolve(parent);
    const resolvedChild = nodePath.resolve(child);
    const rel = nodePath.relative(resolvedParent, resolvedChild);
    if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
        throw new Error(`Path escapes target directory: ${child}`);
    }
}
