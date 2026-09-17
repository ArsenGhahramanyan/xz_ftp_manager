import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferItem } from '../src/core/transfer/TransferItem';

function makeItem() {
    return new TransferItem({
        connectionId: 'c1',
        localPath: '/tmp/a.txt',
        remotePath: '/remote/a.txt',
        direction: 'download',
    });
}

test('new item starts queued with no resume offset', () => {
    const item = makeItem();
    assert.equal(item.status, 'queued');
    assert.equal(item.resumeOffset, 0);
    assert.equal(item.abortSignal.aborted, false);
});

test('activate -> complete transitions', () => {
    const item = makeItem();
    item.activate();
    assert.equal(item.status, 'active');
    item.complete();
    assert.equal(item.status, 'completed');
});

test('pausing an active transfer records the offset and aborts I/O', () => {
    const item = makeItem();
    item.activate();
    item.updateProgress(100, 200);
    item.pause();
    assert.equal(item.status, 'paused');
    assert.equal(item.resumeOffset, 100);
    assert.equal(item.abortSignal.aborted, true);
});

test('resume installs a fresh (un-aborted) abort signal', () => {
    const item = makeItem();
    item.activate();
    item.updateProgress(50, 200);
    item.pause();
    const pausedSignal = item.abortSignal;
    item.resume();
    assert.equal(item.status, 'queued');
    assert.equal(item.abortSignal.aborted, false);
    assert.notEqual(item.abortSignal, pausedSignal);
    // Resume offset is preserved for the engine to continue from.
    assert.equal(item.resumeOffset, 50);
});

test('cancel aborts the signal', () => {
    const item = makeItem();
    item.activate();
    item.cancel();
    assert.equal(item.status, 'cancelled');
    assert.equal(item.abortSignal.aborted, true);
});

test('retry resets progress and resume offset', () => {
    const item = makeItem();
    item.activate();
    item.updateProgress(100, 200);
    item.fail('boom');
    assert.equal(item.status, 'failed');
    item.retry();
    assert.equal(item.status, 'queued');
    assert.equal(item.resumeOffset, 0);
    assert.equal(item.transferredBytes, 0);
    assert.equal(item.abortSignal.aborted, false);
});

test('invalid transitions throw', () => {
    const item = makeItem();
    // Cannot complete a queued (never-activated) item.
    assert.throws(() => item.complete());
});
