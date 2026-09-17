/**
 * Format a byte count into a human-readable size string.
 * E.g. 1536 -> "1.5 KB", 2621440 -> "2.5 MB"
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    if (bytes === 0) {
        return '0 B';
    }
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exp);
    const decimals = exp === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[exp]}`;
}

/**
 * Format a transfer speed (bytes/s) into a human-readable string.
 * E.g. 1048576 -> "1.0 MB/s"
 */
export function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec <= 0) {
        return '0 B/s';
    }
    return `${formatFileSize(bytesPerSec)}/s`;
}
