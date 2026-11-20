// Tablet map. A button marked [data-map-open] opens it; the element marked [data-map-screen] (the tablet's
// screen) is where it comes from: the screen fades to the map, then the map grows to fill the viewport.
// Shows only what the player needs: their own next steps (one per task), the floor they are on, room
// names that fit, where they last scanned, the emergency button, and O2 / reactor while sabotaged.
//
// Page API: window.TabletMap.open(), .close(), .focusTask(taskId) -> bool, .hasMap(), .hasPin(taskId).
// The page gets a "tabletmap:ready" event once the map has loaded.
import { analyzeFloor } from '/editor/geometry.js';

const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const NS = 'http://www.w3.org/2000/svg';
const OPEN_FADE = 250, OPEN_GROW = 320, CLOSE_SHRINK = 280, CLOSE_FADE = 200;

const S = {
    floors: [], stations: [], me: { tasks: [], lastScan: null }, sabotage: null,
    geo: new Map(),             // floor id -> { faces, bounds, rooms }
    floor: null, view: null,    // view: world rect shown, { x, y, w, h }
    open: false, busy: false, showDone: false, bubble: null, marks: [], loaded: false, pushed: false
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- DOM -------------------------------------------------------------------------------------------
const backdrop = document.createElement('div');
backdrop.className = 'tm-backdrop'; backdrop.hidden = true;
const layer = document.createElement('div');
layer.className = 'tm-layer'; layer.hidden = true;
layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-label', 'Map');
layer.innerHTML = `
  <div class="tm-bar">
    <button class="tm-btn tm-close" aria-label="Close the map"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg></button>
    <div class="tm-floors" role="tablist" aria-label="Floors"></div>
    <span class="tm-title"></span>
    <button class="tm-btn tm-done" aria-pressed="false" title="Show finished tasks">Done</button>
    <button class="tm-btn tm-fit" aria-label="Show the whole floor"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg></button>
  </div>
  <div class="tm-canvas">
    <svg class="tm-svg" preserveAspectRatio="xMidYMid meet" aria-label="Floor plan with your tasks"><g class="tm-rooms"></g><g class="tm-walls"></g><g class="tm-labels"></g><g class="tm-marks"></g></svg>
    <div class="tm-bubble" hidden></div>
    <div class="tm-empty" hidden></div>
  </div>`;
document.body.append(backdrop, layer);
const $ = sel => layer.querySelector(sel);
const svg = $('.tm-svg'), canvas = $('.tm-canvas'), bubbleEl = $('.tm-bubble');

// ---- data ------------------------------------------------------------------------------------------
function boundsOf(lines) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of lines) for (const p of [l.a, l.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return x0 === Infinity ? [0, 0, 1000, 700] : [x0, y0, x1, y1];
}
function setData(d) {
    S.floors = d.floors || [];
    S.stations = d.stations || [];
    S.me = d.me || S.me;
    S.sabotage = d.sabotage || null;
    S.geo.clear();
    for (const f of S.floors) {
        const a = analyzeFloor({ lines: f.lines.map((l, i) => ({ id: 'l' + i, ...l })), rooms: f.rooms.map((r, i) => ({ id: 'r' + i, ...r })) });
        S.geo.set(f.id, { faces: a.faces, roomAt: a.roomAt, bounds: boundsOf(f.lines) });
    }
}
// The step the player has to do next in a task, if it's on the map.
const nextStep = t => (t && !t.done && Array.isArray(t.steps) ? t.steps[t.step != null ? t.step : t.steps.findIndex(s => !s.done)] : null);
const nextPins = () => S.me.tasks.map(t => ({ t, s: nextStep(t) })).filter(x => x.s && x.s.pin);
const floorById = id => S.floors.find(f => f.id === id);
const roomNameAt = (floor, at) => { const g = S.geo.get(floor); const r = g && g.roomAt(at); return r ? r.name : ''; };

// ---- view (world rect <-> screen) ------------------------------------------------------------------
// While the map grows into place it is laid out for its final size (S.size), so nothing changes when it lands.
function canvasSize() { return S.size || [canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight - 52]; }
function scale() { const [cw, ch] = canvasSize(); return Math.min(cw / S.view.w, ch / S.view.h); }
function toScreen(p) {
    const [cw, ch] = canvasSize(), s = scale();
    return [(p[0] - S.view.x) * s + (cw - S.view.w * s) / 2, (p[1] - S.view.y) * s + (ch - S.view.h * s) / 2];
}
function toWorld(px, py) {
    const r = canvas.getBoundingClientRect(), [cw, ch] = canvasSize(), s = scale();
    return [(px - r.left - (cw - S.view.w * s) / 2) / s + S.view.x, (py - r.top - (ch - S.view.h * s) / 2) / s + S.view.y];
}
// Fits a world rect into a canvas of size cw x ch, returned as a view of that canvas's shape.
function viewFor(rect, cw, ch, pad = 0.08) {
    const w = Math.max(200, rect[2] - rect[0]), h = Math.max(200, rect[3] - rect[1]);
    const s = Math.min(cw / (w * (1 + pad * 2)), ch / (h * (1 + pad * 2)));
    const vw = cw / s, vh = ch / s, cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
    return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
}
function fullCanvas() { return [window.innerWidth, window.innerHeight - (layer.querySelector('.tm-bar').offsetHeight || 52)]; }
function fitView(size = canvasSize()) { S.view = viewFor(S.geo.get(S.floor).bounds, size[0], size[1]); }
function fitScale(size = canvasSize()) { const v = viewFor(S.geo.get(S.floor).bounds, size[0], size[1]); return Math.min(size[0] / v.w, size[1] / v.h); }
function zoomAt(px, py, factor) {
    const w = toWorld(px, py), s0 = scale(), fs = fitScale();
    const s1 = Math.max(fs * 0.6, Math.min(Math.max(fs * 10, 1.2), s0 * factor));
    const k = s0 / s1;
    S.view = { x: w[0] - (w[0] - S.view.x) * k, y: w[1] - (w[1] - S.view.y) * k, w: S.view.w * k, h: S.view.h * k };
    render();
}
function centerOn(p, zoomTo) {
    const [cw, ch] = canvasSize();
    const s = zoomTo || scale();
    const vw = cw / s, vh = ch / s;
    S.view = { x: p[0] - vw / 2, y: p[1] - vh / 2, w: vw, h: vh };
}

// ---- rendering -------------------------------------------------------------------------------------
const poly = pts => 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z';
function render() {
    if (!S.floor || !S.view) return;
    if (!S.size) lastSize = canvasSize();
    const f = floorById(S.floor), g = S.geo.get(S.floor), s = scale(), px = n => n / s;
    svg.setAttribute('viewBox', `${S.view.x} ${S.view.y} ${S.view.w} ${S.view.h}`);
    const hiRoom = S.bubble && S.bubble.floor === S.floor && S.bubble.at ? g.roomAt(S.bubble.at) : null;
    $('.tm-rooms').innerHTML = g.faces.map(fc => `<path d="${poly(fc.poly)}${fc.holes.map(poly).join('')}" fill="${fc === hiRoom ? 'var(--tm-room-hi)' : 'var(--tm-room)'}" fill-rule="evenodd"/>`).join('');
    $('.tm-walls').innerHTML = f.lines.map(l => l.type === 'door'
        ? `<line x1="${l.a[0]}" y1="${l.a[1]}" x2="${l.b[0]}" y2="${l.b[1]}" stroke="var(--tm-door)" stroke-opacity=".55" stroke-width="${px(2)}" stroke-dasharray="${px(5)} ${px(4)}"/>`
        : `<line x1="${l.a[0]}" y1="${l.a[1]}" x2="${l.b[0]}" y2="${l.b[1]}" stroke="var(--tm-wall)" stroke-width="${px(4)}" stroke-linecap="round"/>`).join('');

    // marks, collected first so room names can stay clear of them
    const marks = [];
    if (S.showDone) for (const t of S.me.tasks) for (const st of t.steps || []) {
        if (st.done && st.pin && st.pin.floor === S.floor) marks.push({ kind: 'done', at: st.pin.at, title: st.name, sub: 'Done', floor: S.floor });
    }
    const ls = S.me.lastScan;
    if (ls && ls.floor === S.floor) marks.push({ kind: 'last', at: ls.at, title: 'Last scanned here', sub: `${ls.name} · ${ago(ls.time)}`, floor: S.floor });
    for (const st of S.stations) {
        if (st.floor !== S.floor) continue;
        const sab = S.sabotage && S.sabotage[st.kind];
        if (st.kind === 'emergency') marks.push({ kind: 'emergency', at: st.at, title: 'Emergency button', sub: roomNameAt(st.floor, st.at), floor: S.floor });
        else if (sab && sab.sabotaged) marks.push({ kind: 'alarm', label: st.kind === 'o2' ? 'O2' : 'REACTOR', at: st.at, title: st.kind === 'o2' ? 'O2 is being sabotaged' : 'Reactor meltdown', sub: `Fix it at ${roomNameAt(st.floor, st.at) || 'the station'}`, floor: S.floor });
    }
    for (const { t, s: st } of nextPins()) {
        if (st.pin.floor !== S.floor) continue;
        const of = t.steps.length > 1 ? ` · step ${t.steps.indexOf(st) + 1} of ${t.steps.length}` : '';
        marks.push({ kind: 'task', id: t.id, at: st.pin.at, title: st.name, sub: (st.location || roomNameAt(S.floor, st.pin.at) || '') + of, floor: S.floor });
    }
    S.marks = marks;

    // room names, only where they fit and don't cover a mark or another name
    const taken = marks.map(m => { const [x, y] = toScreen(m.at); return [x - 14, y - 30, 28, 34]; });
    const hit = b => taken.some(t => b[0] < t[0] + t[2] && b[0] + b[2] > t[0] && b[1] < t[1] + t[3] && b[1] + b[3] > t[1]);
    let labels = '';
    for (const fc of g.faces) {
        if (!fc.name) continue;
        const room = f.rooms.find(r => g.roomAt(r.at) === fc);
        if (!room) continue;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of fc.poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
        const wpx = fc.name.length * 7.2 + 8, hpx = 16;
        if ((x1 - x0) * s < wpx + 6 || (y1 - y0) * s < hpx + 6) continue;
        const [sx, sy] = toScreen(room.at), box = [sx - wpx / 2, sy - hpx / 2, wpx, hpx];
        if (hit(box)) continue;
        taken.push(box);
        labels += `<text x="${room.at[0]}" y="${room.at[1] + px(4)}" text-anchor="middle" font-size="${px(11.5)}" font-weight="700" letter-spacing="${px(0.8)}" fill="var(--tm-dim)">${esc(fc.name.toUpperCase())}</text>`;
    }
    $('.tm-labels').innerHTML = labels;

    // marks
    let out = '';
    for (const m of marks) {
        const [x, y] = m.at, sel = S.bubble && S.bubble.at === m.at;
        if (m.kind === 'task') {
            const r = px(sel ? 13 : 11);
            out += `<g><path d="M${x} ${y} l${-r * 0.75} ${-r * 1.35} a${r} ${r} 0 1 1 ${r * 1.5} 0 Z" fill="var(--tm-task)" stroke="#0b1118" stroke-width="${px(2)}"/><circle cx="${x}" cy="${y - r * 1.95}" r="${r * 0.38}" fill="var(--tm-task-ink)"/></g>`;
        } else if (m.kind === 'done') {
            out += `<g opacity=".8"><circle cx="${x}" cy="${y}" r="${px(8)}" fill="var(--tm-done)"/><path d="M${x - px(3.5)} ${y} l${px(2.5)} ${px(2.5)} l${px(4.5)} ${px(-5)}" fill="none" stroke="#0b1118" stroke-width="${px(2)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
        } else if (m.kind === 'last') {
            out += `<g><circle cx="${x}" cy="${y}" r="${px(13)}" fill="none" stroke="var(--tm-lcd)" stroke-width="${px(1.5)}" stroke-dasharray="${px(3)} ${px(3)}"/><circle cx="${x}" cy="${y}" r="${px(5.5)}" fill="var(--tm-lcd)"/></g>`;
        } else if (m.kind === 'emergency') {
            out += `<g><circle cx="${x}" cy="${y}" r="${px(9)}" fill="#2a0d0d" stroke="var(--tm-alarm)" stroke-width="${px(2)}"/><text x="${x}" y="${y + px(4)}" text-anchor="middle" font-size="${px(12)}" font-weight="900" fill="var(--tm-alarm)">!</text></g>`;
        } else if (m.kind === 'alarm') {
            out += `<g><circle class="tm-pulse" cx="${x}" cy="${y}" r="${px(22)}" fill="var(--tm-alarm)" opacity=".5"/><circle cx="${x}" cy="${y}" r="${px(11)}" fill="var(--tm-alarm)" stroke="#0b1118" stroke-width="${px(2)}"/>`
                + `<text x="${x}" y="${y - px(18)}" text-anchor="middle" font-size="${px(12)}" font-weight="800" fill="var(--tm-alarm)" stroke="#060a0f" stroke-width="${px(3)}" paint-order="stroke">${m.label}</text></g>`;
        }
    }
    $('.tm-marks').innerHTML = out;
    renderBubble();
}
function renderBubble() {
    const b = S.bubble;
    if (!b || b.floor !== S.floor || !S.marks.some(m => m.at === b.at)) { bubbleEl.hidden = true; if (b && b.floor === S.floor) S.bubble = null; return; }
    const [x, y] = toScreen(b.at);
    bubbleEl.innerHTML = `<b>${esc(b.title)}</b>${b.sub ? `<span>${esc(b.sub)}</span>` : ''}`;
    bubbleEl.className = 'tm-bubble' + (b.kind === 'alarm' || b.kind === 'emergency' ? ' alarm' : b.kind === 'last' || b.kind === 'done' ? ' calm' : '');
    bubbleEl.style.left = x + 'px'; bubbleEl.style.top = (y - (b.kind === 'task' ? 18 : 0)) + 'px';
    bubbleEl.hidden = false;
}
function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} h ago`;
}
function renderBar() {
    const counts = new Map();
    for (const { s } of nextPins()) counts.set(s.pin.floor, (counts.get(s.pin.floor) || 0) + 1);
    const many = S.floors.length > 1;
    $('.tm-floors').hidden = !many;
    $('.tm-title').hidden = many;
    $('.tm-title').textContent = many ? '' : (floorById(S.floor) || {}).name || 'Map';
    if (many) $('.tm-floors').innerHTML = S.floors.map(f => `<button class="tm-floor${f.id === S.floor ? ' on' : ''}" role="tab" aria-selected="${f.id === S.floor}" data-floor="${esc(f.id)}">${esc(f.name || 'Floor')}${counts.get(f.id) ? `<span class="n" aria-label="${counts.get(f.id)} tasks">${counts.get(f.id)}</span>` : ''}</button>`).join('');
    $('.tm-done').setAttribute('aria-pressed', S.showDone);
}
function showFloor(id, keepView) {
    S.floor = id;
    S.bubble = null;
    if (!keepView) fitView();
    renderBar(); render();
}

// ---- open / close ----------------------------------------------------------------------------------
const screenEl = () => document.querySelector('[data-map-screen]');
function sourceRect() {
    const el = screenEl();
    const r = el ? el.getBoundingClientRect() : null;
    if (!r || !r.width) return { left: window.innerWidth / 2 - 1, top: window.innerHeight / 2 - 1, width: 2, height: 2, radius: '0px' };
    return { left: r.left, top: r.top, width: r.width, height: r.height, radius: getComputedStyle(el).borderRadius || '10px' };
}
const rectFrames = (from, to) => [
    { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px', borderRadius: from.radius },
    { left: to.left + 'px', top: to.top + 'px', width: to.width + 'px', height: to.height + 'px', borderRadius: to.radius }
];
function placeLayer(r) { Object.assign(layer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: r.radius, right: '', bottom: '' }); }
const full = () => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, radius: '0px' });

async function open(focus) {
    if (!S.loaded || !S.floors.length || S.busy) return false;
    if (S.open) { if (focus) applyFocus(focus); return true; }
    S.busy = true; S.open = true;
    // pick the floor: the focused pin's, else the floor of the next task, else the first
    const first = nextPins()[0];
    S.floor = (focus && focus.floor) || (first && first.s.pin.floor) || S.floor || S.floors[0].id;
    S.bubble = null;
    document.documentElement.style.overflow = 'hidden';
    layer.classList.remove('tm-full');
    backdrop.hidden = false; layer.hidden = false;
    renderBar();
    // lay the map out for its final, full-screen size from the start, so nothing jumps when it lands
    S.size = fullCanvas();
    S.view = viewFor(S.geo.get(S.floor).bounds, ...S.size);
    if (focus) applyFocus(focus, S.size);
    try { history.pushState({ tabletMap: true }, ''); S.pushed = true; } catch (e) { S.pushed = false; }
    const src = sourceRect();
    if (RM) {
        layer.classList.add('tm-full'); backdrop.style.opacity = 1;
    } else {
        placeLayer(src); render();
        await layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_FADE, easing: 'ease-out', fill: 'forwards' }).finished;
        const grow = layer.animate(rectFrames(src, full()), { duration: OPEN_GROW, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
        backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_GROW, easing: 'ease-out', fill: 'forwards' });
        await grow.finished;
        layer.getAnimations().forEach(a => a.cancel());
        layer.classList.add('tm-full');
        layer.style.cssText = '';
        backdrop.style.opacity = 1;
    }
    S.size = null;
    render();
    S.busy = false;
    layer.querySelector('.tm-close').focus({ preventScroll: true });
    return true;
}
async function close(fromHistory) {
    if (!S.open || S.busy) return;
    if (!fromHistory && S.pushed) { S.pushed = false; history.back(); return; }   // popstate comes back here
    S.busy = true;
    S.bubble = null; bubbleEl.hidden = true;
    if (!RM) {
        const dst = sourceRect();
        backdrop.getAnimations().forEach(a => a.cancel());
        layer.classList.remove('tm-full');
        placeLayer(full());
        const shrink = layer.animate(rectFrames(full(), dst), { duration: CLOSE_SHRINK, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_SHRINK, easing: 'ease-in', fill: 'forwards' });
        await shrink.finished;
        await layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_FADE, easing: 'ease-in', fill: 'forwards' }).finished;
        layer.getAnimations().forEach(a => a.cancel());
        backdrop.getAnimations().forEach(a => a.cancel());
    }
    layer.hidden = true; backdrop.hidden = true; backdrop.style.opacity = 0;
    layer.classList.remove('tm-full'); layer.style.cssText = '';
    document.documentElement.style.overflow = '';
    S.open = false; S.busy = false;
    const btn = document.querySelector('[data-map-open]');
    if (btn) btn.focus({ preventScroll: true });
}
window.addEventListener('popstate', () => { if (S.open) { S.pushed = false; close(true); } });

function applyFocus(focus, size) {
    if (focus.floor && focus.floor !== S.floor) { S.floor = focus.floor; renderBar(); }
    const [cw, ch] = size || canvasSize();
    const fs = viewFor(S.geo.get(S.floor).bounds, cw, ch), s = Math.min(cw / fs.w, ch / fs.h);
    const view0 = S.view;
    S.view = fs;
    const zoom = Math.max(s, Math.min(s * 2.2, 0.9));
    S.view = { x: focus.at[0] - cw / zoom / 2, y: focus.at[1] - ch / zoom / 2, w: cw / zoom, h: ch / zoom };
    S.bubble = focus.bubble || null;
    if (!view0) return;
    if (S.open && !S.busy) render();
}

// ---- gestures --------------------------------------------------------------------------------------
const pointers = new Map();
let gesture = null, lastTap = 0;
svg.addEventListener('pointerdown', e => {
    if (S.busy) return;
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), view0: { ...S.view }, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w0: toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
    } else {
        gesture = { kind: 'pan', start: [e.clientX, e.clientY], view0: { ...S.view }, s: scale(), moved: false, t: performance.now() };
    }
});
svg.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (gesture.kind === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), k = gesture.d0 / Math.max(10, d);
        const fs = fitScale(), sNew = Math.max(fs * 0.6, Math.min(Math.max(fs * 10, 1.2), Math.min(canvasSize()[0] / (gesture.view0.w * k), canvasSize()[1] / (gesture.view0.h * k))));
        const [cw, ch] = canvasSize(), vw = cw / sNew, vh = ch / sNew;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r = canvas.getBoundingClientRect();
        S.view = { x: gesture.w0[0] - (mid[0] - r.left) / sNew, y: gesture.w0[1] - (mid[1] - r.top) / sNew, w: vw, h: vh };
        render();
    } else if (gesture.kind === 'pan') {
        const dx = e.clientX - gesture.start[0], dy = e.clientY - gesture.start[1];
        if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
        gesture.moved = true;
        S.view = { ...gesture.view0, x: gesture.view0.x - dx / gesture.s, y: gesture.view0.y - dy / gesture.s };
        render();
    }
});
function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const g = gesture;
    if (pointers.size === 1 && g && g.kind === 'pinch') {   // one finger left: carry on panning from here
        const [p] = [...pointers.values()];
        gesture = { kind: 'pan', start: p, view0: { ...S.view }, s: scale(), moved: true, t: 0 };
        return;
    }
    if (pointers.size) return;
    gesture = null;
    if (!g || g.kind !== 'pan' || g.moved || e.type === 'pointercancel') return;
    // a tap: open a mark's bubble, or close it; a quick second tap zooms in
    const now = performance.now();
    if (now - lastTap < 300) { lastTap = 0; zoomAt(e.clientX, e.clientY, 2); return; }
    lastTap = now;
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = 26;
    for (const m of S.marks) {
        const [x, y] = toScreen(m.at), d = Math.hypot(px - x, py - (y - (m.kind === 'task' ? 14 : 0)));
        if (d < bd) { bd = d; best = m; }
    }
    S.bubble = best ? { ...best } : null;
    render();
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
// Rotating the phone (or resizing the window) keeps the same spot in the middle and the same zoom
// relative to the whole floor, so a fitted map stays fitted.
let lastSize = null;
window.addEventListener('resize', () => {
    if (!S.open || S.busy || !lastSize) return;
    const [ow, oh] = lastSize, oldS = Math.min(ow / S.view.w, oh / S.view.h);
    const c = [S.view.x + S.view.w / 2, S.view.y + S.view.h / 2];
    const rel = oldS / fitScale(lastSize);
    centerOn(c, rel * fitScale());
    render();
});
function centerScreen() { const r = canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }

$('.tm-close').addEventListener('click', () => close(false));
$('.tm-fit').addEventListener('click', () => { S.bubble = null; fitView(); render(); });
$('.tm-done').addEventListener('click', () => { S.showDone = !S.showDone; renderBar(); render(); });
$('.tm-floors').addEventListener('click', e => { const b = e.target.closest('.tm-floor'); if (b) showFloor(b.dataset.floor); });
layer.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (e.key === '+' || e.key === '=') zoomAt(...centerScreen(), 1.3);
    else if (e.key === '-') zoomAt(...centerScreen(), 1 / 1.3);
});

// ---- page API --------------------------------------------------------------------------------------
function focusTask(id) {
    const t = S.me.tasks.find(x => x.id === id), st = nextStep(t);
    if (!st || !st.pin) return false;
    const m = { kind: 'task', id, at: st.pin.at, title: st.name, sub: st.location || roomNameAt(st.pin.floor, st.pin.at), floor: st.pin.floor };
    if (t.steps.length > 1) m.sub += ` · step ${t.steps.indexOf(st) + 1} of ${t.steps.length}`;
    open({ floor: st.pin.floor, at: st.pin.at, bubble: m });
    return true;
}
window.TabletMap = {
    open: () => open(),
    close: () => close(false),
    focusTask,
    hasMap: () => S.loaded && S.floors.length > 0,
    hasPin: id => { const st = nextStep(S.me.tasks.find(x => x.id === id)); return !!(st && st.pin && S.floors.length); }
};

// Map buttons on the page
document.addEventListener('click', e => {
    const b = e.target.closest('[data-map-open]');
    if (b) { e.preventDefault(); open(); }
});

// ---- live updates ----------------------------------------------------------------------------------
function onPlayer(d) {
    if (!d) return;
    S.me = { tasks: Array.isArray(d.tasks) ? d.tasks : [], lastScan: d.lastScan || null };
    if (S.open && !S.busy) { renderBar(); render(); }
}
function onSabotage(d) {
    if (!d || !d.sData) return;
    S.sabotage = d.sData;
    if (S.open && !S.busy) render();
}
if (typeof socket !== 'undefined') {
    socket.on('player_data_request', onPlayer);
    socket.on('sabotage_data_request', onSabotage);
}

// The server refuses the map while comms are sabotaged; it is fetched again once they are back.
let mapBlocked = false;
function loadMap() {
    return fetch('/map/data', { credentials: 'same-origin' })
        .then(r => { mapBlocked = r.status === 503; return r.ok ? r.json() : null; })
        .then(d => {
            if (d) setData(d);
            S.loaded = true;
            const ok = S.floors.length > 0;
            document.querySelectorAll('[data-map-open]').forEach(b => { b.hidden = !ok; });
            document.dispatchEvent(new CustomEvent('tabletmap:ready', { detail: { hasMap: ok } }));
        })
        .catch(() => { S.loaded = true; });
}
loadMap();
if (typeof socket !== 'undefined') {
    socket.on('comms_state', d => {
        if (d && d.down) { if (S.open) close(false); }
        else if (mapBlocked) loadMap();
    });
}
