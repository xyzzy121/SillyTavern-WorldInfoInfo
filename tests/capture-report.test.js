import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import * as parser from '../wi-log-parser.js';

// Run the extension entry point with host/DOM adapters. This exercises console
// boundaries and the actual report callback without needing a running server.
class Element {
    children = [];
    classes = new Set();
    style = {};
    ownText = '';
    classList = {
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        contains: value => this.classes.has(value),
    };
    append(...children) { this.children.push(...children); }
    addEventListener() {}
    setAttribute() {}
    set innerHTML(value) { this.children = []; this.ownText = value; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
}

function fixture(admin = true, handle = 'alice') {
    const commands = {};
    const metadata = {};
    const eventSource = new EventEmitter();
    const consoleCalls = [];
    let popup = null;
    const context = {
        ...parser,
        console: { debug: (...args) => consoleCalls.push(args), log: (...args) => consoleCalls.push(args) },
        window: { addEventListener() {} },
        document: { createElement: () => new Element(), body: new Element() },
        chat: [], chat_metadata: metadata, main_api: 'openai',
        extension_settings: {}, metadata_keys: {}, world_info_position: {},
        event_types: { GENERATION_STARTED: 'generation', CHAT_CHANGED: 'chat', WORLD_INFO_ACTIVATED: 'activated' },
        eventSource,
        saveSettingsDebounced() {},
        isAdmin: () => admin,
        getCurrentUserHandle: () => handle,
        delay: async () => {},
        promptManager: {},
        SlashCommand: { fromProps: props => props },
        SlashCommandParser: { commands, addCommandObject(command) { commands[command.name] = command; } },
        Popup: class { constructor(element) { popup = element; } async show() {} },
        POPUP_TYPE: { TEXT: 1 },
        requestAnimationFrame() {},
    };
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '');
    runInNewContext(source, context);
    return {
        context, metadata, eventSource, consoleCalls,
        log: (...args) => context.console.debug(...args),
        async report() { await commands['wi-report'].callback(); return popup.textContent; },
    };
}

function start(f, dry = false) {
    f.log(`[WI] --- START WI SCAN (on 2 messages, trigger = normal)${dry ? ' (DRY RUN)' : ''} ---`);
}
function processing(f, entry, keyword) {
    f.log(`[WI] Entry ${entry.uid}`, `from '${entry.world}' processing`, entry);
    f.log(`[WI] Entry ${entry.uid}`, 'activated by primary key match', keyword);
}
function commit(f, entry) {
    f.log(`[WI] Entry ${entry.uid} activation successful, adding to prompt`, entry);
}
function complete(f, entries, dry = false) {
    f.log('[WI] --- LOOP #1 RESULT ---');
    f.log(`[WI] Successfully activated ${entries.length} new entries to prompt. ${entries.length} total entries activated.`, entries);
    f.log('[WI] --- BUILDING PROMPT ---');
    f.log(`[WI] ${dry ? 'Hypothetically adding' : 'Adding'} ${entries.length} entries to prompt`);
    f.log(`[WI] --- DONE${dry ? ' (DRY RUN)' : ''} ---`);
}

test('actual capture and report separate duplicate UIDs with unusual names', async () => {
    const f = fixture();
    const a = { world: "Scholar's: notes 📚", uid: 1 };
    const b = { world: '  Other\nbook [II]  ', uid: 1 };
    start(f);
    f.log('[WI] --- LOOP #1 START ---');
    processing(f, a, 'apple');
    processing(f, b, 'banana');
    commit(f, b);
    commit(f, a);
    complete(f, [a, b]);
    assert.equal(f.metadata.stwiiActivationEvents[0].primary, 'banana');
    assert.equal(f.metadata.stwiiActivationEvents[1].primary, 'apple');
    assert.equal(f.metadata.stwiiLastLoopEntryIds[0][0], parser.entryKey(b.world, b.uid));
    const report = await f.report();
    assert.ok(report.includes(a.world));
    assert.ok(report.includes(b.world));
    assert.ok(report.includes('(apple)'));
    assert.ok(report.includes('(banana)'));
    assert.ok(report.includes('Loop 1: 2 entries'));
    assert.ok(f.consoleCalls.length > 0, 'original console calls are forwarded');
});

test('dry runs preserve the latest actual report and scan details', async () => {
    const f = fixture();
    const entry = { world: 'Saved book', uid: 1 };
    start(f);
    f.log('[WI] --- LOOP #1 START ---');
    processing(f, entry, 'saved');
    commit(f, entry);
    complete(f, [entry]);
    const report = await f.report();
    start(f, true);
    f.log('[WI] --- LOOP #1 START ---');
    processing(f, entry, 'dry keyword');
    commit(f, entry);
    complete(f, [entry], true);
    assert.equal(f.metadata.stwiiBuilds.length, 1);
    assert.equal(f.metadata.stwiiActivationEvents.length, 1);
    assert.equal(await f.report(), report);
});

test('zero-activation loops retain their place in per-loop IDs', async () => {
    const f = fixture();
    const entry = { world: 'Second loop', uid: 2 };
    start(f);
    f.log('[WI] --- LOOP #1 START ---');
    f.log('[WI] --- LOOP #1 RESULT ---');
    f.log('[WI] No new entries activated.');
    f.log('[WI] --- LOOP #2 START ---');
    processing(f, entry, 'second');
    commit(f, entry);
    f.log('[WI] --- LOOP #2 RESULT ---');
    f.log('[WI] Successfully activated 1 new entries to prompt.', [entry]);
    f.log('[WI] --- BUILDING PROMPT ---');
    f.log('[WI] Adding 1 entries to prompt');
    f.log('[WI] --- DONE ---');
    assert.equal(JSON.stringify(f.metadata.stwiiLastLoopCounts), '[0,1]');
    assert.equal(JSON.stringify(f.metadata.stwiiLastLoopEntryIds[0]), '[]');
    assert.ok((await f.report()).includes('Loop 2: 1 entries'));
});

test('chat changes clear in-progress attribution before later commits', () => {
    const f = fixture();
    const entry = { world: 'Shared book', uid: 1 };
    start(f);
    processing(f, entry, 'old chat keyword');
    f.eventSource.emit('chat');
    commit(f, entry);
    assert.equal(f.metadata.stwiiActivationEvents.at(-1).primary, null);
    assert.equal(f.context.window.STWII.currentRunId, null);
});

test('historical report IDs, fallback keywords, and hidden-book rules remain compatible', async () => {
    const f = fixture(false, 'alice');
    const events = [
        { world: "Reader's: book", uid: 1 },
        { world: '9Z hidden', uid: 2, primary: 'secret' },
        { world: '9Z Universal Commands', uid: 3, primary: 'universal' },
        { world: 'Z-alice-notes', uid: 4, primary: 'mine' },
        { world: 'Z-bob-notes', uid: 5, primary: 'theirs' },
    ];
    f.metadata.stwiiBuilds = [{ added: events, logs: [
        '[WI] --- LOOP #1 START ---',
        "[WI] Entry 1 from 'Reader's: book' processing",
        '[WI] Entry 1 activated by primary key match restored',
        '[WI] --- LOOP #1 RESULT ---',
    ] }];
    f.metadata.stwiiLastLoopCounts = [events.length];
    f.metadata.stwiiLastLoopEntryIds = [events.map(entry => `${entry.world}:${entry.uid}`)];
    const report = await f.report();
    assert.ok(report.includes("Reader's: book"));
    assert.ok(report.includes('(restored)'));
    assert.ok(report.includes('9Z Universal Commands'));
    assert.ok(report.includes('Z-alice-notes'));
    assert.ok(report.includes('Loop 1: 3 entries'));
    assert.ok(!report.includes('9Z hidden'));
    assert.ok(!report.includes('Z-bob-notes'));
    assert.ok(!report.includes('secret'));
});

test('scan marker text in a lorebook name never starts a different build', () => {
    const f = fixture();
    const entry = { world: 'A [WI] --- START WI SCAN --- title', uid: 1 };
    start(f);
    const runId = f.context.window.STWII.currentRunId;
    processing(f, entry, 'keyword');
    commit(f, entry);
    complete(f, [entry]);
    assert.equal(f.metadata.stwiiBuilds[0].runId, runId);
    assert.equal(f.metadata.stwiiBuilds[0].added[0].primary, 'keyword');
});
