/** Exact lorebook identities and log parsing shared by live capture and old reports. */
const entryPrefix = /^\[WI\]\s+Entry\s+(\d+)(?=\s|$)/;
const boundaryPattern = /^\[WI\]\s+---\s+(?:START WI SCAN|LOOP\s+#\d+\s+(?:START|RESULT)|BUILDING PROMPT|DONE)/i;

function validUid(uid) {
    return (typeof uid === 'number' || (typeof uid === 'string' && /^\d+$/.test(uid)))
        && Number.isSafeInteger(Number(uid)) && Number(uid) >= 0;
}

export function entryKey(world, uid) {
    return JSON.stringify([typeof world === 'string' ? world : null, Number(uid)]);
}

/** Accept the former World:UID report IDs as well as new JSON tuple IDs. */
export function parseEntryKey(key) {
    if (typeof key !== 'string') return null;
    try {
        const value = JSON.parse(key);
        if (Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || value[0] === null) && validUid(value[1])) {
            return { world: value[0], uid: Number(value[1]) };
        }
    } catch { /* Historical IDs are not JSON. */ }
    const separator = key.lastIndexOf(':');
    if (separator < 0 || !validUid(key.slice(separator + 1))) return null;
    return { world: key.slice(0, separator), uid: Number(key.slice(separator + 1)) };
}

export function normalizeEntryKey(key) {
    const identity = parseEntryKey(key);
    return identity ? entryKey(identity.world, identity.uid) : null;
}

export function logText(args) {
    return args.filter(arg => typeof arg === 'string').join(' ');
}

export function parseEntryLog(args) {
    const text = logText(args);
    const prefix = text.match(entryPrefix);
    const entry = args.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg)
        && typeof arg.world === 'string' && validUid(arg.uid));
    // Greedy matching ends at the closing delimiter, preserving apostrophes and newlines.
    const processing = text.match(/^\[WI\]\s+Entry\s+(\d+)\s+from '([\s\S]*)' processing(?:\s|$)/);
    const identity = entry ? { world: entry.world, uid: Number(entry.uid) }
        : processing ? { world: processing[2], uid: Number(processing[1]) }
            : prefix ? { world: null, uid: Number(prefix[1]) } : null;
    return { text, identity, entry, processing: Boolean(processing), boundary: boundaryPattern.test(text) };
}

function emptyDraft() {
    return { primary: null, secondary: [], secondaryNon: [], logic: null };
}

export function captureDetails(draft, args) {
    const text = logText(args).replace(entryPrefix, '').trimStart();
    const message = args[1];
    const value = args[2];
    // Split arguments preserve keyword whitespace and punctuation exactly.
    if (message === 'activated by primary key match' || message === 'Entry with primary key match') {
        if (typeof value === 'string') draft.primary = value;
    } else {
        const match = text.match(/^activated by primary key match\s+([\s\S]+)/i)
            || text.match(/^Entry with primary key match\s+([\s\S]+?)\s+has secondary keywords/i);
        if (match) draft.primary = match[1].trim();
    }
    const logicArray = args.find(arg => Array.isArray(arg) && /^(AND_ANY|AND_ALL|NOT_ANY|NOT_ALL)$/.test(arg[0]));
    const logicText = text.match(/Checking with logic\s+logic(?:\s*\(\d+\))?\s*\[['"]?(AND_ANY|AND_ALL|NOT_ANY|NOT_ALL)/i);
    if (logicArray || logicText) draft.logic = logicArray?.[0] ?? logicText[1];
    const secondary = text.match(/^activated\.\s+\((AND ANY|AND ALL|NOT ANY|NOT ALL)\)/i);
    if (secondary) {
        draft.logic = secondary[1].toUpperCase().replace(/ /g, '_');
        if (draft.logic === 'AND_ANY' || draft.logic === 'NOT_ALL') {
            const match = text.match(/Found (?:match|not matching) secondary keyword\s+([\s\S]+)/i);
            const keyword = typeof message === 'string' && message.startsWith('activated.') && typeof value === 'string'
                ? value : match?.[1]?.trim();
            const target = draft.logic === 'NOT_ALL' ? draft.secondaryNon : draft.secondary;
            if (typeof keyword === 'string' && !target.includes(keyword)) target.push(keyword);
        }
    }
    if (/^activated as prio winner/i.test(text)) draft.logic ??= 'PRIO_WINNER';
    if (/^activated because of constant/i.test(text)) draft.logic = 'CONSTANT';
    if (/^externally activated/i.test(text)) draft.logic = 'FORCE_ACTIVATE';
    return draft;
}

export class WiLogTracker {
    drafts = new Map();
    active = null;

    reset() {
        this.drafts.clear();
        this.active = null;
    }

    observe(args) {
        const record = parseEntryLog(args);
        if (record.boundary) {
            this.active = null;
            if (/START WI SCAN|LOOP\s+#\d+\s+START|BUILDING PROMPT|DONE/i.test(record.text)) this.drafts.clear();
            return null;
        }
        if (!record.identity || !/^\[WI\]/.test(record.text)) return null;
        let { world, uid } = record.identity;
        if (record.processing) {
            this.active = record.identity;
            // A new processing pass must not inherit failed matches from an earlier pass.
            this.drafts.set(entryKey(world, uid), emptyDraft());
            return null;
        }
        if (world === null && this.active?.uid === uid) world = this.active.world;
        const key = entryKey(world, uid);
        if (!this.drafts.has(key)) this.drafts.set(key, emptyDraft());
        const draft = this.drafts.get(key);
        if (/^\[WI\]\s+WORLDINFO_FORCE_ACTIVATE\s+added entry/i.test(record.text)) {
            Object.assign(draft, emptyDraft(), { logic: 'FORCE_ACTIVATE' });
            return null;
        }
        if (/^\[WI\]\s+Entry\s+\d+\s+activation successful, adding to prompt/.test(record.text) && record.entry) {
            this.drafts.delete(key);
            return { entry: record.entry, draft };
        }
        captureDetails(draft, args);
        return null;
    }
}

/** Read only the matching entry's contiguous processing block, never its neighbour's. */
export function parseDetailsFromLogs(lines, uid, world, start = 0, end = lines?.length - 1) {
    if (!Array.isArray(lines) || !validUid(uid) || typeof world !== 'string') return null;
    const wanted = entryKey(world, uid);
    let index = -1;
    for (let i = Math.max(0, start); i <= Math.min(end, lines.length - 1); i++) {
        const record = parseEntryLog([typeof lines[i] === 'string' ? lines[i] : '']);
        if (record.processing && record.identity && entryKey(record.identity.world, record.identity.uid) === wanted) index = i;
    }
    if (index < 0) return null;
    const draft = emptyDraft();
    for (let i = index + 1; i <= Math.min(end, lines.length - 1); i++) {
        const line = typeof lines[i] === 'string' ? lines[i] : '';
        const record = parseEntryLog([line]);
        if (record.boundary || record.processing || (record.identity && record.identity.uid !== Number(uid))) break;
        if (record.identity) captureDetails(draft, [line]);
    }
    if (!draft.primary && !draft.logic && !draft.secondary.length && !draft.secondaryNon.length) return null;
    return { primary: draft.primary, logic: draft.logic, secondary: [...draft.secondary, ...draft.secondaryNon] };
}
