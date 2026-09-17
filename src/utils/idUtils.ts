import * as crypto from 'crypto';

/**
 * Cryptographically random ID with a human-readable prefix.
 * Replaces the legacy `${Date.now()}_${Math.random()...}` pattern, which is
 * predictable and collision-prone for SecretStorage keys.
 */
export function makeId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Cryptographically random nonce for CSP `script-src 'nonce-...'`.
 * Math.random() is predictable and would defeat the nonce.
 */
export function makeNonce(): string {
    return crypto.randomBytes(16).toString('base64').replace(/[+/=]/g, '');
}
