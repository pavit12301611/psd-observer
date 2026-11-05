// uninstall.test.js — installing and uninstalling must never eat the owner's data.
//
// The bug this guards: the runtime was installed to ~/.local/share/psd, which is
// ALSO where the app keeps its data (token.txt, memory.json, runs.jsonl). Two
// consequences, both real:
//
//   1. link_bin() starts with `rm -rf "$SHAREDIR"`, so re-installing PSD wiped
//      the token and the memory it was reinstalling to keep.
//   2. uninstall deleted $SHAREDIR, so `uninstall` (no --purge) destroyed the
//      data, and the separate "kept your data" message never printed because the
//      directory was already gone.
//
// The check below is deliberately structural, not behavioural: it asserts the
// two paths are distinct in the script itself, and that the uninstall path only
// removes the data directory when --purge was asked for. A behavioural test
// would need a full install, and the install is what used to do the damage.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/psd.sh');
const source = fs.readFileSync(script, 'utf8');

/** The body of a shell function, from `name() {` to the first line that is `}`. */
const functionBody = (name) => {
    const start = source.indexOf(`\n${name}() {`);
    assert.notEqual(start, -1, `${name}() is missing from psd.sh`);
    const end = source.indexOf('\n}', start);
    assert.notEqual(end, -1, `${name}() is not closed`);
    return source.slice(start, end);
};

test('the runtime directory is not the data directory', () => {
    const shared = source.match(/^SHAREDIR="([^"]+)"/m);
    const data = source.match(/^DATADIR="([^"]+)"/m);
    assert.ok(shared, 'psd.sh must set SHAREDIR');
    assert.ok(data, 'psd.sh must set DATADIR');

    // Compare the interesting suffix: both are expansion strings, so a literal
    // equality test is enough to catch the historical "$PREFIX/share/psd" for
    // both. Require that the runtime is not under share/psd at all.
    assert.doesNotMatch(shared[1], /share\/psd$/,
        `SHAREDIR (${shared[1]}) must not be the data directory — that is what ` +
        'deleted the token and memory on every reinstall');
    assert.match(data[1], /share.*psd$/, 'DATADIR is the app data directory');
    assert.notEqual(shared[1], data[1]);
});

test('reinstalling does not delete the data directory', () => {
    const body = functionBody('link_bin');
    assert.doesNotMatch(body, /rm\s+-rf\s+"\$DATADIR"/,
        'link_bin() must never rm -rf the data directory');
    // It still has to clear its own runtime directory.
    assert.match(body, /rm\s+-rf\s+"\$SHAREDIR"/);
});

test('uninstall keeps the data directory unless --purge', () => {
    const body = functionBody('uninstall_cmd');

    // The only unconditional deletion of $DATADIR must be inside the purge branch.
    const purge = body.indexOf('if [ "$purge" = "1" ]; then');
    assert.notEqual(purge, -1, 'uninstall_cmd() must branch on --purge');
    const afterPurge = body.slice(purge);
    const purgeDeletes = afterPurge.indexOf('rm -rf "$datadir"');
    assert.notEqual(purgeDeletes, -1, '--purge must delete the data directory');

    const firstDelete = body.indexOf('rm -rf "$DATADIR"');
    if (firstDelete !== -1) {
        assert.ok(firstDelete > purge,
            'the data directory may only be removed in the --purge branch');
    }

    // And the "kept" message must exist, so the owner is told where their data is.
    assert.match(body, /kept \$datadir|kept "\$datadir"/,
        'uninstall must tell the owner their data was kept');
});

test('uninstall removes only program files from a legacy data directory', () => {
    const body = functionBody('uninstall_cmd');
    // Older installs have src/, web/, agents/… sitting next to token.txt.
    for (const file of ['token.txt', 'memory.json', 'runs.jsonl']) {
        assert.doesNotMatch(body, new RegExp(file),
            `uninstall must not reference ${file} — it may only delete program files`);
    }
});
