import * as vscode from 'vscode';
import { FileEntry, SearchQuery } from '../core/models/interfaces';
import { ConnectionManager } from '../core/connection/ConnectionManager';

/**
 * Remote file search using breadth-first traversal.
 * Results are reported progressively via the `onDidFindResult` event.
 */
/** Hard bounds on remote traversal, so a hostile/misbehaving server that
 *  returns cyclic or ever-deeper listings can't exhaust the extension host. */
const MAX_SEARCH_DEPTH = 40;
const MAX_DIRS_VISITED = 20_000;
const MAX_RESULTS = 10_000;

export class SearchService implements vscode.Disposable {
    private readonly _onDidFindResult = new vscode.EventEmitter<FileEntry>();
    public readonly onDidFindResult: vscode.Event<FileEntry> = this._onDidFindResult.event;

    constructor(private readonly connectionManager: ConnectionManager) {}

    /**
     * Walk the remote directory tree breadth-first, testing each entry
     * against `query`.  Honours the cancellation token.
     */
    async search(
        connectionId: string,
        query: SearchQuery,
        token: vscode.CancellationToken,
    ): Promise<FileEntry[]> {
        const adapter = this.connectionManager.getAdapter(connectionId);
        if (!adapter) {
            throw new Error(`No active connection for id "${connectionId}"`);
        }

        const results: FileEntry[] = [];
        const visited = new Set<string>();
        // Track depth alongside each directory so we can cap recursion.
        const queue: Array<{ dir: string; depth: number }> = [{ dir: query.remotePath, depth: 0 }];
        let dirsVisited = 0;

        while (queue.length > 0 && !token.isCancellationRequested) {
            const { dir, depth } = queue.shift()!;

            // Guard against cycles / self-referential listings and runaway trees.
            const normalizedDir = dir.replace(/\/+$/, '') || '/';
            if (visited.has(normalizedDir)) {
                continue;
            }
            visited.add(normalizedDir);
            if (++dirsVisited > MAX_DIRS_VISITED) {
                break;
            }

            let entries: FileEntry[];
            try {
                entries = await adapter.list(dir);
            } catch {
                // Skip directories we cannot list (permission denied, etc.)
                continue;
            }

            for (const entry of entries) {
                if (token.isCancellationRequested) {
                    break;
                }

                if (
                    entry.type === 'directory' &&
                    query.recursive &&
                    depth + 1 <= MAX_SEARCH_DEPTH &&
                    !visited.has(entry.path.replace(/\/+$/, '') || '/')
                ) {
                    queue.push({ dir: entry.path, depth: depth + 1 });
                }

                if (this.matches(entry, query)) {
                    results.push(entry);
                    this._onDidFindResult.fire(entry);
                    if (results.length >= MAX_RESULTS) {
                        return results;
                    }
                }
            }
        }

        return results;
    }

    dispose(): void {
        this._onDidFindResult.dispose();
    }

    // ── Private matching logic ───────────────────────────────────────

    private matches(entry: FileEntry, query: SearchQuery): boolean {
        // Name match (glob or regex)
        if (!this.nameMatches(entry.name, query)) {
            return false;
        }

        // Size filters
        if (query.minSize !== undefined && entry.size < query.minSize) {
            return false;
        }
        if (query.maxSize !== undefined && entry.size > query.maxSize) {
            return false;
        }

        // Date filters
        if (query.modifiedAfter !== undefined && entry.modifiedDate < query.modifiedAfter) {
            return false;
        }
        if (query.modifiedBefore !== undefined && entry.modifiedDate > query.modifiedBefore) {
            return false;
        }

        return true;
    }

    private nameMatches(name: string, query: SearchQuery): boolean {
        const pattern = query.pattern;
        if (!pattern) {
            return true;
        }

        if (query.useRegex) {
            // ReDoS guard: cap length and reject patterns with obvious
            // catastrophic-backtracking shapes. Node's regex engine has no
            // execution timeout, so we have to gate the input.
            if (pattern.length > 256) {
                return false;
            }
            if (isPotentiallyCatastrophicRegex(pattern)) {
                return false;
            }
            try {
                const flags = query.matchCase ? '' : 'i';
                return new RegExp(pattern, flags).test(name);
            } catch {
                return false;
            }
        }

        // Simple glob matching: convert glob to regex
        return this.globToRegex(pattern, query.matchCase).test(name);
    }

    /**
     * Converts a basic glob (supports `*`, `?`, and character classes) into
     * a RegExp anchored to the full string.
     */
    private globToRegex(glob: string, matchCase: boolean): RegExp {
        let regexStr = '^';
        for (let i = 0; i < glob.length; i++) {
            const ch = glob[i];
            switch (ch) {
                case '*':
                    regexStr += '.*';
                    break;
                case '?':
                    regexStr += '.';
                    break;
                case '.':
                case '(':
                case ')':
                case '+':
                case '|':
                case '^':
                case '$':
                case '\\':
                case '{':
                case '}':
                    regexStr += '\\' + ch;
                    break;
                case '[': {
                    // Pass character class through verbatim until closing ]
                    let cls = '[';
                    i++;
                    while (i < glob.length && glob[i] !== ']') {
                        cls += glob[i];
                        i++;
                    }
                    cls += ']';
                    regexStr += cls;
                    break;
                }
                default:
                    regexStr += ch;
            }
        }
        regexStr += '$';
        const flags = matchCase ? '' : 'i';
        return new RegExp(regexStr, flags);
    }
}

/**
 * Best-effort detector for regex shapes that are known to backtrack
 * catastrophically. Not exhaustive, but blocks the common attack patterns
 * (nested quantifiers, alternations on overlapping subpatterns).
 */
function isPotentiallyCatastrophicRegex(pattern: string): boolean {
    // Nested quantifiers: (..)*+, (..)++, (..)*{n,}, (..)+? etc.
    if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) {
        return true;
    }
    // Alternation-overlap groups followed by a quantifier: (a|a)+, (aa|aa)*,
    // (a|ab)+ etc. These have no quantifier INSIDE the parens (so the check
    // above misses them) yet backtrack exponentially.
    if (/\([^)]*\|[^)]*\)[*+{]/.test(pattern)) {
        return true;
    }
    // Repetition of an already-greedy class: .*.*, .+.+, etc.
    if (/(\.[*+]){2,}/.test(pattern)) {
        return true;
    }
    return false;
}
