import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeRemotePath,
    joinRemotePath,
    getParentPath,
    getFileName,
    assertSafeRemotePath,
    assertSafeEntryName,
    assertWithinDirectory,
} from '../src/utils/pathUtils';

test('normalizeRemotePath collapses slashes and trims trailing', () => {
    assert.equal(normalizeRemotePath('/a//b/'), '/a/b');
    assert.equal(normalizeRemotePath('a\\b'), 'a/b');
    assert.equal(normalizeRemotePath('/'), '/');
    assert.equal(normalizeRemotePath(''), '/');
});

test('joinRemotePath joins with forward slashes', () => {
    assert.equal(joinRemotePath('/a', 'b'), '/a/b');
    assert.equal(joinRemotePath('/a/', '/b/'), '/a/b');
});

test('getParentPath / getFileName', () => {
    assert.equal(getParentPath('/a/b/c'), '/a/b');
    assert.equal(getParentPath('/a'), '/');
    assert.equal(getParentPath('/'), '/');
    assert.equal(getFileName('/a/b/c.txt'), 'c.txt');
});

test('assertSafeRemotePath rejects CR/LF/NUL', () => {
    assert.doesNotThrow(() => assertSafeRemotePath('/ok/path'));
    assert.throws(() => assertSafeRemotePath('/bad\r\nDELE x'));
    assert.throws(() => assertSafeRemotePath('/bad\0'));
});

test('assertSafeEntryName rejects traversal and separators', () => {
    assert.doesNotThrow(() => assertSafeEntryName('file.txt'));
    assert.throws(() => assertSafeEntryName('..'));
    assert.throws(() => assertSafeEntryName('.'));
    assert.throws(() => assertSafeEntryName('a/b'));
    assert.throws(() => assertSafeEntryName('a\\b'));
    assert.throws(() => assertSafeEntryName('C:evil'));
    assert.throws(() => assertSafeEntryName(''));
});

test('assertWithinDirectory blocks escapes', () => {
    assert.doesNotThrow(() => assertWithinDirectory('/base', '/base/child'));
    assert.throws(() => assertWithinDirectory('/base', '/base/../evil'));
    // Sibling-prefix escape must be rejected (not a naive startsWith).
    assert.throws(() => assertWithinDirectory('/base', '/base-evil/x'));
});
