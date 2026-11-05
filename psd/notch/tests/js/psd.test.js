// psd.test.js — the Agent tab's pure logic, testable without GNOME Shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSseChunk, normalizeBaseUrl, describeAnswer} from '../../extension/lib/psd-protocol.js';
import {headerLayout, headerMode, TAB_COUNT} from '../../extension/lib/layout.js';
import {PAGE_SIZES, notchGeometry} from '../../extension/lib/geometry.js';

test('SSE framing keeps the tail and parses every event', () => {
    const first = parseSseChunk('event: start\ndata: {"at":1}\n\nevent: token\ndata: {"text":"hi"}\n\nevent: tok');
    assert.equal(first.events.length, 2);
    assert.equal(first.events[0].event, 'start');
    assert.equal(first.events[1].data.text, 'hi');
    assert.equal(first.rest, 'event: tok');

    const second = parseSseChunk(`${first.rest}en\ndata: {"text":" there"}\n\n`);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].data.text, ' there');
    // A trailing block with no complete terminator stays in the tail.
    assert.equal(parseSseChunk('done: x\n\n').events.length, 0);
    assert.equal(parseSseChunk('event: a\ndata: {"x":1}\n').rest, 'event: a\ndata: {"x":1}\n');
});

test('SSE framing ignores heartbeats and survives broken JSON', () => {
    const parsed = parseSseChunk(': ping\n\nevent: token\ndata: not-json\n\n');
    assert.equal(parsed.events.length, 1);
    assert.deepEqual(parsed.events[0].data, {text: 'not-json'});
    assert.deepEqual(parseSseChunk('').events, []);
});

test('the agent URL is normalised the way a human types it', () => {
    assert.equal(normalizeBaseUrl('127.0.0.1:7788'), 'http://127.0.0.1:7788');
    assert.equal(normalizeBaseUrl('http://pc:7788/'), 'http://pc:7788');
    assert.equal(normalizeBaseUrl('  https://psd.lan  '), 'https://psd.lan');
    assert.equal(normalizeBaseUrl(''), '');
});

test('the five-tab header still fits inside the notch at every scale', () => {
    assert.equal(TAB_COUNT, 5);
    for (const width of [194, 220, 300, 360, 480, 560, 660, 820, 1000]) {
        for (const textScale of [0.8, 1, 1.25, 1.5, 2]) {
            const layout = headerLayout(width, textScale);
            assert.ok(layout.requiredWidth <= width,
                `header ${layout.mode} needs ${layout.requiredWidth}px in ${width}px @${textScale}`);
        }
    }
    assert.equal(headerLayout(820, 1).mode, 'labels');
    assert.equal(headerLayout(560, 1).mode, 'icons');
    assert.equal(headerMode(660), 'labels');
    assert.equal(headerMode(600), 'icons');
});

test('the agent page is the roomiest page and stays on screen', () => {
    assert.ok(PAGE_SIZES.chat.width >= PAGE_SIZES.media.width);
    assert.ok(PAGE_SIZES.chat.height > PAGE_SIZES.home.height);
    const options = {cssScale: 1, layoutScale: 1, panelHeight: 32, placement: 'panel', expandedWidth: 900, expandedHeight: 620};
    for (const monitor of [{width: 1920, height: 1080}, {width: 1366, height: 768}, {width: 800, height: 600}]) {
        const rect = notchGeometry({...monitor, x: 0, y: 0}, {...options, tab: 'chat'}, true);
        assert.ok(rect.width <= monitor.width && rect.height <= monitor.height);
        assert.ok(rect.x >= 0 && rect.x + rect.width <= monitor.width);
        assert.ok(rect.y + rect.height <= monitor.height);
    }
});

test('the answer footer never lies about latency or tools', () => {
    assert.equal(describeAnswer({path: 'intent', toolsUsed: ['disk_space'], }, 8), 'intent · disk_space · 8 ms');
    assert.equal(describeAnswer({path: 'model'}, 2400), 'model · 2.4 s');
    assert.equal(describeAnswer({path: 'quick'}, 0), 'quick');
    assert.equal(describeAnswer({}, 0), '');
    assert.equal(describeAnswer({path: 'model', toolsUsed: ['a', 'b', 'c', 'd']}, 5), 'model · a, b, c · 5 ms');
});
