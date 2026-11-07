import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import * as parser from '../wi-log-parser.js';

// Run the extension entry point with host/DOM adapters. This exercises console
// boundaries, activation panel, and report callbacks without a running server.
class Element {
    children = [];
    classes = new Set();
    style = {};
    dataset = {};
    listeners = new Map();
    offsetWidth = 40;
    offsetHeight = 32;
    ownText = '';
    classList = {
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        contains: value => this.classes.has(value),
    };
    append(...children) { this.children.push(...children); }
    addEventListener(name, listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(listener);
    }
    click() { for (const listener of this.listeners.get('click') ?? []) listener({ target: this }); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 40, bottom: 32 }; }
    setAttribute() {}
    set innerHTML(value) { this.children = []; this.ownText = value; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
}

function fixture(admin = true, handle = 'alice', extensionSettings = {}, tokenizer = async text => text.length) {
    const commands = {};
    const metadata = {};
    const eventSource = new EventEmitter();
    const consoleCalls = [];
    const tokenCalls = [];
    let popup = null;
    let saves = 0;
    const windowEvents = {};
    const context = {
        ...parser,
        console: { debug: (...args) => consoleCalls.push(args), log: (...args) => consoleCalls.push(args) },
        window: { innerWidth: 390, innerHeight: 844, addEventListener(name, listener) { windowEvents[name] = listener; } },
        CSS: { supports: () => false },
        document: { createElement: () => new Element(), body: new Element() },
        chat: [], chat_metadata: metadata, main_api: 'openai',
        extension_settings: extensionSettings,
        metadata_keys: { depth: 'noteDepth', prompt: 'notePrompt' },
        world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 },
        event_types: { GENERATION_STARTED: 'generation', CHAT_CHANGED: 'chat', WORLD_INFO_ACTIVATED: 'activated' },
        eventSource,
        saveSettingsDebounced() { saves++; },
        isAdmin: () => admin,
        getCurrentUserHandle: () => handle,
        getTokenCountAsync(...args) { tokenCalls.push(args); return tokenizer(...args); },
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
        context, metadata, eventSource, consoleCalls, commands, tokenCalls,
        get panel() { return context.window.STWII.panel; },
        activate(entries) { return eventSource.listeners('activated')[0](entries); },
        triggered() { return JSON.parse(commands['wi-triggered'].callback()); },
        setSetting(name, value) {
            const row = { group: 0, order: 1, mes: 2 }[name];
            const checkbox = context.window.STWII.configPanel.children[row].children[0];
            checkbox.checked = value;
            checkbox.click();
        },
        resize(width, height) {
            context.window.innerWidth = width;
            context.window.innerHeight = height;
            windowEvents.resize();
        },
        get saves() { return saves; },
        log: (...args) => context.console.debug(...args),
        async report() { await commands['wi-report'].callback(); return popup.textContent; },
    };
}

function activeEntry(world = 'Working book', uid = 1, overrides = {}) {
    return { world, uid, key: ['trigger'], comment: `Entry ${uid}`, content: 'Entry content', position: 0, depth: 7, order: 100, sticky: 5, ...overrides };
}

function elementsWithClass(element, name) {
    return [
        ...(element.classes.has(name) ? [element] : []),
        ...element.children.flatMap(child => elementsWithClass(child, name)),
    ];
}

async function settleTokens() {
    // Let the background tokenizer and its completion callbacks finish without
    // relying on a particular number of chained promise reactions.
    await new Promise(resolve => setImmediate(resolve));
}

function totalText(f) {
    return elementsWithClass(f.panel, 'stwii--token-total')[0]?.textContent;
}

function bookTokenLabels(f) {
    return new Map(elementsWithClass(f.panel, 'stwii--token-count').map(element => [element.dataset.world, element.textContent]));
}

function assertEmptyPanel(f) {
    assert.equal(totalText(f), 'Loaded lore: 0 tokens');
    assert.ok(f.panel.textContent.includes('No active entries'));
    assert.equal(elementsWithClass(f.panel, 'stwii--entry').length, 0);
}

test('activated books absent from the file list render without a slash-command lookup', async () => {
    const f = fixture();
    const warnings = [];
    f.context.world_names = [];
    f.commands['wi-get-timed-effect'] = { callback() {
        warnings.push('Valid World Info file name is required');
        throw new Error('The display must not reload an already activated book');
    } };
    const entry = activeEntry("Already activated book's [name]");
    f.metadata.timedWorldInfo = { sticky: { [`${entry.world}.${entry.uid}`]: { end: 4 } } };
    await f.activate([entry]);
    assert.deepEqual(warnings, []);
    assert.ok(f.panel.textContent.includes(entry.world));
    assert.ok(f.panel.textContent.includes('📌 4'));
    assert.equal(f.triggered()[0].sticky, 4);
});

test('activation renders exact names and separate countdowns for identical UIDs', async () => {
    const f = fixture();
    const names = ["Scholar's: [book]", 'The "Glass" book', '星 📚 Cafe\u0301', 'two\nlines\tand tabs', 'Book', ' Book ', 'book', '?', '', '__proto__'];
    const entries = names.map(world => activeEntry(world));
    f.metadata.timedWorldInfo = { sticky: Object.fromEntries(names.map((world, i) => [`${world}.1`, { end: i + 1 }])) };
    await f.activate(entries);
    assert.deepEqual(f.triggered().map(entry => entry.world), names);
    assert.deepEqual(f.triggered().map(entry => entry.sticky), names.map((_, i) => i + 1));
    assert.deepEqual(elementsWithClass(f.panel, 'stwii--world-name').map(element => element.textContent), names);
    assert.deepEqual(elementsWithClass(f.panel, 'stwii--sticky').map(element => element.textContent), names.map((_, i) => `📌 ${i + 1}`));
});

test('remaining sticky duration counts only non-system messages and is an integer', async () => {
    const f = fixture();
    f.context.chat.push({ mes: 'User message' }, { is_system: true, mes: 'System message' }, { is_system: false, mes: 'Assistant message' });
    f.metadata.timedWorldInfo = { sticky: { 'Working book.1': { start: 0, end: 8.75 } } };
    await f.activate([activeEntry()]);
    assert.equal(f.triggered()[0].sticky, 6);
    assert.ok(f.panel.textContent.includes('📌 6'));
});

test('missing, malformed, and expired sticky metadata leave entries visible without an indicator', async () => {
    const cases = [
        undefined, null, {}, { sticky: null }, { sticky: {} },
        ...[null, false, 'invalid', {}, { end: null }, { end: '8' }, { end: NaN }, { end: Infinity }, { end: -Infinity }, { end: 0 }, { end: 1 }, { end: -4 }]
            .map(effect => ({ sticky: { 'Working book.1': effect } })),
    ];
    for (const metadata of cases) {
        const f = fixture();
        f.context.chat.push({ mes: 'First' }, { mes: 'Second' });
        f.metadata.timedWorldInfo = metadata;
        await f.activate([activeEntry()]);
        assert.equal(f.triggered()[0].sticky, 0);
        assert.ok(f.panel.textContent.includes('Working book'));
        assert.ok(f.panel.textContent.includes('Entry 1'));
        assert.equal(elementsWithClass(f.panel, 'stwii--sticky')[0].textContent, '');
        assert.ok(!f.panel.textContent.includes('NaN'));
    }
});

test('activation and rendering preserve frozen host entries and timed-effect metadata', async () => {
    const f = fixture();
    f.metadata.noteDepth = 2;
    const entry = Object.freeze(activeEntry('Frozen book', 1, { key: Object.freeze(['trigger']), position: 2 }));
    const original = JSON.stringify(entry);
    f.metadata.timedWorldInfo = Object.freeze({ sticky: Object.freeze({ 'Frozen book.1': Object.freeze({ end: 3 }) }) });
    await f.activate(Object.freeze([entry]));
    assert.equal(JSON.stringify(entry), original);
    assert.equal(f.metadata.timedWorldInfo.sticky['Frozen book.1'].end, 3);
    const [displayEntry] = f.triggered();
    assert.equal(displayEntry.type, 'wi');
    assert.equal(displayEntry.sticky, 3);
    assert.equal(displayEntry.depth, 2.1);
    assert.equal(entry.sticky, 5);
    assert.equal(entry.depth, 7);
    assert.ok(!Object.hasOwn(entry, 'type'));
});

test('activation completes synchronously without a timed-effect command and clears on chat change', async () => {
    const f = fixture();
    assert.ok(!Object.hasOwn(f.commands, 'wi-get-timed-effect'));
    const result = f.activate([activeEntry()]);
    await result;
    assert.equal(result, undefined);
    assert.equal(f.triggered().length, 1);
    f.eventSource.emit('chat');
    await Promise.resolve();
    assert.deepEqual(f.triggered(), []);
    assertEmptyPanel(f);
});

test('disabled and empty activation lists clear the previous entries and retain the empty placeholder', async () => {
    const f = fixture();
    await f.activate([activeEntry(), activeEntry('Disabled book', 2, { disable: true })]);
    assert.deepEqual(f.triggered().map(entry => entry.world), ['Working book']);
    assert.ok(!f.panel.textContent.includes('Disabled book'));
    for (const entries of [[activeEntry('Disabled book', 2, { disable: true })], []]) {
        await f.activate(entries);
        assert.deepEqual(f.triggered(), []);
        assertEmptyPanel(f);
    }
});

test('token counts render asynchronously from joined entry content with no padding argument', async () => {
    const f = fixture(true, 'alice', {}, async text => ({ 'first\nsecond': 11, other: 7 }[text]));
    f.context.chat.push({ mes: 'Chat text must not count' });
    f.metadata.notePrompt = 'Author note must not count';
    const a = activeEntry("Scholar's: [book] 📚", 1, { content: 'first', comment: 'Title must not count' });
    const b = activeEntry(a.world, 2, { content: 'second', key: ['Keyword must not count'] });
    const c = activeEntry('  Other\nbook  ', 1, { content: 'other' });
    assert.equal(f.activate([a, b, c]), undefined, 'activation stays synchronous');
    assert.equal(totalText(f), 'Loaded lore: Counting…');
    assert.ok(f.panel.textContent.includes('Title must not count'), 'entries render before tokenization completes');
    assert.equal(f.tokenCalls.length, 0, 'tokenization begins after the synchronous activation handler');
    await settleTokens();
    assert.deepEqual(f.tokenCalls, [['first\nsecond'], ['other']]);
    assert.equal(totalText(f), 'Loaded lore: ≈18 tokens');
    assert.deepEqual([...bookTokenLabels(f)], [[a.world, '≈11 tokens'], [c.world, '≈7 tokens']]);
});

test('token counts preserve exact lorebook identities even when names differ only by whitespace or case', async () => {
    const f = fixture();
    const names = ['Book', ' Book ', 'book', '星\nCafe\u0301', '__proto__', ''];
    f.activate(names.map((world, i) => activeEntry(world, 1, { content: 'x'.repeat(i + 1) })));
    await settleTokens();
    assert.deepEqual([...bookTokenLabels(f)], names.map((world, i) => [world, `≈${i + 1} tokens`]));
    assert.equal(totalText(f), 'Loaded lore: ≈21 tokens');
});

test('visible token totals follow admin and hidden-lorebook rules in both panel layouts', async () => {
    const entries = ['Public', '9Z hidden', '9Z Universal Commands', 'Z-alice-notes', 'Z-bob-notes']
        .map(world => activeEntry(world, 1, { content: world }));
    entries.push(activeEntry('Disabled', 2, { content: 'disabled', disable: true }));
    for (const admin of [false, true]) {
        for (const group of [false, true]) {
            const f = fixture(admin, 'alice', { worldInfoInfo: { group, mes: false } }, async () => 2);
            f.activate(entries);
            await settleTokens();
            const expected = admin ? entries.slice(0, 5) : [entries[0], entries[2], entries[3]];
            assert.deepEqual(f.tokenCalls.map(args => args[0]), expected.map(entry => entry.content));
            assert.deepEqual([...bookTokenLabels(f).keys()], expected.map(entry => entry.world));
            assert.equal(totalText(f), `Loaded lore: ≈${expected.length * 2} tokens`);
            assert.equal(elementsWithClass(f.panel, 'stwii--token-breakdown').length, group ? 0 : 1);
        }
    }
});

test('empty content and empty activations show zero without calling the tokenizer', async () => {
    const f = fixture();
    f.activate([activeEntry('Empty', 1, { content: '' }), activeEntry('Empty', 2, { content: undefined })]);
    await settleTokens();
    assert.deepEqual(f.tokenCalls, []);
    assert.equal(totalText(f), 'Loaded lore: 0 tokens');
    assert.equal(bookTokenLabels(f).get('Empty'), '0 tokens');
    f.activate([]);
    await settleTokens();
    assertEmptyPanel(f);
    assert.deepEqual(f.tokenCalls, []);
});

test('tokenizer failures leave entries usable and successful book counts visible', async () => {
    for (const failure of [new Error('Tokenizer unavailable'), NaN, Infinity, -1]) {
        const f = fixture(true, 'alice', {}, async text => {
            if (text === 'good') return 4;
            if (failure instanceof Error) throw failure;
            return failure;
        });
        f.activate([activeEntry('Good book', 1, { content: 'good' }), activeEntry('Failed book', 1, { content: 'bad' })]);
        await settleTokens();
        assert.equal(totalText(f), 'Loaded lore: Unavailable');
        assert.deepEqual([...bookTokenLabels(f)], [['Good book', '≈4 tokens'], ['Failed book', 'Unavailable']]);
        assert.equal(f.triggered().length, 2);
        assert.ok(f.panel.textContent.includes('Entry 1'));
    }
});

test('settings redraws retain pending and settled counts with a per-book breakdown when ungrouped', async () => {
    let resolve;
    const f = fixture(true, 'alice', { worldInfoInfo: { mes: false } }, () => new Promise(done => { resolve = done; }));
    f.activate([activeEntry()]);
    await settleTokens();
    f.setSetting('group', false);
    assert.equal(totalText(f), 'Loaded lore: Counting…');
    assert.equal(bookTokenLabels(f).get('Working book'), 'Counting…');
    resolve(1234);
    await settleTokens();
    assert.equal(totalText(f), 'Loaded lore: ≈1,234 tokens');
    f.setSetting('order', false);
    await settleTokens();
    assert.equal(f.tokenCalls.length, 1);
    assert.equal(totalText(f), 'Loaded lore: ≈1,234 tokens');
    assert.equal(bookTokenLabels(f).get('Working book'), '≈1,234 tokens');
    const [breakdown] = elementsWithClass(f.panel, 'stwii--token-breakdown');
    assert.ok(breakdown.textContent.includes('Working book'));
    assert.ok(breakdown.textContent.includes('≈1,234 tokens'));
});

test('a late count from an older activation cannot replace the newest panel count', async () => {
    const pending = new Map();
    const f = fixture(true, 'alice', {}, text => new Promise(resolve => pending.set(text, resolve)));
    f.activate([activeEntry('Old', 1, { content: 'old' })]);
    await settleTokens();
    f.activate([activeEntry('New', 1, { content: 'new' })]);
    await settleTokens();
    pending.get('new')(9);
    await settleTokens();
    assert.equal(totalText(f), 'Loaded lore: ≈9 tokens');
    pending.get('old')(99);
    await settleTokens();
    assert.equal(totalText(f), 'Loaded lore: ≈9 tokens');
    assert.deepEqual([...bookTokenLabels(f)], [['New', '≈9 tokens']]);
    assert.deepEqual(f.triggered().map(entry => entry.world), ['New']);
});

test('chat changes, zero-entry scans, and teardown invalidate pending token counts', async () => {
    const clearActions = [
        f => f.eventSource.emit('chat'),
        f => f.log('[WI] Adding 0 entries to prompt'),
        f => f.context.window.STWII.destroy(),
    ];
    for (const clear of clearActions) {
        let resolve;
        const f = fixture(true, 'alice', {}, () => new Promise(done => { resolve = done; }));
        f.activate([activeEntry()]);
        await settleTokens();
        clear(f);
        const afterClear = f.panel.textContent;
        assertEmptyPanel(f);
        resolve(100);
        await settleTokens();
        assert.equal(f.panel.textContent, afterClear);
        assert.deepEqual(f.triggered(), []);
    }
});

test('token counting preserves frozen host data and the existing wi-triggered schema', async () => {
    const f = fixture();
    f.metadata.noteDepth = 2;
    const entry = Object.freeze(activeEntry('Frozen', 1, { key: Object.freeze(['key']), content: 'payload' }));
    const original = JSON.stringify(entry);
    const metadataKeys = Object.keys(f.metadata);
    f.activate(Object.freeze([entry]));
    const beforeCount = f.triggered();
    await settleTokens();
    assert.equal(JSON.stringify(entry), original);
    assert.deepEqual(f.triggered(), beforeCount);
    assert.deepEqual(Object.keys(f.metadata), metadataKeys);
    assert.ok(!Object.keys(f.triggered()[0]).some(key => /token/i.test(key)));
    assert.equal(totalText(f), 'Loaded lore: ≈7 tokens');
});

test('a saved desktop trigger position is visible on the first phone load and after rotation', () => {
    const settings = { worldInfoInfo: { triggerPos: { left: 1100, top: 900 } } };
    const f = fixture(true, 'alice', settings);
    const trigger = f.context.window.STWII.trigger;
    assert.equal(trigger.style.left, '350px');
    assert.equal(trigger.style.top, '812px');
    assert.deepEqual(settings.worldInfoInfo.triggerPos, { left: 350, top: 812 });
    assert.equal(f.saves, 1);
    f.resize(844, 390);
    assert.equal(trigger.style.left, '350px');
    assert.equal(trigger.style.top, '358px');
    assert.equal(f.saves, 2);
    f.resize(844, 390);
    assert.equal(f.saves, 2, 'an unchanged position does not save repeatedly');
});

test('default, valid, and negative saved trigger positions are handled independently', () => {
    const defaults = fixture();
    assert.equal(defaults.context.window.STWII.trigger.style.left, undefined);
    assert.equal(defaults.context.extension_settings.worldInfoInfo?.triggerPos, undefined);
    assert.equal(defaults.saves, 0);
    const valid = fixture(true, 'alice', { worldInfoInfo: { triggerPos: { left: 12, top: 30 } } });
    assert.equal(valid.context.window.STWII.trigger.style.left, '12px');
    assert.equal(valid.context.window.STWII.trigger.style.top, '30px');
    assert.equal(valid.saves, 0);
    const negative = fixture(true, 'alice', { worldInfoInfo: { triggerPos: { left: -15, top: -20 } } });
    assert.equal(negative.context.window.STWII.trigger.style.left, '0px');
    assert.equal(negative.context.window.STWII.trigger.style.top, '0px');
});

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
