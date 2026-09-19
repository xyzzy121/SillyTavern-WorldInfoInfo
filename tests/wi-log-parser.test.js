import test from 'node:test';
import assert from 'node:assert/strict';
import { entryKey, normalizeEntryKey, parseEntryKey, parseEntryLog, parseDetailsFromLogs, WiLogTracker } from '../wi-log-parser.js';

const unusualNames = [
    "Scholar's notes",
    'The "Glass" Kingdom: Volume [II]',
    '星の書 📚',
    'Cafe\u0301',
    '  leading and trailing  ',
    'two\nlines\tand tabs',
    "a ' processing b ' processing c",
    '?',
    '',
    '§§§',
    'library'.repeat(120),
];
const process = (tracker, entry) => tracker.observe([`[WI] Entry ${entry.uid}`, `from '${entry.world}' processing`, entry]);
const primary = (tracker, uid, keyword) => tracker.observe([`[WI] Entry ${uid}`, 'activated by primary key match', keyword]);
const commit = (tracker, entry) => tracker.observe([`[WI] Entry ${entry.uid} activation successful, adding to prompt`, entry]);

for (const world of unusualNames) {
    test(`exact identity through current split logs: ${JSON.stringify(world).slice(0, 100)}`, () => {
        const tracker = new WiLogTracker();
        const entry = { world, uid: 7 };
        process(tracker, entry);
        primary(tracker, entry.uid, '  keyword 📚  ');
        assert.equal(commit(tracker, entry).draft.primary, '  keyword 📚  ');
        assert.deepEqual(parseEntryLog([`[WI] Entry 7 from '${world}' processing`]).identity, entry);
        assert.deepEqual(parseEntryKey(entryKey(world, 7)), entry);
        assert.deepEqual(parseEntryKey(`${world}:7`), entry);
    });
}

test('structured identity wins over the printed name and UID', () => {
    const entry = { world: "Real ' book\nname", uid: 7 };
    const parsed = parseEntryLog(["[WI] Entry 5", "from 'Printed name' processing", entry]);
    assert.deepEqual(parsed.identity, entry);
});

test('same UID in different books preserves both draft keywords through reverse-order commits', () => {
    const tracker = new WiLogTracker();
    const a = { world: "Book A's", uid: 4 };
    const b = { world: 'Book B:4', uid: 4 };
    process(tracker, a);
    primary(tracker, a.uid, 'apple');
    process(tracker, b);
    primary(tracker, b.uid, 'banana');
    assert.equal(commit(tracker, b).draft.primary, 'banana');
    assert.equal(commit(tracker, a).draft.primary, 'apple');
});

test('unknown name never aliases a real question-mark name or an empty name', () => {
    const tracker = new WiLogTracker();
    primary(tracker, 3, 'unknown');
    assert.notEqual(entryKey(null, 3), entryKey('?', 3));
    assert.notEqual(entryKey(null, 3), entryKey('', 3));
    assert.equal(commit(tracker, { world: '?', uid: 3 }).draft.primary, null);
    assert.equal(commit(tracker, { world: '', uid: 3 }).draft.primary, null);
});

test('a known UID without a current processing header does not borrow an old book', () => {
    const tracker = new WiLogTracker();
    const a = { world: 'A', uid: 1 };
    const b = { world: 'B', uid: 2 };
    process(tracker, a);
    primary(tracker, 1, 'first');
    process(tracker, b);
    primary(tracker, 1, 'unattributed');
    assert.equal(commit(tracker, a).draft.primary, 'first');
});

for (const boundary of ['[WI] --- START WI SCAN ---', '[WI] --- LOOP #2 START ---', '[WI] --- BUILDING PROMPT ---', '[WI] --- DONE ---']) {
    test(`drafts cleared at ${boundary}`, () => {
        const tracker = new WiLogTracker();
        const entry = { world: 'Old book', uid: 1 };
        process(tracker, entry);
        primary(tracker, 1, 'old keyword');
        tracker.observe([boundary]);
        assert.equal(commit(tracker, entry).draft.primary, null);
    });
}

test('explicit reset clears chat state', () => {
    const tracker = new WiLogTracker();
    const entry = { world: 'Same book', uid: 1 };
    process(tracker, entry);
    primary(tracker, 1, 'old chat keyword');
    tracker.reset();
    assert.equal(tracker.active, null);
    assert.equal(tracker.drafts.size, 0);
    assert.equal(commit(tracker, entry).draft.primary, null);
});

test('processing the same entry again resets failed primary and secondary details', () => {
    const tracker = new WiLogTracker();
    const entry = { world: 'Recursive book', uid: 1 };
    process(tracker, entry);
    primary(tracker, 1, 'failed keyword');
    process(tracker, entry);
    assert.equal(commit(tracker, entry).draft.primary, null);
});

test('current split primary and secondary logic capture remains exact', () => {
    const tracker = new WiLogTracker();
    const entry = { world: 'Logic book', uid: 1 };
    process(tracker, entry);
    tracker.observe(['[WI] Entry 1', 'Entry with primary key match', '  key one  ', 'has secondary keywords. Checking with logic logic', ['AND_ANY', 0]]);
    tracker.observe(['[WI] Entry 1', 'activated. (AND ANY) Found match secondary keyword', '  key two  ']);
    assert.deepEqual(commit(tracker, entry).draft, { primary: '  key one  ', secondary: ['  key two  '], secondaryNon: [], logic: 'AND_ANY' });
});

test('NOT ALL retains the nonmatching secondary keyword', () => {
    const tracker = new WiLogTracker();
    const entry = { world: "Logic's book", uid: 1 };
    process(tracker, entry);
    tracker.observe(['[WI] Entry 1', 'activated. (NOT ALL) Found not matching secondary keyword', 'absent']);
    assert.deepEqual(commit(tracker, entry).draft.secondaryNon, ['absent']);
});

test('external activation in a scan retains force-activation reporting', () => {
    const tracker = new WiLogTracker();
    const entry = { world: 'Forced', uid: 1 };
    tracker.observe(['[WI] WORLDINFO_FORCE_ACTIVATE added entry', entry]);
    tracker.observe(['[WI] --- START WI SCAN ---']);
    process(tracker, entry);
    tracker.observe(['[WI] Entry 1', 'externally activated']);
    assert.equal(commit(tracker, entry).draft.logic, 'FORCE_ACTIVATE');
});

test('current keyword capture accepts combined legacy log arguments', () => {
    const tracker = new WiLogTracker();
    const entry = { world: "Old Book's: Volume", uid: 10 };
    tracker.observe([`[WI] Entry 10 from '${entry.world}' processing`]);
    tracker.observe(['[WI] Entry 10 Entry with primary key match primary has secondary keywords. Checking with logic logic (2) [\'AND_ANY\', 0]']);
    tracker.observe(['[WI] Entry 10 activated. (AND ANY) Found match secondary keyword secondary']);
    const { draft } = commit(tracker, entry);
    assert.equal(draft.primary, 'primary');
    assert.equal(draft.logic, 'AND_ANY');
    assert.deepEqual(draft.secondary, ['secondary']);
});

test('report fallback preserves unusual names and finds details beyond six lines', () => {
    const world = "Line one's: [book]\n星";
    const lines = [`[WI] Entry 1 from '${world}' processing`, ...Array(8).fill('[WI] Entry 1 checking condition'), '[WI] Entry 1 activated by primary key match exact'];
    assert.equal(parseDetailsFromLogs(lines, 1, world).primary, 'exact');
    assert.equal(parseDetailsFromLogs(lines, 1, 'another book'), null);
});

for (const next of ["[WI] Entry 1 from 'Another' processing", '[WI] Entry 2 activated by primary key match wrong', '[WI] --- LOOP #1 RESULT ---', '[WI] --- LOOP #2 START ---', '[WI] --- BUILDING PROMPT ---']) {
    test(`report fallback stops at ${next}`, () => {
        const lines = ["[WI] Entry 1 from 'First' processing", '[WI] Entry 1 disabled', next, '[WI] Entry 1 activated by primary key match wrong'];
        assert.equal(parseDetailsFromLogs(lines, 1, 'First'), null);
    });
}

test('report fallback respects loop range and latest matching processing pass', () => {
    const lines = ["[WI] Entry 1 from 'Book' processing", '[WI] Entry 1 activated by primary key match first', '[WI] --- LOOP #1 RESULT ---', "[WI] Entry 1 from 'Book' processing", '[WI] Entry 1 activated by primary key match second'];
    assert.equal(parseDetailsFromLogs(lines, 1, 'Book', 0, 2).primary, 'first');
    assert.equal(parseDetailsFromLogs(lines, 1, 'Book').primary, 'second');
});

test('legacy ID normalization preserves colons and whitespace', () => {
    assert.equal(normalizeEntryKey('  Book:Part:7'), entryKey('  Book:Part', 7));
    assert.equal(normalizeEntryKey(entryKey('  Book:Part', 7)), entryKey('  Book:Part', 7));
    for (const key of ['bad', 'Book:NaN', 'Book:-1', 'Book:', 'Book:1.5']) assert.equal(normalizeEntryKey(key), null);
});

test('processing name contents cannot be interpreted as keywords or scan markers', () => {
    const tracker = new WiLogTracker();
    const entry = { world: 'Title [WI] --- START WI SCAN --- activated by primary key match fiction', uid: 1 };
    process(tracker, entry);
    assert.equal(commit(tracker, entry).draft.primary, null);
});
