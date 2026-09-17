/**
 * Strip sensitive substrings (URLs, IP addresses, absolute filesystem paths)
 * from an error message before showing it in a user-facing notification.
 *
 * VS Code surfaces `showErrorMessage` text in the bottom-right toast where it
 * can be glanced at by anyone near the screen. Library-level errors often
 * include the connection target ("ECONNREFUSED 10.0.5.7:22") or the local
 * disk path of a temp file. Logs (LogService) keep the full message; this
 * helper only redacts what is shown in the UI.
 *
 * Replaces:
 *   - URLs (any scheme)            → "<url>"
 *   - IPv4 with optional :port     → "<addr>"
 *   - IPv6 in brackets w/ port     → "<addr>"
 *   - UNC paths                    → "<path>"
 *   - Windows absolute paths       → "<path>"
 *   - POSIX absolute paths (>= 1 sub-segment, so a bare "/" stays)
 *                                  → "<path>"
 */
export function sanitizeForUi(input: unknown): string {
    let msg: string;
    if (input instanceof Error) {
        msg = input.message;
    } else if (typeof input === 'string') {
        msg = input;
    } else {
        msg = String(input);
    }

    // Order matters: URL/IP before path so the URL host doesn't get re-matched.

    // 1) URLs with any scheme (http, https, ftp, sftp, file, …)
    msg = msg.replace(/\b[a-z][a-z0-9+\-.]*:\/\/\S+/gi, '<url>');

    // 2) IPv6 in brackets, optionally with :port
    msg = msg.replace(/\[[0-9a-fA-F:]+\](?::\d+)?/g, '<addr>');

    // 3) IPv4 with optional :port
    msg = msg.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<addr>');

    // 4) UNC paths: \\server\share\...
    msg = msg.replace(/\\\\[^\s\\"']+\\[^\s"']+/g, '<path>');

    // 5) Windows drive paths: C:\foo, C:/foo
    msg = msg.replace(/\b[A-Za-z]:[\\/][^\s"'<>|?*]+/g, '<path>');

    // 6) POSIX absolute paths with at least one segment under root.
    //    Bare "/" (e.g. the remote root) is preserved.
    msg = msg.replace(/(^|[\s'"`(])\/[^\s"'`<>|?*]+/g, (_m, pre) => `${pre}<path>`);

    return msg;
}
