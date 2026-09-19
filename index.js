import { entryKey, normalizeEntryKey, parseEntryKey, parseDetailsFromLogs, WiLogTracker } from './wi-log-parser.js';
import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';
import { isAdmin, getCurrentUserHandle } from '../../../user.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

const STWII = (window.STWII ||= {});
STWII.MAX_ACTIVATION_EVENTS = STWII.MAX_ACTIVATION_EVENTS ?? 1000;
STWII.MAX_BUILDS = STWII.MAX_BUILDS ?? 5;
STWII.MAX_BUILD_LOGS = STWII.MAX_BUILD_LOGS ?? 2000;

function resetWiTriggerPosition(triggerEl = window.STWII?.trigger) {
    if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
    delete extension_settings.worldInfoInfo.triggerPos;
    // Clear inline overrides -> back to CSS default (bottom-left)
    if (triggerEl) {
        triggerEl.style.left = '';
        triggerEl.style.top = '';
        triggerEl.style.right = '';
        triggerEl.style.bottom = '';
    }
    saveSettingsDebounced();
}
STWII.resetWiTriggerPosition = resetWiTriggerPosition;

function pushBounded(arr, item, max) {
    try {
        arr.push(item);
        if (arr.length > max) arr.splice(0, arr.length - max);
    } catch {}
}
function trimBuilds() {
    try {
        const builds = chat_metadata.stwiiBuilds;
        if (!Array.isArray(builds)) return;
        while (builds.length > STWII.MAX_BUILDS) {
            const removed = builds.shift();
            if (removed && removed.runId != null && Array.isArray(chat_metadata.stwiiActivationEvents)) {
                chat_metadata.stwiiActivationEvents = chat_metadata.stwiiActivationEvents.filter(e => e?.runId !== removed.runId);
            }
        }
    } catch {}
}

const strategy = {
    constant: '🔵',
    normal: '🟢',
    vectorized: '🔗',
};
const getStrategy = (entry)=>{
    if (entry.constant === true) {
        return 'constant';
    } else if (entry.vectorized === true) {
        return 'vectorized';
    } else {
        return 'normal';
    }
};

let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType)=>generationType = genType);

const init = ()=>{
    if (window.STWII?.initialized) return;
    STWII.initialized = true;
    // One-time retention trimming on init
    try {
        if (Array.isArray(chat_metadata.stwiiActivationEvents) && chat_metadata.stwiiActivationEvents.length > STWII.MAX_ACTIVATION_EVENTS) {
            chat_metadata.stwiiActivationEvents.splice(0, chat_metadata.stwiiActivationEvents.length - STWII.MAX_ACTIVATION_EVENTS);
        }
        if (Array.isArray(chat_metadata.stwiiBuilds)) {
            trimBuilds();
        }
    } catch {}
    const trigger = document.createElement('div'); {
        trigger.classList.add('stwii--trigger');
        trigger.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
        trigger.title = 'Active WI\n---\nright click for options';
        trigger.addEventListener('click', ()=>{
            panel.classList.toggle('stwii--isActive');
            requestAnimationFrame(ensurePanelsVisible);
        });
        trigger.addEventListener('contextmenu', (evt)=>{
            evt.preventDefault();
            configPanel.classList.toggle('stwii--isActive');
            requestAnimationFrame(ensurePanelsVisible);
        });
        document.body.append(trigger);
    }
    const panel = document.createElement('div'); {
        panel.classList.add('stwii--panel');
        panel.innerHTML = '?';
        document.body.append(panel);
    }
    const configPanel = document.createElement('div'); {
        configPanel.classList.add('stwii--panel');
        const rowGroup = document.createElement('label'); {
            rowGroup.classList.add('stwii--configRow');
            rowGroup.title = 'Group entries by World Info book';
            const cb = document.createElement('input'); {
                cb.type = 'checkbox';
                cb.checked = extension_settings.worldInfoInfo?.group ?? true;
                cb.addEventListener('click', ()=>{
                    if (!extension_settings.worldInfoInfo) {
                        extension_settings.worldInfoInfo = {};
                    }
                    extension_settings.worldInfoInfo.group = cb.checked;
                    updatePanel(currentEntryList);
                    saveSettingsDebounced();
                });
                rowGroup.append(cb);
            }
            const lbl = document.createElement('div'); {
                lbl.textContent = 'Group by book';
                rowGroup.append(lbl);
            }
            configPanel.append(rowGroup);
        }
        const orderRow = document.createElement('label'); {
            orderRow.classList.add('stwii--configRow');
            orderRow.title = 'Show in insertion depth / order instead of alphabetically';
            const cb = document.createElement('input'); {
                cb.type = 'checkbox';
                cb.checked = extension_settings.worldInfoInfo?.order ?? true;
                cb.addEventListener('click', ()=>{
                    if (!extension_settings.worldInfoInfo) {
                        extension_settings.worldInfoInfo = {};
                    }
                    extension_settings.worldInfoInfo.order = cb.checked;
                    updatePanel(currentEntryList);
                    saveSettingsDebounced();
                });
                orderRow.append(cb);
            }
            const lbl = document.createElement('div'); {
                lbl.textContent = 'Show in order';
                orderRow.append(lbl);
            }
            configPanel.append(orderRow);
        }
        const mesRow = document.createElement('label'); {
            mesRow.classList.add('stwii--configRow');
            mesRow.title = 'Indicate message history (only when ungrouped and shown in order)';
            const cb = document.createElement('input'); {
                cb.type = 'checkbox';
                cb.checked = extension_settings.worldInfoInfo?.mes ?? true;
                cb.addEventListener('click', ()=>{
                    if (!extension_settings.worldInfoInfo) {
                        extension_settings.worldInfoInfo = {};
                    }
                    extension_settings.worldInfoInfo.mes = cb.checked;
                    updatePanel(currentEntryList);
                    saveSettingsDebounced();
                });
                mesRow.append(cb);
            }
            const lbl = document.createElement('div'); {
                lbl.textContent = 'Show messages';
                mesRow.append(lbl);
            }
            configPanel.append(mesRow);
        }
        // Drag-to-move toggle
        const dragRow = document.createElement('label'); {
            dragRow.classList.add('stwii--configRow');
            dragRow.title = 'Allow dragging the book icon to reposition it';
            const cb = document.createElement('input'); {
                cb.type = 'checkbox';
                cb.checked = extension_settings.worldInfoInfo?.drag ?? false;
                cb.addEventListener('click', ()=>{
                    if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
                    const wasEnabled = !!extension_settings.worldInfoInfo.drag;
                    extension_settings.worldInfoInfo.drag = cb.checked;

                    // If enabling for the first time and no saved position, convert current visual spot
                    const hasSaved = !!extension_settings.worldInfoInfo.triggerPos;
                    if (cb.checked && !wasEnabled && !hasSaved) {
                        materializeDefaultPosition();
                    }
                    saveSettingsDebounced();
                });
                dragRow.append(cb);
            }
            const lbl = document.createElement('div'); {
                lbl.textContent = 'Enable drag to move';
                dragRow.append(lbl);
            }
            configPanel.append(dragRow);
        }
        // Reset position row
        const resetRow = document.createElement('div'); {
            resetRow.classList.add('stwii--configRow');
            resetRow.title = 'Reset the book icon position to default';
            resetRow.style.userSelect = 'none';
            const resetLbl = document.createElement('div'); {
                resetLbl.textContent = 'Reset position';
                resetRow.append(resetLbl);
            }
            resetRow.addEventListener('click', ()=>{
                resetWiTriggerPosition(trigger);
            });
            configPanel.append(resetRow);
        }
        document.body.append(configPanel);
        STWII.trigger = trigger; STWII.panel = panel; STWII.configPanel = configPanel;
    }

    // Apply saved position if present
    {
        const savedPos = extension_settings.worldInfoInfo?.triggerPos;
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            trigger.style.left = savedPos.left + 'px';
            trigger.style.top = savedPos.top + 'px';
            trigger.style.right = 'auto';
            trigger.style.bottom = 'auto';
        }
    }

    // Drag-to-move handlers and helpers
    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    // Feature-detect CSS Anchor Positioning
    function supportsAnchors() {
        return CSS.supports?.('position-anchor: --x') && CSS.supports?.('anchor-name: --x');
    }

    // Measure and place a panel near the trigger, clamped to viewport
    function placePanelNearTrigger(panelEl, triggerEl, gap = 0) {
        if (!panelEl || !triggerEl) return;

        // Temporarily show to measure when hidden
        const wasHidden = getComputedStyle(panelEl).display === 'none';
        if (wasHidden) {
            panelEl.style.visibility = 'hidden';
            panelEl.style.display = 'flex';
        }

        // Use fixed positioning for robust viewport math
        panelEl.style.position = 'fixed';

        const tr = triggerEl.getBoundingClientRect();
        const pw = panelEl.offsetWidth || 300;
        const ph = panelEl.offsetHeight || 200;

        // Prefer right side, flip to left if overflowing
        let left = tr.right + gap;
        if (left + pw > window.innerWidth - 4) {
            left = tr.left - pw - gap;
        }
        left = clamp(left, 4, Math.max(4, window.innerWidth - pw - 4));

        // Align top with trigger, clamp vertically
        let top = clamp(tr.top, 4, Math.max(4, window.innerHeight - ph - 4));

        // Apply placement
        panelEl.style.left = left + 'px';
        panelEl.style.top = top + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';

        if (wasHidden) {
            panelEl.style.visibility = '';
            panelEl.style.display = ''; // back to CSS control (.stwii--isActive)
        }
    }

    // Ensure visible placement for panels when toggled/dragged/resized
    function ensurePanelsVisible() {
        const isActive = (el) => !!el && el.classList.contains('stwii--isActive');
        const isOffscreen = (r) => (r.left < 0) || (r.right > window.innerWidth) || (r.top < 0) || (r.bottom > window.innerHeight);
        const rectDistancePx = (a, b) => {
            const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
            const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
            return Math.hypot(dx, dy);
        };

        // Some browsers may pass CSS.supports() but still fail to anchor; treat "far from trigger" as failure.
        const anchorSupported = supportsAnchors();
        const tr = trigger.getBoundingClientRect();
        const maxAnchorDistancePx = 96;

        const ensure = (el) => {
            if (!isActive(el)) return;
            const r = el.getBoundingClientRect();
            const farFromTrigger = rectDistancePx(r, tr) > maxAnchorDistancePx;
            if (isOffscreen(r) || (!anchorSupported) || farFromTrigger) {
                // If we need JS placement, disable any anchor positioning that might be partially applied.
                if (anchorSupported) {
                    el.style.setProperty('position-anchor', 'none');
                    el.style.setProperty('position-area', 'auto');
                    el.style.setProperty('position-try-fallbacks', 'none');
                }
                placePanelNearTrigger(el, trigger);
            }
        };

        ensure(panel);
        ensure(configPanel);
    }

    function materializeDefaultPosition() {
        // Convert current visual placement (bottom/left CSS) to top/left pixels
        const rect = trigger.getBoundingClientRect();
        const left = rect.left;
        const top = rect.top;
        trigger.style.left = left + 'px';
        trigger.style.top = top + 'px';
        trigger.style.right = 'auto';
        trigger.style.bottom = 'auto';
        if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
        extension_settings.worldInfoInfo.triggerPos = { left, top };
    }

    let dragging = false;
    let dragStartX = 0, dragStartY = 0;
    let baseLeft = 0, baseTop = 0;
    let movedEnough = false;
    let suppressNextClick = false;

    function onPointerDown(e) {
        if (!(extension_settings.worldInfoInfo?.drag)) return; // dragging disabled
        if (e.button !== 0 && e.pointerType !== 'touch') return; // left mouse or touch
        dragging = true;
        movedEnough = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        // compute current position
        const rect = trigger.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;

        trigger.style.touchAction = 'none';
        trigger.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!dragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!movedEnough && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) movedEnough = true;

        const newLeft = clamp(baseLeft + dx, 0, window.innerWidth - trigger.offsetWidth);
        const newTop = clamp(baseTop + dy, 0, window.innerHeight - trigger.offsetHeight);

        // switch to top/left based positioning
        trigger.style.left = newLeft + 'px';
        trigger.style.top = newTop + 'px';
        trigger.style.right = 'auto';
        trigger.style.bottom = 'auto';
    }

    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        trigger.releasePointerCapture?.(e.pointerId);
        trigger.style.touchAction = '';

        // persist if moved
        if (movedEnough) {
            const rect = trigger.getBoundingClientRect();
            if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
            extension_settings.worldInfoInfo.triggerPos = { left: rect.left, top: rect.top };
            saveSettingsDebounced();
            suppressNextClick = true;
            setTimeout(() => suppressNextClick = false, 250);
        }

        // Re-place open panels after drag
        requestAnimationFrame(ensurePanelsVisible);
    }

    trigger.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    // Prevent click toggle if a drag just occurred (capture phase)
    trigger.addEventListener('click', (e) => {
        if (suppressNextClick) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);

    // Ensure the saved position stays visible on resize
    window.addEventListener('resize', () => {
        const pos = extension_settings.worldInfoInfo?.triggerPos;
        if (pos) {
            const clampedLeft = clamp(pos.left, 0, window.innerWidth - trigger.offsetWidth);
            const clampedTop = clamp(pos.top, 0, window.innerHeight - trigger.offsetHeight);
            if (clampedLeft !== pos.left || clampedTop !== pos.top) {
                pos.left = clampedLeft;
                pos.top = clampedTop;
                trigger.style.left = clampedLeft + 'px';
                trigger.style.top = clampedTop + 'px';
                saveSettingsDebounced();
            }
        }

        // After trigger potentially moved, place visible panels
        ensurePanelsVisible();
    });

    let entries = [];

    let count = -1;
    const updateBadge = async(newEntries)=>{
        if (count != newEntries.length) {
            if (newEntries.length == 0) {
                trigger.classList.add('stwii--badge-out');
                await delay(510);
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                trigger.classList.remove('stwii--badge-out');
            } else if (count == 0) {
                trigger.classList.add('stwii--badge-in');
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                await delay(510);
                trigger.classList.remove('stwii--badge-in');
            } else {
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                trigger.classList.add('stwii--badge-bounce');
                await delay(1010);
                trigger.classList.remove('stwii--badge-bounce');
            }
            count = newEntries.length;
        } else if (new Set(newEntries).difference(new Set(entries)).size > 0) {
            trigger.classList.add('stwii--badge-bounce');
            await delay(1010);
            trigger.classList.remove('stwii--badge-bounce');
        }
        entries = newEntries;
    };
    let currentEntryList = [];
    let currentChat = [];
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async(entryList)=>{
        panel.innerHTML = 'Updating...';

        // Exclude disabled entries
        const filtered = entryList.filter(e => e?.disable !== true);

        updateBadge(filtered.map(it=>entryKey(it.world, it.uid)));

        for (const entry of filtered) {
            entry.type = 'wi';
            entry.sticky = parseInt(/**@type {string}*/(await SlashCommandParser.commands['wi-get-timed-effect'].callback(
                {
                    effect: 'sticky',
                    format: 'number',
                    file: `${entry.world}`,
                    _scope: null,
                    _abortController: null,
                },
                entry.uid,
            )));
        }

        currentEntryList = [...filtered];

        if (filtered.length === 0) {
            panel.innerHTML = 'No active entries';
            updatePanel(filtered, true);
            return;
        }

        updatePanel(filtered, true);
    });


    const updatePanel = (entryList, newChat = false)=>{
        const isGrouped = extension_settings.worldInfoInfo?.group ?? true;
        const isOrdered = extension_settings.worldInfoInfo?.order ?? true;
        const isMes = extension_settings.worldInfoInfo?.mes ?? true;
        panel.innerHTML = '';
        const adminBypass = isAdmin();

        // Panel-only per-user visibility for Z- lorebooks.
        // - Exempt "9Z Universal Commands" (visible to everyone)
        // - Z-<handle>-* is visible only to matching user (admins see all)
        // - Other 9Z remain hidden for non-admins
        const norm = (s) => (typeof s === 'string' ? s : '').trim();

        // Extract single handle after "Z-", e.g. "Z-alice-..." => "alice"
        // Allows "Z-alice" (no trailing dash) as well.
        const extractZHandle = (world) => {
            const m = norm(world).match(/^Z-([^-\s]+)(?:-|$)/);
            return m ? m[1] : null;
        };

        // Provided by the host app; fallback to empty if unavailable.
        const currentHandle = (typeof getCurrentUserHandle === 'function' ? getCurrentUserHandle() : '')
            .trim();

        const isHiddenWorld = (w)=> {
            const s = norm(w);
            if (s === '9Z Universal Commands') return false; // exemption

            // Per-user visibility for Z- lorebooks:
            const h = extractZHandle(s);
            if (h) {
                // Hide if the embedded handle does not match the current user
                return h !== currentHandle;
            }

            // Keep other 9Z hidden for non-admins
            return s.startsWith('9Z');
        };
        let grouped;
        if (isGrouped) {
            grouped = Object.groupBy(entryList, (it,idx)=>it.world);
        } else {
            grouped = {
                'WI Entries': [...entryList],
            };
        }
        const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];
        for (const [world, entries] of Object.entries(grouped)) {
            for (const e of entries) {
                e.depth = e.position == world_info_position.atDepth ? e.depth : (chat_metadata[metadata_keys.depth] + (e.position == world_info_position.ANTop ? 0.1 : 0));
            }
            const w = document.createElement('div'); {
                w.classList.add('stwii--world');
                w.textContent = world;
                panel.append(w);
                if (!adminBypass && isGrouped && isHiddenWorld(world)) {
                    const placeholder = document.createElement('div'); {
                        placeholder.classList.add('stwii--entry');
                        placeholder.title = '';
                        const strat = document.createElement('div'); {
                            strat.classList.add('stwii--strategy');
                            placeholder.append(strat);
                        }
                        const title = document.createElement('div'); {
                            title.classList.add('stwii--title');
                            title.textContent = '(hidden entries)';
                            placeholder.append(title);
                        }
                        const sticky = document.createElement('div'); {
                            sticky.classList.add('stwii--sticky');
                            sticky.textContent = '';
                            sticky.title = '';
                            placeholder.append(sticky);
                        }
                        panel.append(placeholder);
                    }
                    continue;
                }
                entries.sort((a,b)=>{
                    if (isOrdered) {
                        // order by strategy / depth / order
                        const aDepthPos = depthPos.includes(a.position);
                        const bDepthPos = depthPos.includes(b.position);
                        if (!aDepthPos && !bDepthPos && a.position !== b.position) return a.position - b.position;
                        if (aDepthPos && !bDepthPos) return 1;
                        if (!aDepthPos && bDepthPos) return -1;
                        if (aDepthPos && bDepthPos && (a.depth ?? Number.MAX_SAFE_INTEGER) < (b.depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                        if (aDepthPos && bDepthPos && (a.depth ?? Number.MAX_SAFE_INTEGER) > (b.depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                        if ((a.order ?? Number.MAX_SAFE_INTEGER) > (b.order ?? Number.MAX_SAFE_INTEGER)) return 1;
                        if ((a.order ?? Number.MAX_SAFE_INTEGER) < (b.order ?? Number.MAX_SAFE_INTEGER)) return -1;
                        return (a.comment ?? a.key.join(', ')).toLowerCase().localeCompare((b.comment ?? b.key.join(', ')).toLowerCase());
                    } else {
                        // order alphabetically
                        return (a.comment?.length ? a.comment : a.key.join(', '))
                            .toLowerCase()
                            .localeCompare(b.comment?.length ? b.comment : b.key.join(', '))
                        ;
                    }
                });
                if (!isGrouped && isOrdered && isMes) {
                    const an = chat_metadata[metadata_keys.prompt];
                    const ad = chat_metadata[metadata_keys.depth];
                    if (an?.length) {
                        const idx = entries.findIndex(e=>depthPos.includes(e.position) && e.depth <= ad);
                        entries.splice(idx, 0, {
                            type: 'note',
                            position: world_info_position.ANBottom,
                            depth: ad,
                            text: an,
                        });
                    }
                    if (newChat) {
                        currentChat = [...chat];
                        if (generationType == 'swipe') currentChat.pop();
                    }
                    const segmenter = new Intl.Segmenter('en', { granularity:'sentence' });
                    let currentDepth = currentChat.length - 1;
                    let isDumped = false;
                    for (let i = entries.length - 1; i >= -1; i--) {
                        if (i < 0 && currentDepth < 0) continue;
                        if (isDumped) continue;
                        if ((i < 0 && currentDepth >= 0) || !depthPos.includes(entries[i].position)) {
                            // anything not @D is considered as "before chat"
                            isDumped = true;
                            const depth = -1;
                            const mesList = currentChat.slice(depth + 1, currentDepth + 1);
                            const text = mesList
                                .map(it=>it.mes)
                                .map(it=>it
                                    .replace(/```.+```/gs, '')
                                    .replace(/<[^>]+?>/g, '')
                                    .trim()
                                    ,
                                )
                                .filter(it=>it.length)
                                .join('\n')
                            ;
                            const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                            entries.splice(i + 1, 0, {
                                type: 'mes',
                                count: mesList.length,
                                from: depth + 1,
                                to: currentDepth,
                                first: sentences.at(0),
                                last: sentences.length > 1 ? sentences.at(-1) : null,
                            });
                            currentDepth = -1;
                            continue;
                        }
                        let depth = Math.max(-1, currentChat.length - entries[i].depth - 1);
                        if (depth >= currentDepth) continue;
                        depth = Math.ceil(depth);
                        if (depth == currentDepth) continue;
                        const mesList = currentChat.slice(depth + 1, currentDepth + 1);
                        const text = mesList
                            .map(it=>it.mes)
                            .map(it=>it
                                .replace(/```.+```/gs, '')
                                .replace(/<[^>]+?>/g, '')
                                .trim()
                                ,
                            )
                            .filter(it=>it.length)
                            .join('\n')
                        ;
                        const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                        entries.splice(i + 1, 0, {
                            type: 'mes',
                            count: mesList.length,
                            from: depth + 1,
                            to: currentDepth,
                            first: sentences.at(0),
                            last: sentences.length > 1 ? sentences.at(-1) : null,
                        });
                        currentDepth = depth;
                    }
                }
                let hadHidden = false;
                for (const entry of entries) {
                    if (!adminBypass && !isGrouped && isHiddenWorld(entry.world)) { hadHidden = true; continue; }
                    const e = document.createElement('div'); {
                        e.classList.add('stwii--entry');
                        const wipChar = [world_info_position.before, world_info_position.after];
                        const wipEx = [world_info_position.EMTop, world_info_position.EMBottom];
                        e.title = '';
                        if (entry.type == 'mes') e.classList.add('stwii--messages');
                        if (entry.type == 'note') e.classList.add('stwii--note');
                        const strat = document.createElement('div'); {
                            strat.classList.add('stwii--strategy');
                            if (entry.type == 'wi') {
                                strat.textContent = strategy[getStrategy(entry)];
                            } else if (entry.type == 'mes') {
                                strat.classList.add('fa-solid', 'fa-fw', 'fa-comments');
                                strat.setAttribute('data-stwii--count', entry.count.toString());
                            } else if (entry.type == 'note') {
                                strat.classList.add('fa-solid', 'fa-fw', 'fa-note-sticky');
                            }
                            e.append(strat);
                        }
                        const title = document.createElement('div'); {
                            title.classList.add('stwii--title');
                            if (entry.type == 'wi') {
                                title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                                e.title += `[${entry.world}] ${entry.comment?.length ? entry.comment : entry.key.join(', ')}\n---\n${entry.content}`;
                            } else if (entry.type == 'mes') {
                                const first = document.createElement('div'); {
                                    first.classList.add('stwii--first');
                                    first.textContent = entry.first;
                                    title.append(first);
                                }
                                if (entry.last) {
                                    e.title = `Messages #${entry.from}-${entry.to}\n---\n${entry.first}\n...\n${entry.last}`;
                                    const sep = document.createElement('div'); {
                                        sep.classList.add('stwii--sep');
                                        sep.textContent = '...';
                                        title.append(sep);
                                    }
                                    const last = document.createElement('div'); {
                                        last.classList.add('stwii--last');
                                        last.textContent = entry.last;
                                        title.append(last);
                                    }
                                } else {
                                    e.title = `Message #${entry.from}\n---\n${entry.first}`;
                                }
                            } else if (entry.type == 'note') {
                                title.textContent = 'Author\'s Note';
                                e.title = `Author's Note\n---\n${entry.text}`;
                            }
                            e.append(title);
                        }
                        const sticky = document.createElement('div'); {
                            sticky.classList.add('stwii--sticky');
                            sticky.textContent = entry.sticky ? `📌 ${entry.sticky}` : '';
                            sticky.title = `Sticky for ${entry.sticky} more rounds`;
                            e.append(sticky);
                        }
                        panel.append(e);
                    }
                }
                if (!adminBypass && !isGrouped && hadHidden) {
                    const placeholder = document.createElement('div'); {
                        placeholder.classList.add('stwii--entry');
                        placeholder.title = '';
                        const strat = document.createElement('div'); {
                            strat.classList.add('stwii--strategy');
                            placeholder.append(strat);
                        }
                        const title = document.createElement('div'); {
                            title.classList.add('stwii--title');
                            title.textContent = '(hidden entries)';
                            placeholder.append(title);
                        }
                        const sticky = document.createElement('div'); {
                            sticky.classList.add('stwii--sticky');
                            sticky.textContent = '';
                            sticky.title = '';
                            placeholder.append(sticky);
                        }
                        panel.append(placeholder);
                    }
                }
            }
        }
    };

    // Build session tracking based on engine markers
    let stwiiCurrentBuild = null;
    // Per-run loop counts (for latest non-dry run), and dry-run flag
    let stwiiCurrentLoopCounts = null;
    // Per-run loop entry IDs (exact order for each loop, from engine array dumps)
    let stwiiCurrentLoopEntryIds = null;
    // Per-run loop entry IDs captured incrementally during LOOP START/RESULT using activation commits
    let stwiiCurrentLoopEventIds = null;
    // Currently active loop index (-1 when not within a loop)
    let stwiiActiveLoopIndex = -1;
    let stwiiDryRunActive = false;
function startBuildSession() {
        STWII.currentRunId = Math.max(Date.now(), (STWII.currentRunId ?? 0) + 1);
        stwiiCurrentBuild = { runId: STWII.currentRunId, startedAt: Date.now(), added: [], logs: [] };
    }
function endBuildSession() {
        if (!stwiiCurrentBuild) return;
        if (stwiiDryRunActive) { stwiiCurrentBuild = null; return; }
        if (!Array.isArray(chat_metadata.stwiiBuilds)) chat_metadata.stwiiBuilds = [];
        chat_metadata.stwiiBuilds.push(stwiiCurrentBuild);
        // Enforce retention: last 5 builds; purge global events for dropped builds
        trimBuilds();
        stwiiCurrentBuild = null;
    }

    // Follow-up messages belong only to the current processing entry. Structured
    // commits resolve exact world/UID drafts, including duplicate UIDs across books.
    const logTracker = new WiLogTracker();
    function ensureEventArray() {
        if (!Array.isArray(chat_metadata.stwiiActivationEvents)) chat_metadata.stwiiActivationEvents = [];
    }
    function handleWiDebugArgs(args) {
        const activation = logTracker.observe(args);
        if (!activation || stwiiDryRunActive) return;
        const { entry: entryObj, draft: d } = activation;
        ensureEventArray();
        // Fallback: if AND_ALL but no captured secondaries, include all entry secondaries
        const sec = (d.logic === 'AND_ALL' && (!d.secondary || d.secondary.length === 0) && Array.isArray(entryObj.keysecondary))
            ? [...entryObj.keysecondary]
            : [...(d.secondary || []), ...(d.secondaryNon || [])];

        const ev = {
            ts: Date.now(),
            world: entryObj.world,
            uid: entryObj.uid,
            comment: entryObj.comment ?? '',
            constant: entryObj.constant === true,
            vectorized: entryObj.vectorized === true,
            keys: Array.isArray(entryObj.key) ? [...entryObj.key] : [],
            captureVersion: 2,
            primary: d.primary,
            secondary: sec,
            logic: d.logic,
            reason: (() => {
                if (entryObj.constant === true) return 'constant';
                if (d.logic === 'FORCE_ACTIVATE') return 'force_activate';
                if (typeof d.primary === 'string' && d.primary.length) return 'primary';
                if (['AND_ANY','AND_ALL','NOT_ANY','NOT_ALL'].includes(d.logic)) return 'secondary';
                if (entryObj.vectorized === true) return 'vector';
                if (d.logic === 'PRIO_WINNER') return 'prio_winner';
                return 'other';
            })(),
        };

        ev.runId = (stwiiCurrentBuild && stwiiCurrentBuild.runId) ? stwiiCurrentBuild.runId : (window.STWII?.currentRunId ?? null);
        ensureEventArray();
        pushBounded(chat_metadata.stwiiActivationEvents, ev, STWII.MAX_ACTIVATION_EVENTS);

        // Track per-loop event IDs if inside a loop
        if (Array.isArray(stwiiCurrentLoopEventIds) && stwiiActiveLoopIndex >= 0) {
            while (stwiiCurrentLoopEventIds.length <= stwiiActiveLoopIndex) stwiiCurrentLoopEventIds.push([]);
            stwiiCurrentLoopEventIds[stwiiActiveLoopIndex].push(entryKey(entryObj.world, entryObj.uid));
        }

        // Track in current build session if present
        if (stwiiCurrentBuild) stwiiCurrentBuild.added.push(ev);

    }

    const resetCapture = () => {
        logTracker.reset();
        stwiiCurrentBuild = null;
        stwiiCurrentLoopCounts = null;
        stwiiCurrentLoopEntryIds = null;
        stwiiCurrentLoopEventIds = null;
        stwiiActiveLoopIndex = -1;
        stwiiDryRunActive = false;
        STWII.currentRunId = null;
        currentEntryList = [];
        currentChat = [];
        panel.textContent = 'No active entries';
        updateBadge([]);
    };
    eventSource.on(event_types.CHAT_CHANGED, resetCapture);

    // The host has no entry-keyword event, so observe its WI diagnostics while
    // forwarding every original console call unchanged.
    function captureWiLog(args) {
        const first = typeof args[0] === 'string' ? args[0] : '';
        const asText = args.filter(arg => typeof arg === 'string').join(' ');
        if (!/^\[WI\]/.test(first)) return;
        const isStart = /^\[WI\]\s+--- START WI SCAN/.test(first);
        const isBuilding = /^\[WI\]\s+--- BUILDING PROMPT ---/.test(first);
        const isDone = /^\[WI\]\s+--- DONE(?: \(DRY RUN\))? ---/.test(first);
        if (isStart) {
            stwiiDryRunActive = first.includes('(DRY RUN)');
            stwiiCurrentLoopCounts = [];
            stwiiCurrentLoopEntryIds = [];
            stwiiCurrentLoopEventIds = [];
            stwiiActiveLoopIndex = -1;
            startBuildSession();
        }
        if (isBuilding && !stwiiCurrentBuild) startBuildSession();
        if (stwiiCurrentBuild && asText) pushBounded(stwiiCurrentBuild.logs, asText, STWII.MAX_BUILD_LOGS);

        const loopStart = first.match(/^\[WI\]\s+---\s+LOOP\s+#(\d+)\s+START\s+---/i);
        if (loopStart && Array.isArray(stwiiCurrentLoopEventIds)) {
            const index = Number(loopStart[1]) - 1;
            if (Number.isSafeInteger(index) && index >= 0) {
                while (stwiiCurrentLoopEventIds.length <= index) stwiiCurrentLoopEventIds.push([]);
                while (stwiiCurrentLoopCounts.length <= index) stwiiCurrentLoopCounts.push(0);
                while (stwiiCurrentLoopEntryIds.length <= index) stwiiCurrentLoopEntryIds.push(null);
                stwiiActiveLoopIndex = index;
            }
        }
        handleWiDebugArgs(args);
        if (/^\[WI\]\s+---\s+LOOP\s+#\d+\s+RESULT\s+---/i.test(first)) stwiiActiveLoopIndex = -1;

        const loopResult = first.match(/^\[WI\]\s+Successfully\s+activated\s+(\d+)\s+new\s+entries\s+to\s+prompt/i);
        if (loopResult && !stwiiDryRunActive && Array.isArray(stwiiCurrentLoopCounts)) {
            const count = Number(loopResult[1]);
            const entries = args.find(arg => Array.isArray(arg) && arg.length === count
                && arg.every(entry => entry && typeof entry.world === 'string' && Number.isSafeInteger(entry.uid)));
            const ids = entries ? entries.map(entry => entryKey(entry.world, entry.uid)) : null;
            const index = stwiiCurrentLoopCounts.length - 1;
            if (index < 0) {
                stwiiCurrentLoopCounts.push(count);
                stwiiCurrentLoopEntryIds.push(ids);
            } else {
                stwiiCurrentLoopCounts[index] = count;
                stwiiCurrentLoopEntryIds[index] = ids;
            }
        }
        if (isBuilding && !stwiiDryRunActive && Array.isArray(stwiiCurrentLoopCounts)) {
            chat_metadata.stwiiLastLoopCounts = [...stwiiCurrentLoopCounts];
            // The engine's result array can include budget-excluded entries. Prefer
            // actual commit IDs whenever present, preserving array fallback for old hosts.
            chat_metadata.stwiiLastLoopEntryIds = stwiiCurrentLoopCounts.map((_, index) => {
                const committed = stwiiCurrentLoopEventIds?.[index];
                return Array.isArray(committed) ? [...committed] : stwiiCurrentLoopEntryIds?.[index] ?? null;
            });
        }
        const added = first.match(/^\[WI\]\s+Adding\s+(\d+)\s+entries\s+to\s+prompt\b/i);
        if (added && !stwiiDryRunActive) chat_metadata.stwiiLastAddedCount = Number(added[1]);
        if (isDone) {
            endBuildSession();
            stwiiDryRunActive = false;
        }
        if (/^\[WI\] (?:Found 0 world lore entries\. Sorted by strategy|Adding 0 entries to prompt)/.test(first)) {
            panel.textContent = 'No active entries';
            updateBadge([]);
            currentEntryList = [];
        }
    }
    (function patchConsole() {
        if (STWII.consolePatched) return;
        STWII.origDebug = console.debug;
        STWII.origLog = console.log;
        const wrap = original => function(...args) {
            try { captureWiLog(args); } catch { /* Diagnostics must never interrupt generation. */ }
            return Reflect.apply(original, console, args);
        };
        const debugWrapper = wrap(STWII.origDebug);
        const logWrapper = wrap(STWII.origLog);
        console.debug = debugWrapper;
        console.log = logWrapper;
        STWII.unpatchConsole = () => {
            if (console.debug === debugWrapper) console.debug = STWII.origDebug;
            if (console.log === logWrapper) console.log = STWII.origLog;
            STWII.consolePatched = false;
        };
        STWII.consolePatched = true;
    })();

// Optional teardown to remove UI and unpatch console
window.STWII.destroy = function() {
    eventSource.removeListener(event_types.CHAT_CHANGED, resetCapture);
    resetCapture();
    try { window.STWII.unpatchConsole?.(); } catch {}
    try {
        const t = window.STWII.trigger;
        if (t && t.parentNode) t.parentNode.removeChild(t);
        const p = window.STWII.panel;
        if (p && p.parentNode) p.parentNode.removeChild(p);
        const c = window.STWII.configPanel;
        if (c && c.parentNode) c.parentNode.removeChild(c);
    } catch {}
    window.STWII.initialized = false;
};

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'wi-triggered',
        callback: (args, value)=>{
            return JSON.stringify(currentEntryList);
        },
        returns: 'list of triggered WI entries',
        helpString: 'Get the list of World Info entries triggered on the last generation.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-position-reset',
        callback: () => {
            resetWiTriggerPosition();
            return 'Reset WI icon position.';
        },
        returns: 'resets WI icon position',
        helpString: 'Reset the World Info Info book icon position (same as clicking "Reset position"). Usage: /wi-position-reset',
    }));

    // Generate a keyword frequency report from captured activation events (popup with declared options)
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-report',
        returns: 'opens popup',
        helpString: 'Show keywords that triggered WI entries (most frequent first) in a scrollable popup. Usage: /wi-report',
        callback: async () => {
            // Prefer last complete build session; fallback to the last "Adding N entries" window; final fallback: all activation events
            let events = [];
            const hasBuilds = Array.isArray(chat_metadata.stwiiBuilds) && chat_metadata.stwiiBuilds.length;
            if (hasBuilds && Array.isArray(chat_metadata.stwiiBuilds.at(-1)?.added) && chat_metadata.stwiiBuilds.at(-1).added.length) {
                events = chat_metadata.stwiiBuilds.at(-1).added;
            } else {
                const all = Array.isArray(chat_metadata.stwiiActivationEvents) ? chat_metadata.stwiiActivationEvents : [];
                const n = Number(chat_metadata.stwiiLastAddedCount);
                if (Number.isFinite(n) && n > 0 && all.length >= n) {
                    events = all.slice(-n);
                } else {
                    events = all;
                }
            }

            // Hide events from hidden lorebooks for non-admins (same rules as panel)
            const adminBypass = isAdmin();

            // Panel-only per-user visibility for Z- lorebooks.
            // - Exempt "9Z Universal Commands" (visible to everyone)
            // - Z-<handle>-* is visible only to matching user (admins see all)
            // - Other 9Z remain hidden for non-admins
            const norm = (s) => (typeof s === 'string' ? s : '').trim();

            // Extract single handle after "Z-", e.g. "Z-alice-..." => "alice"
            // Allows "Z-alice" (no trailing dash) as well.
            const extractZHandle = (world) => {
                const m = norm(world).match(/^Z-([^-\s]+)(?:-|$)/);
                return m ? m[1] : null;
            };

            // Provided by the host app; fallback to empty if unavailable.
            const currentHandle = (typeof getCurrentUserHandle === 'function' ? getCurrentUserHandle() : '')
                .trim();

            const isHiddenWorld = (w)=> {
                const s = norm(w);
                if (s === '9Z Universal Commands') return false; // exemption

                // Per-user visibility for Z- lorebooks:
                const h = extractZHandle(s);
                if (h) {
                    // Hide if the embedded handle does not match the current user
                    return h !== currentHandle;
                }

                // Keep other 9Z hidden for non-admins
                return s.startsWith('9Z');
            };

            if (!adminBypass) {
                events = events.filter(ev => !isHiddenWorld(ev.world));
            }

            // Build keyword overrides from build logs (diagnostic parsing per loop)
            const lastBuild = (Array.isArray(chat_metadata.stwiiBuilds) && chat_metadata.stwiiBuilds.length) ? chat_metadata.stwiiBuilds.at(-1) : null;
            const logLines = Array.isArray(lastBuild?.logs) ? lastBuild.logs : [];
            const loopRanges = [];
            if (logLines.length) {
                for (let i = 0; i < logLines.length; i++) {
                    const mStart = (logLines[i] || '').match(/^\[WI\]\s+---\s+LOOP\s+#(\d+)\s+START\s+---/i);
                    if (mStart) {
                        const n = Number(mStart[1]);
                        let j = i + 1;
                        for (; j < logLines.length; j++) {
                            const mEnd = (logLines[j] || '').match(/^\[WI\]\s+---\s+LOOP\s+#(\d+)\s+(?:START|RESULT)\s+---/i);
                            if (mEnd) break;
                        }
                        loopRanges[n - 1] = [i, j];
                    }
                }
            }
            const idsByLoopDiag = Array.isArray(chat_metadata.stwiiLastLoopEntryIds) ? chat_metadata.stwiiLastLoopEntryIds : null;
            const overrideById = new Map();
            for (let i = 0; i < (idsByLoopDiag?.length ?? 0); i++) {
                if (!Array.isArray(idsByLoopDiag[i])) continue;
                const [start, end] = loopRanges[i] ?? [0, logLines.length - 1];
                for (const id of idsByLoopDiag[i]) {
                    const identity = parseEntryKey(id);
                    if (!identity) continue;
                    const details = parseDetailsFromLogs(logLines, identity.uid, identity.world, start, end);
                    if (details) overrideById.set(entryKey(identity.world, identity.uid), details);
                }
            }
            function historicalDetails(ev) {
                // Current structured captures are authoritative. Logs only repair older reports.
                if (ev.captureVersion === 2) return null;
                return overrideById.get(entryKey(ev.world, ev.uid))
                    ?? parseDetailsFromLogs(logLines, ev.uid, ev.world);
            }

            // Build frequency map: keyword -> { count, entries: Set<string> }
            const freq = new Map();
            const sanitizeComment = (s) => typeof s === 'string'
                ? s.replace(/\s*-\s*S[0-9][0-9A-Za-z.\-]*\s*$/, '').trim()
                : '';
            const fmtEntry = (e) => {
                const c = sanitizeComment(e.comment ?? '');
                return `${e.world}:${e.uid}${c ? ` - ${c}` : ''}`;
            };
            const FORCE_ACTIVATED_KEYWORD = '(force activated)';
            const isForceActivatedEvent = (ev, primaryKw = null, secondaryKws = []) => {
                if (!ev || ev.constant === true) return false;
                if (ev.logic === 'FORCE_ACTIVATE' || ev.reason === 'force_activate') return true;
                const hasPrimary = typeof primaryKw === 'string' && primaryKw.length > 0;
                const hasSecondary = Array.isArray(secondaryKws) && secondaryKws.filter(Boolean).length > 0;
                return ev.reason === 'vector' && !hasPrimary && !hasSecondary;
            };

            // Track entries that had explicit keywords and those that were primary-only
            const entriesWithKeywords = new Set();
            const primaryOnlyEntries = new Set();

            if (events.length) {
                for (const ev of events) {
                    const entryIdent = fmtEntry(ev);
                    const ov = historicalDetails(ev);
                    const primaryUse = ov && ov.primary ? ov.primary : (ev.primary || null);
                    const secondaryUse = ov && Array.isArray(ov.secondary) ? ov.secondary : (Array.isArray(ev.secondary) ? ev.secondary : []);
                    const kws = isForceActivatedEvent(ev, primaryUse, secondaryUse)
                        ? [FORCE_ACTIVATED_KEYWORD]
                        : []
                            .concat(primaryUse ? [primaryUse] : [])
                            .concat(secondaryUse);

                    if (kws.length > 0) {
                        entriesWithKeywords.add(entryIdent);
                    } else if (ev.constant !== true) {
                        primaryOnlyEntries.add(entryIdent);
                        // Ensure at least placeholder contributes if somehow missing and not a constant activation
                        kws.push('(no keyword)');
                    }

                    for (const kw of kws) {
                        if (!freq.has(kw)) freq.set(kw, { count: 0, entries: new Set() });
                        const rec = freq.get(kw);
                        rec.count += 1;
                        rec.entries.add(entryIdent);
                    }
                }
            }

            // Remove from "(no keyword)" any entries that also appeared with explicit keywords, and align its count
            if (freq.has('(no keyword)')) {
                const p = freq.get('(no keyword)');
                const filtered = new Set([...p.entries].filter(e => !entriesWithKeywords.has(e)));
                p.entries = filtered;
                p.count = filtered.size;
            }

            const sorted = [...freq.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

            // Build popup content with classes (no inline styles)
            const container = document.createElement('div');
            container.classList.add('stwii-report-container');

            const title = document.createElement('div');
            title.classList.add('stwii-report-title');
            title.textContent = 'World Info Keyword Report';
            container.append(title);

            const summary = document.createElement('div');
            summary.classList.add('stwii-report-summary');
            const addedCount = events.length;
            summary.textContent = events.length
                ? `Entries added to WI: ${addedCount} • Unique keywords: ${sorted.length}`
                : 'No activation events captured yet.';
            container.append(summary);

            // Loop breakdown (from latest non-dry run)
            // Show counts after applying hidden-book filtering
            const loops = Array.isArray(chat_metadata.stwiiLastLoopCounts) ? chat_metadata.stwiiLastLoopCounts : [];
            if (loops.length > 0) {
                const loopDiv = document.createElement('div');
                loopDiv.classList.add('stwii-report-summary');

                const idsByLoop = Array.isArray(chat_metadata.stwiiLastLoopEntryIds) ? chat_metadata.stwiiLastLoopEntryIds : null;
                const validIds = new Set(events.map(ev => entryKey(ev.world, ev.uid)));

                const pieces = loops.map((n, i) => {
                    let shown = Number.isFinite(n) ? n : 0;

                    if (idsByLoop && Array.isArray(idsByLoop[i])) {
                        // Use precise ID mapping when available, then filter by visible events
                        shown = idsByLoop[i].filter(id => validIds.has(normalizeEntryKey(id))).length;
                    } else {
                        // Fallback approximation: slice by original loop sizes but count only visible events in that range
                        const start = loops.slice(0, i).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                        const end = start + (Number.isFinite(n) ? n : 0);
                        shown = events.slice(start, end).length;
                    }

                    return `Loop ${i + 1}: ${shown} entries`;
                });

                loopDiv.textContent = pieces.join(' • ');
                container.append(loopDiv);
            }

            if (events.length && sorted.length) {
                const freqHeader = document.createElement('div');
                freqHeader.classList.add('stwii-report-subtitle');
                freqHeader.textContent = 'Keyword Frequency';
                container.append(freqHeader);

                const table = document.createElement('table');
                table.classList.add('stwii-report-table');

                const thead = document.createElement('thead');
                const headRow = document.createElement('tr');
                for (const label of ['Keyword', 'Hits', 'Entries']) {
                    const th = document.createElement('th');
                    if (label === 'Hits') th.classList.add('stwii-report-table-count');
                    th.textContent = label;
                    headRow.append(th);
                }
                thead.append(headRow);
                table.append(thead);

                const tbody = document.createElement('tbody');
                for (const [kw, rec] of sorted) {
                    const row = document.createElement('tr');

                    const keywordCell = document.createElement('td');
                    keywordCell.textContent = kw;
                    row.append(keywordCell);

                    const hitsCell = document.createElement('td');
                    hitsCell.classList.add('stwii-report-table-count');
                    hitsCell.textContent = String(rec.count);
                    row.append(hitsCell);

                    const entriesCell = document.createElement('td');
                    const entries = [...rec.entries].sort((a, b) => a.localeCompare(b));
                    const details = document.createElement('details');
                    details.classList.add('stwii-report-drawer');

                    const detailsSummary = document.createElement('summary');
                    detailsSummary.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
                    details.append(detailsSummary);

                    const entryList = document.createElement('ul');
                    for (const entry of entries) {
                        const li = document.createElement('li');
                        li.textContent = entry;
                        entryList.append(li);
                    }
                    details.append(entryList);
                    entriesCell.append(details);
                    row.append(entriesCell);

                    tbody.append(row);
                }
                table.append(tbody);
                container.append(table);
            }

            // Per-loop sections (list entries by loop using last non-dry-run loop counts)
            (function renderLoops() {
                const loops = Array.isArray(chat_metadata.stwiiLastLoopCounts) ? chat_metadata.stwiiLastLoopCounts : [];
                if (!Array.isArray(loops) || loops.length === 0) return;

                const total = loops.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                if (!Number.isFinite(total) || total <= 0) return;

                let offset = 0;
                for (let i = 0; i < loops.length; i++) {
                    const cnt = Number(loops[i]);
                    if (!Number.isFinite(cnt) || cnt <= 0) continue;

                    const header = document.createElement('div');
                    header.classList.add('stwii-report-subtitle');
                    header.textContent = `Loop ${i + 1}`;
                    container.append(header);

                    let list = [];
                    const idsByLoop = Array.isArray(chat_metadata.stwiiLastLoopEntryIds) ? chat_metadata.stwiiLastLoopEntryIds : null;
                    if (idsByLoop && Array.isArray(idsByLoop[i])) {
                        const byId = new Map(events.map(ev => [entryKey(ev.world, ev.uid), ev]));
                        list = idsByLoop[i].map(id => byId.get(normalizeEntryKey(id))).filter(Boolean);
                    } else {
                        const start = offset;
                        const end = Math.min(events.length, start + (Number.isFinite(cnt) ? cnt : 0));
                        list = start < end ? events.slice(start, end) : [];
                    }

                    const ul = document.createElement('ul');
                    for (const ev of list) {
                        const li = document.createElement('li');
                        li.textContent = fmtEntry(ev);

                        // Highlight constants
                        if (ev && ev.constant === true) {
                            li.style.color = 'var(--SmartThemeEmColor)';
                        }

                        // Append matched keywords inline with operation between primary and secondary
                        // Skip keyword suffix for constant entries
                        if (!(ev && ev.constant === true)) {
                            // Examples:
                            //  - "king AND ANY rainbow"
                            //  - "running NOT ANY circle"
                        const ov2 = historicalDetails(ev);
                        const primaryKw = ov2 && ov2.primary ? ov2.primary : (ev && ev.primary ? ev.primary : null);
                        const secRaw = ov2 && Array.isArray(ov2.secondary) ? ov2.secondary.filter(Boolean) : (ev && Array.isArray(ev.secondary) ? ev.secondary.filter(Boolean) : []);
                        const uniqSec = Array.from(new Set(secRaw));
                        const logicMap = {
                            AND_ANY: 'AND ANY',
                            AND_ALL: 'AND ALL',
                            NOT_ANY: 'NOT ANY',
                            NOT_ALL: 'NOT ALL',
                        };
                        const op = ov2 && ov2.logic ? logicMap[ov2.logic] ?? null : (ev && ev.logic ? logicMap[ev.logic] ?? null : null);

                        const prim = primaryKw;
                        // Deduplicate if primary also appears among secondaries (case-insensitive)
                        const uniqSecFiltered = prim ? uniqSec.filter(s => String(s).toLowerCase() !== String(prim).toLowerCase()) : uniqSec;

                        let kwText = '';
                        if (isForceActivatedEvent(ev, primaryKw, secRaw)) {
                            kwText = ` ${FORCE_ACTIVATED_KEYWORD}`;
                        } else if (prim && uniqSecFiltered.length) {
                            // Have primary and secondaries; include op if present, otherwise comma-separate
                            if (op) {
                                kwText = ` (${prim} ${op} ${uniqSecFiltered.join(', ')})`;
                            } else {
                                kwText = ` (${prim}, ${uniqSecFiltered.join(', ')})`;
                            }
                        } else if (prim) {
                            // Primary only
                            kwText = ` (${prim})`;
                        } else if (uniqSecFiltered.length) {
                            // Secondary-only; include op if present
                            if (op) {
                                kwText = ` (${op} ${uniqSecFiltered.join(', ')})`;
                            } else {
                                kwText = ` (${uniqSecFiltered.join(', ')})`;
                            }
                        } else {
                            // No captured primary or secondary keywords
                            kwText = ' (no keyword)';
                        }

                            if (kwText) {
                                const span = document.createElement('span');
                                span.style.color = 'var(--SmartThemeQuoteColor)';
                                span.textContent = kwText;
                                li.append(span);
                            }
                        }

                        ul.append(li);
                    }
                    container.append(ul);

                    // paragraph break between loops
                    const spacer = document.createElement('div');
                    spacer.classList.add('stwii-report-summary');
                    spacer.textContent = '';
                    container.append(spacer);

                    offset += cnt;
                }
            })();

            // Use Popup API with allowVerticalScrolling
            const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
                allowVerticalScrolling: true,
                okButton: 'Close',
                wide: true,
                large: true,
                leftAlign: true,
                animation: 'fast',
            });
            await popup.show();
            return 'Opened WI Report popup.';
        },
    }));
};
init();
