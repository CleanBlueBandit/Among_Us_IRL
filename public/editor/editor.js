// Floor plan editor. Draw walls and doors per floor, name the rooms they enclose, and place every task's
// QR codes in rooms. The rules live in geometry.js, shared with the server, which checks them again on save.
import { analyzeFloor, validatePlan, project, same, dist, onInterior, EPS } from './geometry.js';

const $ = id => document.getElementById(id);
const GRID = 25;          // cm
const HIT = 9;            // px: how close a click must be to a line or point
const SNAP = 12;          // px: how close the cursor must be to snap to a line or point
const MAX_HISTORY = 300;

// ---- state -----------------------------------------------------------------------------------------
let units = [];                       // tasks from the server: [{ id, name, problem, parts: [{ code, task, name }] }]
let doc = { version: 1, floors: [] };
let fi = 0;                           // index of the floor being edited
let sel = new Set();                  // selected ids on this floor
let tool = 'select';
let snapGrid = true;
const views = new Map();              // floor id -> { k, tx, ty }
let view = { k: 0.35, tx: 60, ty: 60 }; // screen = world * k + t
let analysis = { problems: [], faces: [], roomAt: () => null };
let check = { problems: [], placements: new Map() };
const undoStack = [], redoStack = [];
let savedState = '';
let clipboard = null, pasteN = 0;
let gameRunning = false;
let refAdjust = false;
let spaceDown = false;
let drawing = null;                   // { type, start, armed, down: [x, y], count }
let drag = null;                      // current pointer gesture
let cursor = null;                    // last world position under the pointer
let snapShown = null;                 // { p, kind } shown while drawing / dragging a corner
let saving = false;
let hoverPin = null;
let erasePreview = null;              // the piece the eraser would remove                  // pin under the pointer: its label is always shown

const floor = () => doc.floors[fi];
const uid = p => p + Math.random().toString(36).slice(2, 10);
const snapshot = () => JSON.stringify({ doc, fi });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = cm => (cm / 100).toFixed(2) + ' m';
const partName = code => { for (const u of units) for (const p of u.parts) if (p.code === code) return p.name; return code; };

function emptyFloor(n) { return { id: uid('f'), name: n === 1 ? 'Ground floor' : `Floor ${n}`, reference: null, lines: [], rooms: [], pins: [] }; }
function normalise(plan) {
    const d = plan && Array.isArray(plan.floors) ? plan : { version: 1, floors: [] };
    if (!d.floors.length) d.floors.push(emptyFloor(1));
    for (const f of d.floors) { f.lines = f.lines || []; f.rooms = f.rooms || []; f.pins = f.pins || []; f.reference = f.reference || null; }
    return { version: 1, floors: d.floors };
}

// ---- history ---------------------------------------------------------------------------------------
function pushUndo(before) {
    undoStack.push(before);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
}
function change(fn) {
    const before = snapshot();
    fn();
    if (snapshot() !== before) pushUndo(before);
    refresh();
}
function restore(state) {
    const s = JSON.parse(state);
    doc = s.doc; fi = Math.min(s.fi, doc.floors.length - 1);
    sel.clear(); drawing = null;
    refresh();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---- items -----------------------------------------------------------------------------------------
function findItem(id, f = floor()) {
    return f.lines.find(x => x.id === id) || f.rooms.find(x => x.id === id) || f.pins.find(x => x.id === id) || null;
}
function kindOf(id, f = floor()) {
    if (f.lines.some(x => x.id === id)) return 'line';
    if (f.rooms.some(x => x.id === id)) return 'room';
    if (f.pins.some(x => x.id === id)) return 'pin';
    return null;
}
const allItems = (f = floor()) => [...f.lines, ...f.rooms, ...f.pins];
function withGroup(id, single) {
    const it = findItem(id);
    if (!it || single || !it.group) return [id];
    return allItems().filter(x => x.group === it.group).map(x => x.id);
}
function selected() {
    const f = floor();
    return { lines: f.lines.filter(l => sel.has(l.id)), rooms: f.rooms.filter(r => sel.has(r.id)), pins: f.pins.filter(p => sel.has(p.id)) };
}
function pruneSelection() { for (const id of [...sel]) if (!findItem(id)) sel.delete(id); }

// ---- view ------------------------------------------------------------------------------------------
const svg = $('cv'), stage = $('stage'), world = $('world');
function toWorld(cx, cy) { const r = svg.getBoundingClientRect(); return [(cx - r.left - view.tx) / view.k, (cy - r.top - view.ty) / view.k]; }
function toScreen(p) { const r = svg.getBoundingClientRect(); return [p[0] * view.k + view.tx + r.left, p[1] * view.k + view.ty + r.top]; }
function applyView(full = true) {
    world.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    renderGrid();
    if (full) render();
    $('stZoom').textContent = Math.round(view.k * 100 / 0.35) + '%';
}
function zoomAt(cx, cy, factor) {
    const w = toWorld(cx, cy), r = svg.getBoundingClientRect();
    view.k = Math.max(0.02, Math.min(6, view.k * factor));
    view.tx = cx - r.left - w[0] * view.k; view.ty = cy - r.top - w[1] * view.k;
    applyView();
}
function bounds(f = floor()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); };
    for (const l of f.lines) { add(l.a); add(l.b); }
    for (const r of f.rooms) add(r.at);
    for (const p of f.pins) add(p.at);
    if (f.reference && f.reference.visible) { add([f.reference.x, f.reference.y]); add([f.reference.x + f.reference.w, f.reference.y + f.reference.h]); }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
}
function fit() {
    const b = bounds() || [0, 0, 2000, 1200];
    const r = svg.getBoundingClientRect();
    const w = Math.max(200, b[2] - b[0]), h = Math.max(200, b[3] - b[1]);
    view.k = Math.max(0.02, Math.min(4, Math.min(r.width / w, r.height / h) * 0.82));
    view.tx = r.width / 2 - (b[0] + b[2]) / 2 * view.k; view.ty = r.height / 2 - (b[1] + b[3]) / 2 * view.k;
    applyView();
}
function centerOn(p) {
    const r = svg.getBoundingClientRect();
    view.tx = r.width / 2 - p[0] * view.k; view.ty = r.height / 2 - p[1] * view.k;
    applyView();
}

// ---- snapping --------------------------------------------------------------------------------------
function nearestEnd(p, lines, r) {
    let best = null, bd = r;
    for (const l of lines) for (const e of [l.a, l.b]) { const d = dist(p, e); if (d < bd) { bd = d; best = e; } }
    return best ? [best[0], best[1]] : null;
}
function nearestLine(p, lines, r) {
    let best = null, bd = r;
    for (const l of lines) { const q = project(p, l.a, l.b); if (q.d < bd) { bd = q.d; best = { point: q.point, line: l }; } }
    return best;
}
// On an axis-aligned line, a grid-aligned point along it.
function gridOnLine(l, p) {
    const r = v => Math.round(v / GRID) * GRID;
    if (Math.abs(l.a[1] - l.b[1]) < 0.01) { const x = r(p[0]); if (x > Math.min(l.a[0], l.b[0]) && x < Math.max(l.a[0], l.b[0])) return [x, l.a[1]]; }
    if (Math.abs(l.a[0] - l.b[0]) < 0.01) { const y = r(p[1]); if (y > Math.min(l.a[1], l.b[1]) && y < Math.max(l.a[1], l.b[1])) return [l.a[0], y]; }
    return null;
}
function snapPoint(w, { from = null, shift = false, alt = false, exclude = new Set() } = {}) {
    const r = SNAP / view.k;
    const lines = floor().lines.filter(l => !exclude.has(l.id));
    if (alt) return { p: w, kind: 'free' };
    if (from && shift) {
        const dx = w[0] - from[0], dy = w[1] - from[1];
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        let len = Math.hypot(dx, dy) * Math.cos(Math.atan2(dy, dx) - ang);
        if (snapGrid) len = Math.round(len / GRID) * GRID;
        const p = [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len].map(v => Math.round(v * 100) / 100);
        const e = nearestEnd(p, lines, r * 0.6);
        if (e) return { p: e, kind: 'end' };
        return { p, kind: 'angle' };
    }
    const e = nearestEnd(w, lines, r);
    if (e) return { p: e, kind: 'end' };
    const l = nearestLine(w, lines, r);
    if (l) {
        let q = l.point;
        if (snapGrid) { const g = gridOnLine(l.line, w); if (g && dist(g, w) < r) q = g; }
        return { p: q, kind: 'line', line: l.line.id };
    }
    if (snapGrid) return { p: [Math.round(w[0] / GRID) * GRID, Math.round(w[1] / GRID) * GRID], kind: 'grid' };
    return { p: w, kind: 'free' };
}

// ---- connections, pieces between junctions, and rotation -------------------------------------------
// Is this end of the line touching another line (its end or anywhere along it)?
function endConnected(l, key, f = floor()) {
    const p = l[key];
    return f.lines.some(m => m !== l && (same(p, m.a) || same(p, m.b) || onInterior(p, m.a, m.b)));
}
// A wall that can swing around its one connected end: { line, pivotKey, freeKey } or null.
function rotatable(l) {
    if (!l || l.type === 'door') return null;
    const ca = endConnected(l, 'a'), cb = endConnected(l, 'b');
    if (ca === cb) return null;
    return { line: l, pivotKey: ca ? 'a' : 'b', freeKey: ca ? 'b' : 'a' };
}
function selectedRotatable() {
    const s = selected();
    return s.lines.length === 1 && !s.rooms.length && !s.pins.length ? rotatable(s.lines[0]) : null;
}
function rotateHandle(r) {
    const P = r.line[r.pivotKey], Q = r.line[r.freeKey], L = dist(P, Q) || 1;
    const off = 26 / view.k;
    return [Q[0] + (Q[0] - P[0]) / L * off, Q[1] + (Q[1] - P[1]) / L * off];
}
// Angle in degrees as the plan shows it: 0 = right, 90 = up.
const angleOf = (P, Q) => (Math.atan2(-(Q[1] - P[1]), Q[0] - P[0]) * 180 / Math.PI + 360) % 360;
// Swings the free end to the angle, keeping the length (r.len, fixed when the rotation starts, so rounding
// can't creep). If the free end lands close to another line's end or on a line, it joins it.
function setAngle(r, deg, snap = true) {
    const P = r.line[r.pivotKey], a = deg * Math.PI / 180;
    if (!r.len) r.len = Math.round(dist(P, r.line[r.freeKey]) * 100) / 100;
    let q = [Math.round((P[0] + Math.cos(a) * r.len) * 100) / 100, Math.round((P[1] - Math.sin(a) * r.len) * 100) / 100];
    if (snap) {
        const others = floor().lines.filter(l => l !== r.line), rad = SNAP / view.k;
        const e = nearestEnd(q, others, rad);
        if (e) q = e;
        else { const l = nearestLine(q, others, rad * 0.5); if (l) q = l.point; }
    }
    r.line[r.freeKey] = q;
}
function rotateBy(deg) {
    const r = selectedRotatable();
    if (!r) { toast('Select one wall that has exactly one end connected to rotate it around that end.'); return; }
    change(() => setAngle(r, angleOf(r.line[r.pivotKey], r.line[r.freeKey]) + deg));
}
// Where along line l other lines meet or cross it (0..1), always including both ends.
function junctions(l, f = floor()) {
    const ts = [0, 1];
    for (const m of f.lines) {
        if (m === l) continue;
        for (const e of [m.a, m.b]) if (onInterior(e, l.a, l.b)) ts.push(project(e, l.a, l.b).t);
        const r = [l.b[0] - l.a[0], l.b[1] - l.a[1]], q = [m.b[0] - m.a[0], m.b[1] - m.a[1]];
        const den = r[0] * q[1] - r[1] * q[0];
        if (Math.abs(den) > 1e-9) {
            const d = [m.a[0] - l.a[0], m.a[1] - l.a[1]];
            const t = (d[0] * q[1] - d[1] * q[0]) / den, u = (d[0] * r[1] - d[1] * r[0]) / den;
            if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
        }
    }
    return [...new Set(ts.map(t => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
}
const lerp = (l, t) => [Math.round((l.a[0] + (l.b[0] - l.a[0]) * t) * 100) / 100, Math.round((l.a[1] + (l.b[1] - l.a[1]) * t) * 100) / 100];
// The piece of a line under w, between the junctions on either side of it.
function pieceAt(w) {
    const f = floor(), t = HIT / view.k;
    let line = null, best = t, at = 0;
    for (const l of f.lines) { const q = project(w, l.a, l.b); if (q.d < best) { best = q.d; line = l; at = q.t; } }
    if (!line) return null;
    const ts = junctions(line);
    let i = 0;
    while (i < ts.length - 2 && ts[i + 1] <= at) i++;
    return { line, t0: ts[i], t1: ts[i + 1], p0: lerp(line, ts[i]), p1: lerp(line, ts[i + 1]) };
}
// Removes the part of line l between t0 and t1, keeping what is left on either side.
function cutLine(f, l, t0, t1) {
    const keep = [];
    if (t0 > 1e-6 && dist(l.a, lerp(l, t0)) > EPS) keep.push({ ...l, a: [...l.a], b: lerp(l, t0) });
    if (t1 < 1 - 1e-6 && dist(lerp(l, t1), l.b) > EPS) keep.push({ ...l, id: keep.length ? uid('l') : l.id, a: lerp(l, t1), b: [...l.b] });
    const i = f.lines.indexOf(l);
    f.lines.splice(i, 1, ...keep);
    return keep;
}
function erasePiece(pc) {
    if (!pc) return false;
    cutLine(floor(), pc.line, pc.t0, pc.t1);
    sel.delete(pc.line.id);
    return true;
}
// A door drawn along a wall replaces that stretch of the wall.
function overwriteWalls(door) {
    const f = floor(), len = dist(door.a, door.b);
    if (len < EPS) return;
    for (const w of [...f.lines]) {
        if (w === door || w.type === 'door') continue;
        const wl = dist(w.a, w.b);
        if (wl < EPS) continue;
        const offLine = p => Math.abs(((p[0] - w.a[0]) * (w.b[1] - w.a[1]) - (p[1] - w.a[1]) * (w.b[0] - w.a[0])) / wl);
        if (offLine(door.a) > EPS || offLine(door.b) > EPS) continue;
        const along = p => ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / (wl * wl);
        const s0 = Math.max(0, Math.min(along(door.a), along(door.b))), s1 = Math.min(1, Math.max(along(door.a), along(door.b)));
        if ((s1 - s0) * wl > EPS) cutLine(f, w, s0, s1);
    }
}

// ---- hit testing -----------------------------------------------------------------------------------
function labelBox(r) { const w = Math.max(60, (r.name || 'Unnamed room').length * 7.4 + 18) / view.k, h = 22 / view.k; return [r.at[0] - w / 2, r.at[1] - h / 2, w, h]; }
function hitTest(w) {
    const f = floor(), t = HIT / view.k;
    if (tool === 'select') { const r = selectedRotatable(); if (r && dist(w, rotateHandle(r)) < 13 / view.k) return { kind: 'rotate', r }; }
    for (let i = f.pins.length - 1; i >= 0; i--) if (dist(w, f.pins[i].at) < 13 / view.k) return { kind: 'pin', id: f.pins[i].id };
    for (let i = f.rooms.length - 1; i >= 0; i--) {
        const b = labelBox(f.rooms[i]);
        if (w[0] >= b[0] && w[0] <= b[0] + b[2] && w[1] >= b[1] && w[1] <= b[1] + b[3]) return { kind: 'room', id: f.rooms[i].id };
    }
    if (tool === 'select') {
        let best = null, bd = t;
        for (const l of f.lines) for (const e of [l.a, l.b]) { const d = dist(w, e); if (d < bd) { bd = d; best = e; } }
        if (best) return { kind: 'end', point: best, w };
    }
    let line = null, ld = t;
    for (const l of f.lines) { const q = project(w, l.a, l.b); if (q.d < ld) { ld = q.d; line = l; } }
    if (line) return { kind: 'line', id: line.id };
    const ref = f.reference;
    if (refAdjust && ref && ref.visible) {
        const hx = ref.x + ref.w, hy = ref.y + ref.h;
        if (dist(w, [hx, hy]) < 14 / view.k) return { kind: 'refScale' };
        if (w[0] >= ref.x && w[0] <= hx && w[1] >= ref.y && w[1] <= hy) return { kind: 'ref' };
    }
    return null;
}

// ---- rendering -------------------------------------------------------------------------------------
function renderGrid() {
    const r = svg.getBoundingClientRect(), k = view.k;
    let step = GRID;
    for (const s of [25, 50, 100, 250, 500, 1000, 2500, 5000]) { step = s; if (s * k >= 9) break; }
    const major = step * 4;
    const x0 = Math.floor((-view.tx / k) / step) * step, x1 = (r.width - view.tx) / k;
    const y0 = Math.floor((-view.ty / k) / step) * step, y1 = (r.height - view.ty) / k;
    let minor = '', maj = '';
    for (let x = x0; x <= x1; x += step) { const X = Math.round(x * k + view.tx) + 0.5; const s = `M${X} 0V${r.height}`; if (Math.round(x / major) * major === Math.round(x)) maj += s; else minor += s; }
    for (let y = y0; y <= y1; y += step) { const Y = Math.round(y * k + view.ty) + 0.5; const s = `M0 ${Y}H${r.width}`; if (Math.round(y / major) * major === Math.round(y)) maj += s; else minor += s; }
    $('gGrid').innerHTML = `<path d="${minor}" stroke="rgba(255,255,255,.035)" stroke-width="1"/><path d="${maj}" stroke="rgba(255,255,255,.075)" stroke-width="1"/>`;
}
function polyPath(poly) { return 'M' + poly.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'; }
function render() {
    const f = floor(), k = view.k, px = n => n / k;
    // reference image
    const ref = f.reference;
    $('gRef').innerHTML = ref && ref.visible
        ? `<image href="/floorplan/ref/${esc(ref.file)}" x="${ref.x}" y="${ref.y}" width="${ref.w}" height="${ref.h}" opacity="${ref.opacity}" preserveAspectRatio="none"/>`
        : '';
    // rooms (enclosed areas)
    const selRoomFaces = new Set([...sel].map(id => { const r = f.rooms.find(x => x.id === id); const fc = r && analysis.roomAt(r.at); return fc && fc.id; }).filter(Boolean));
    $('gFaces').innerHTML = analysis.faces.map(fc => {
        const d = polyPath(fc.poly) + fc.holes.map(polyPath).join('');
        const fill = !fc.name ? 'url(#hatch)' : selRoomFaces.has(fc.id) ? 'var(--room-sel)' : 'var(--room)';
        return `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
    }).join('');
    // lines
    let lines = '';
    for (const l of f.lines) {
        const s = sel.has(l.id), coords = `x1="${l.a[0]}" y1="${l.a[1]}" x2="${l.b[0]}" y2="${l.b[1]}"`;
        if (s) lines += `<line ${coords} stroke="var(--accent)" stroke-opacity=".35" stroke-width="${px(14)}" stroke-linecap="round"/>`;
        if (l.type === 'door') {
            lines += `<line ${coords} stroke="#0d1016" stroke-width="${px(7)}" stroke-linecap="butt"/>`;
            lines += `<line ${coords} stroke="var(--door)" stroke-width="${px(3.5)}" stroke-dasharray="${px(7)} ${px(4)}" stroke-linecap="butt"/>`;
        } else {
            lines += `<line ${coords} stroke="${s ? 'var(--accent)' : 'var(--wall)'}" stroke-width="${px(6)}" stroke-linecap="round"/>`;
        }
    }
    // line ends, shown while drawing or for the selection
    if (tool === 'wall' || tool === 'door' || sel.size) {
        const ends = tool === 'wall' || tool === 'door' ? f.lines : f.lines.filter(l => sel.has(l.id));
        for (const l of ends) for (const e of [l.a, l.b]) lines += `<circle cx="${e[0]}" cy="${e[1]}" r="${px(3.5)}" fill="#0d1016" stroke="${l.type === 'door' ? 'var(--door)' : 'var(--wall)'}" stroke-width="${px(1.5)}"/>`;
    }
    $('gLines').innerHTML = lines;
    // room names
    $('gRooms').innerHTML = f.rooms.map(r => {
        const b = labelBox(r), s = sel.has(r.id), unnamed = !(r.name || '').trim();
        return `<g><rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="${px(11)}" fill="${s ? 'rgba(255,176,46,.22)' : 'rgba(13,16,22,.85)'}" stroke="${s ? 'var(--accent)' : unnamed ? 'var(--bad)' : 'rgba(255,255,255,.18)'}" stroke-width="${px(1.2)}"/>`
            + `<text x="${r.at[0]}" y="${r.at[1] + px(4.5)}" text-anchor="middle" font-size="${px(12.5)}" font-weight="600" fill="${unnamed ? 'var(--bad)' : 'var(--text)'}" font-style="${unnamed ? 'italic' : 'normal'}">${esc(unnamed ? 'Unnamed room' : r.name)}</text></g>`;
    }).join('');
    // task pins; a label is only drawn where it fits (room names first), the rest show on hover or selection
    const known = new Set(units.flatMap(u => u.parts.map(p => p.code)));
    const taken = f.rooms.map(r => labelBox(r));
    const fits = b => !taken.some(t => b[0] < t[0] + t[2] && b[0] + b[2] > t[0] && b[1] < t[1] + t[3] && b[1] + b[3] > t[1]);
    const order = [...f.pins].sort((a, b) => (sel.has(b.id) || b.id === hoverPin) - (sel.has(a.id) || a.id === hoverPin));
    const shown = new Set();
    for (const p of order) {
        const text = known.has(p.code) ? partName(p.code) : `${p.code} (unknown)`;
        const w = (text.length * 6.6 + 8) / k, h = 14 / k, b = [p.at[0] - w / 2, p.at[1] + 13 / k, w, h];
        const forced = sel.has(p.id) || p.id === hoverPin;
        if (forced || fits(b)) { taken.push(b); shown.add(p.id); }
    }
    $('gPins').innerHTML = f.pins.map(p => {
        const s = sel.has(p.id), bad = !known.has(p.code);
        const label = esc(bad ? `${p.code} (unknown)` : partName(p.code));
        return `<g><circle cx="${p.at[0]}" cy="${p.at[1]}" r="${px(s ? 11 : 9)}" fill="${bad ? 'var(--bad)' : 'var(--accent)'}" stroke="${s ? '#fff' : '#1a1205'}" stroke-width="${px(2)}"/>`
            + `<rect x="${p.at[0] - px(4)}" y="${p.at[1] - px(4)}" width="${px(8)}" height="${px(8)}" fill="#1a1205" rx="${px(1)}"/>`
            + (shown.has(p.id) ? `<text x="${p.at[0]}" y="${p.at[1] + px(24)}" text-anchor="middle" font-size="${px(11)}" fill="${bad ? 'var(--bad)' : 'var(--accent)'}" font-weight="700" stroke="#0d1016" stroke-width="${px(3)}" paint-order="stroke">${label}</text>` : '')
            + `<title>${label}</title></g>`;
    }).join('');
    // problems on this floor
    $('gProblems').innerHTML = check.problems.filter(p => p.floor === f.id && p.at).map(p =>
        `<g><circle cx="${p.at[0]}" cy="${p.at[1]}" r="${px(8)}" fill="var(--bad)" stroke="#0d1016" stroke-width="${px(2)}"/><text x="${p.at[0]}" y="${p.at[1] + px(4)}" text-anchor="middle" font-size="${px(11)}" font-weight="800" fill="#fff">!</text><title>${esc(p.message)}</title></g>`).join('');
    renderOverlay();
}
function renderOverlay() {
    const k = view.k, px = n => n / k;
    let o = '';
    const ref = floor().reference;
    if (refAdjust && ref && ref.visible) {
        o += `<rect x="${ref.x}" y="${ref.y}" width="${ref.w}" height="${ref.h}" fill="none" stroke="var(--accent)" stroke-width="${px(1.5)}" stroke-dasharray="${px(6)} ${px(4)}"/>`;
        o += `<rect x="${ref.x + ref.w - px(7)}" y="${ref.y + ref.h - px(7)}" width="${px(14)}" height="${px(14)}" fill="var(--accent)"/>`;
    }
    if (drawing && cursor) {
        const s = snapShown || { p: cursor };
        const col = drawing.type === 'door' ? 'var(--door)' : 'var(--accent)';
        o += `<line x1="${drawing.start[0]}" y1="${drawing.start[1]}" x2="${s.p[0]}" y2="${s.p[1]}" stroke="${col}" stroke-width="${px(drawing.type === 'door' ? 3.5 : 6)}" stroke-linecap="round" ${drawing.type === 'door' ? `stroke-dasharray="${px(7)} ${px(4)}"` : ''} opacity=".8"/>`;
        const mid = [(drawing.start[0] + s.p[0]) / 2, (drawing.start[1] + s.p[1]) / 2];
        o += `<text x="${mid[0]}" y="${mid[1] - px(10)}" text-anchor="middle" font-size="${px(11)}" fill="var(--text)" stroke="#0d1016" stroke-width="${px(3)}" paint-order="stroke">${fmt(dist(drawing.start, s.p))}</text>`;
        o += `<circle cx="${drawing.start[0]}" cy="${drawing.start[1]}" r="${px(4)}" fill="${col}"/>`;
    }
    if (snapShown) {
        const p = snapShown.p;
        if (snapShown.kind === 'end') o += `<circle cx="${p[0]}" cy="${p[1]}" r="${px(7)}" fill="none" stroke="var(--good)" stroke-width="${px(2)}"/>`;
        else if (snapShown.kind === 'line') o += `<rect x="${p[0] - px(5)}" y="${p[1] - px(5)}" width="${px(10)}" height="${px(10)}" fill="none" stroke="var(--good)" stroke-width="${px(2)}" transform="rotate(45 ${p[0]} ${p[1]})"/>`;
        else o += `<path d="M${p[0] - px(5)} ${p[1]}h${px(10)}M${p[0]} ${p[1] - px(5)}v${px(10)}" stroke="var(--dim)" stroke-width="${px(1.5)}"/>`;
    }
    if (drag && drag.mode === 'box' && drag.rect) {
        const [x, y, w, h] = drag.rect;
        // right-to-left selects whatever it touches (dashed green), left-to-right only what is fully inside
        o += drag.crossing
            ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(61,220,132,.07)" stroke="var(--good)" stroke-width="${px(1)}" stroke-dasharray="${px(5)} ${px(4)}"/>`
            : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,176,46,.08)" stroke="var(--accent)" stroke-width="${px(1)}"/>`;
    }
    const rot = tool === 'select' && !drag ? selectedRotatable() : (drag && drag.mode === 'rotate' ? drag.r : null);
    if (rot) {
        const h = rotateHandle(rot), P = rot.line[rot.pivotKey], Q = rot.line[rot.freeKey];
        o += `<line x1="${Q[0]}" y1="${Q[1]}" x2="${h[0]}" y2="${h[1]}" stroke="var(--accent)" stroke-width="${px(1.5)}" stroke-dasharray="${px(3)} ${px(3)}"/>`;
        o += `<circle cx="${P[0]}" cy="${P[1]}" r="${px(5)}" fill="none" stroke="var(--accent)" stroke-width="${px(2)}"/>`;
        o += `<circle cx="${h[0]}" cy="${h[1]}" r="${px(10)}" fill="#1a1205" stroke="var(--accent)" stroke-width="${px(2)}"/>`;
        o += `<path d="M${h[0] - px(4.5)} ${h[1] - px(1)}a${px(4.6)} ${px(4.6)} 0 1 0 ${px(4.5)} ${px(-3.6)}" fill="none" stroke="var(--accent)" stroke-width="${px(1.6)}" stroke-linecap="round"/><path d="M${h[0] + px(0.6)} ${h[1] - px(7.2)}l${px(-0.2)} ${px(3.4)} ${px(-3.2)} ${px(-0.6)}" fill="none" stroke="var(--accent)" stroke-width="${px(1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`;
        if (drag && drag.mode === 'rotate') o += `<text x="${h[0]}" y="${h[1] - px(16)}" text-anchor="middle" font-size="${px(11)}" fill="var(--text)" stroke="#0d1016" stroke-width="${px(3)}" paint-order="stroke">${Math.round(angleOf(P, Q))}°</text>`;
    }
    if (tool === 'erase' && erasePreview) {
        o += `<line x1="${erasePreview.p0[0]}" y1="${erasePreview.p0[1]}" x2="${erasePreview.p1[0]}" y2="${erasePreview.p1[1]}" stroke="var(--bad)" stroke-width="${px(10)}" stroke-linecap="round" opacity=".75"/>`;
    }
    $('gOverlay').innerHTML = o;
}

// ---- panels ----------------------------------------------------------------------------------------
function renderFloors() {
    const box = $('floors');
    const probs = id => check.problems.filter(p => p.floor === id).length;
    box.innerHTML = doc.floors.map((f, i) => `<button class="ftab${i === fi ? ' on' : ''}" role="tab" aria-selected="${i === fi}" data-i="${i}" title="Double-click to rename">${esc(f.name || 'Unnamed floor')}${probs(f.id) ? `<span class="warn">${probs(f.id)}</span>` : ''}</button>`).join('');
}
function renderTasks() {
    const placedAt = new Map();
    doc.floors.forEach(f => f.pins.forEach(p => placedAt.set(p.code, f)));
    let total = 0, placed = 0;
    $('pane-tasks').innerHTML = `<div class="sec"><p class="muted" style="margin:0 0 10px">Drag each task into a room. Tasks you leave off the plan are switched off when you save. A task with several parts needs every part placed.</p></div>` + units.map(u => {
        const n = u.parts.filter(p => placedAt.has(p.code)).length;
        total += u.parts.length; placed += n;
        const badge = n === 0 ? '<span class="badge off">Off</span>' : n === u.parts.length ? '<span class="badge on">On</span>' : `<span class="badge part">${n}/${u.parts.length} placed</span>`;
        const chips = u.parts.map(p => {
            const f = placedAt.get(p.code);
            return `<button class="chip${f ? ' placed' : ''}" data-code="${esc(p.code)}" title="${f ? `On ${esc(f.name)}. Click to find it, drag to move it.` : 'Drag into a room'}"><span class="dot"></span>${esc(p.name)}</button>`;
        }).join('');
        return `<div class="unit"><div class="unit-head"><span class="unit-name">${esc(u.name)}</span>${badge}</div><div class="chips">${chips}</div>${u.problem ? `<div class="note">${esc(u.problem)}</div>` : ''}</div>`;
    }).join('');
    $('taskCount').textContent = `${placed}/${total}`;
}
function renderProblems() {
    const list = check.problems;
    $('probCount').textContent = list.length;
    $('probCount').classList.toggle('bad', list.length > 0);
    const fname = id => { const f = doc.floors.find(x => x.id === id); return f ? f.name || 'Unnamed floor' : 'Whole plan'; };
    $('pane-problems').innerHTML = list.length
        ? list.map((p, i) => `<button class="prob" data-i="${i}"><span class="mark">!</span><span>${esc(p.message)}<small>${esc(fname(p.floor))}</small></span></button>`).join('')
        : '<div class="allgood">No problems. The plan can be saved.</div>';
}
function renderInspector() {
    const f = floor(), s = selected(), n = sel.size, pane = $('pane-inspect');
    if (document.activeElement && pane.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // don't rebuild under the user's typing
    if (!n) {
        const ref = f.reference;
        const walls = f.lines.filter(l => l.type !== 'door').length, doors = f.lines.length - walls;
        pane.innerHTML = `
          <div class="sec"><h3>Floor</h3>
            <div class="field"><label for="fName">Name</label><input type="text" id="fName" maxlength="60" value="${esc(f.name)}"></div>
            <div class="row"><button class="btn" id="fLeft" ${fi === 0 ? 'disabled' : ''}>&larr; Move</button><button class="btn" id="fRight" ${fi === doc.floors.length - 1 ? 'disabled' : ''}>Move &rarr;</button><button class="btn danger" id="fDel" ${doc.floors.length < 2 ? 'disabled' : ''}>Delete floor</button></div>
          </div>
          <div class="sec"><h3>On this floor</h3>
            <div class="kv"><span>Walls</span><b>${walls}</b></div><div class="kv"><span>Doors</span><b>${doors}</b></div>
            <div class="kv"><span>Rooms</span><b>${analysis.faces.length}</b></div><div class="kv"><span>Tasks placed</span><b>${f.pins.length}</b></div>
          </div>
          <div class="sec"><h3>Reference image</h3>
            ${ref ? `
              <div class="field"><label for="rOp">Opacity</label><input type="range" id="rOp" min="0.05" max="1" step="0.05" value="${ref.opacity}"></div>
              <div class="field"><label for="rW">Width (m)</label><input type="number" id="rW" min="1" step="0.5" value="${(ref.w / 100).toFixed(2)}"></div>
              <div class="row"><button class="btn" id="rVis">${ref.visible ? 'Hide' : 'Show'}</button><button class="btn" id="rAdj">${refAdjust ? 'Done moving' : 'Move &amp; scale'}</button><button class="btn" id="rImp">Replace</button><button class="btn danger" id="rDel">Remove</button></div>
              <p class="muted">Set the width to the real width of the building, then trace over it.</p>`
            : `<p class="muted" style="margin-top:0">Optional: a photo or drawing of the plan to trace over. It is only shown here, never to players.</p><button class="btn" id="rImp">Import image…</button>`}
          </div>`;
        return;
    }
    const parts = [];
    if (s.lines.length) parts.push(`${s.lines.length} line${s.lines.length > 1 ? 's' : ''}`);
    if (s.rooms.length) parts.push(`${s.rooms.length} room name${s.rooms.length > 1 ? 's' : ''}`);
    if (s.pins.length) parts.push(`${s.pins.length} task${s.pins.length > 1 ? 's' : ''}`);
    const grouped = allItems().some(x => sel.has(x.id) && x.group);
    let html = `<div class="sec"><h3>Selection</h3><p style="margin:0 0 10px">${parts.join(', ')}</p>`;
    if (n === 1 && s.rooms.length) html += `<div class="field"><label for="roomName">Room name</label><input type="text" id="roomName" maxlength="60" placeholder="e.g. Kitchen" value="${esc(s.rooms[0].name)}"></div>`;
    if (s.lines.length) {
        const doors = s.lines.filter(l => l.type === 'door').length;
        html += `<div class="field"><label>Type</label><div class="seg"><button id="tWall" class="${doors === 0 ? 'on' : ''}">Wall</button><button id="tDoor" class="${doors === s.lines.length ? 'on' : ''}">Door</button></div></div>`;
        if (s.lines.length === 1) html += `<div class="kv"><span>Length</span><b>${fmt(dist(s.lines[0].a, s.lines[0].b))}</b></div>`;
        const r = selectedRotatable();
        if (r) html += `<div class="field" style="margin-top:8px"><label for="lAng">Angle around its connected end (°)</label><div class="row"><input type="number" id="lAng" step="1" style="flex:1;min-width:0" value="${Math.round(angleOf(r.line[r.pivotKey], r.line[r.freeKey]))}"><button class="btn" id="lRotL" title="[">⟲ 15°</button><button class="btn" id="lRotR" title="]">⟳ 15°</button></div></div>`;
        else if (s.lines.length === 1 && s.lines[0].type !== 'door') html += `<p class="muted">To rotate a wall around one end, that end must be its only connected end.</p>`;
    }
    if (s.pins.length) html += s.pins.map(p => `<div class="kv"><span>Task</span><b>${esc(partName(p.code))}</b></div>`).join('');
    html += `</div><div class="sec"><h3>Arrange</h3><div class="row">
        <button class="btn" id="aRot" title="Shift+R">Rotate 90°</button><button class="btn" id="aFlipH" title="Shift+H">Flip ↔</button><button class="btn" id="aFlipV" title="Shift+V">Flip ↕</button>
        <button class="btn" id="aGroup" ${n < 2 ? 'disabled' : ''} title="Ctrl+G">Group</button><button class="btn" id="aUngroup" ${grouped ? '' : 'disabled'} title="Ctrl+Shift+G">Ungroup</button>
        <button class="btn" id="aDup" title="Ctrl+D">Duplicate</button><button class="btn danger" id="aDel" title="Delete">Delete</button></div></div>`;
    pane.innerHTML = html;
}
function renderTop() {
    $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length;
    document.body.classList.toggle('dirty', JSON.stringify(doc) !== savedState);
    $('save').disabled = saving;
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
    stage.classList.toggle('draw', tool === 'wall' || tool === 'door' || tool === 'room' || tool === 'erase');
    stage.classList.toggle('pan', tool === 'pan' || spaceDown);
    $('gridBtn').classList.toggle('on', snapGrid);
    $('stSel').textContent = sel.size ? `${sel.size} selected` : '';
    const hints = {
        select: 'Click to select · drag to move · drag a line end to move a corner · drag a box: left→right picks what is inside, right→left what it touches',
        wall: drawing ? 'Click for each corner · click an existing line to connect and stop · Enter or double-click to stop · Shift = 45°' : 'Click to start a wall',
        door: drawing ? 'Click where the door ends, on a wall' : 'Click where the door starts: a wall end, or a point along a wall',
        room: 'Click inside an enclosed room to name it',
        erase: 'Click a line to erase the piece between its junctions · drag across lines to erase several',
        pan: 'Drag to move around'
    };
    $('hint').textContent = hints[tool];
}
function refresh() {
    pruneSelection();
    analysis = analyzeFloor(floor());
    check = validatePlan(doc, units);
    render(); renderFloors(); renderTasks(); renderProblems(); renderInspector(); renderTop();
}
function quickRefresh() { analysis = analyzeFloor(floor()); render(); }

let toastTimer = 0;
function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast show ' + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'bad' ? 5000 : 3200);
}

// ---- editing operations ----------------------------------------------------------------------------
function setTool(t) {
    if (drawing) drawing = null;
    tool = t; snapShown = null; erasePreview = null;
    closeNamePopup(true);
    renderTop(); render();
}
function switchFloor(i) {
    if (i === fi || i < 0 || i >= doc.floors.length) return;
    views.set(floor().id, { ...view });
    fi = i; sel.clear(); drawing = null; refAdjust = false;
    const v = views.get(floor().id);
    if (v) { view = { ...v }; applyView(false); refresh(); } else { refresh(); fit(); }
}
function deleteSelection() {
    if (!sel.size) return;
    change(() => {
        const f = floor();
        f.lines = f.lines.filter(x => !sel.has(x.id)); f.rooms = f.rooms.filter(x => !sel.has(x.id)); f.pins = f.pins.filter(x => !sel.has(x.id));
        sel.clear();
    });
}
// Ends that move with the selection: the selection's own, plus the ends of other lines that meet them
// (so connected corners stretch along instead of coming apart).
function moveSet() {
    const f = floor(), s = selected(), ends = [];
    const moving = [];
    for (const l of s.lines) for (const key of ['a', 'b']) { ends.push({ l, key, o: [...l[key]] }); moving.push(l[key]); }
    for (const l of f.lines) {
        if (sel.has(l.id)) continue;
        for (const key of ['a', 'b']) if (moving.some(p => same(p, l[key]))) ends.push({ l, key, o: [...l[key]] });
    }
    return { ends, points: [...s.rooms, ...s.pins].map(x => ({ x, o: [...x.at] })) };
}
function applyMove(set, d) {
    for (const e of set.ends) e.l[e.key] = [e.o[0] + d[0], e.o[1] + d[1]];
    for (const p of set.points) p.x.at = [p.o[0] + d[0], p.o[1] + d[1]];
}
function nudge(dx, dy) { if (!sel.size) return; change(() => applyMove(moveSet(), [dx, dy])); }
function transformSelection(fn) {
    if (!sel.size) return;
    const s = selected(), pts = [...s.lines.flatMap(l => [l.a, l.b]), ...s.rooms.map(r => r.at), ...s.pins.map(p => p.at)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    if (snapGrid) c = c.map(v => Math.round(v / GRID) * GRID);
    const t = p => fn(p, c).map(v => Math.round(v * 100) / 100);
    change(() => { for (const l of s.lines) { l.a = t(l.a); l.b = t(l.b); } for (const r of s.rooms) r.at = t(r.at); for (const p of s.pins) p.at = t(p.at); });
}
const rotate = () => transformSelection((p, c) => [c[0] - (p[1] - c[1]), c[1] + (p[0] - c[0])]);
const flipH = () => transformSelection((p, c) => [2 * c[0] - p[0], p[1]]);
const flipV = () => transformSelection((p, c) => [p[0], 2 * c[1] - p[1]]);
function setType(type) {
    const s = selected();
    if (!s.lines.length) return;
    change(() => { for (const l of s.lines) l.type = type; });
}
function toggleType() { const s = selected(); if (s.lines.length) setType(s.lines.every(l => l.type === 'door') ? 'wall' : 'door'); }
function group() {
    if (sel.size < 2) { toast('Select two or more things to group them.'); return; }
    const g = uid('g');
    change(() => { for (const x of allItems()) if (sel.has(x.id)) x.group = g; });
}
function ungroup() { change(() => { for (const x of allItems()) if (sel.has(x.id)) delete x.group; }); }
function copy(cut = false) {
    const s = selected();
    if (!s.lines.length && !s.rooms.length) { if (s.pins.length) toast('Tasks are not copied: each one goes in one place only.'); return; }
    clipboard = JSON.parse(JSON.stringify({ lines: s.lines, rooms: s.rooms }));
    pasteN = 0;
    if (s.pins.length) toast('Copied. Tasks are left out: each one goes in one place only.');
    if (cut) deleteSelection();
}
function paste() {
    if (!clipboard) return;
    pasteN++;
    const off = cut => GRID * 2 * pasteN;
    const d = [off(), off()];
    const gmap = new Map(), ng = g => (g ? (gmap.get(g) || (gmap.set(g, uid('g')), gmap.get(g))) : undefined);
    change(() => {
        const f = floor();
        sel.clear();
        for (const l of clipboard.lines) { const n = { id: uid('l'), type: l.type, a: [l.a[0] + d[0], l.a[1] + d[1]], b: [l.b[0] + d[0], l.b[1] + d[1]] }; if (l.group) n.group = ng(l.group); f.lines.push(n); sel.add(n.id); }
        for (const r of clipboard.rooms) { const n = { id: uid('r'), name: r.name, at: [r.at[0] + d[0], r.at[1] + d[1]] }; if (r.group) n.group = ng(r.group); f.rooms.push(n); sel.add(n.id); }
    });
}
function duplicate() { const keep = clipboard, keepN = pasteN; copy(); paste(); clipboard = keep || clipboard; if (keep) pasteN = keepN; }
function selectAll() { sel = new Set(allItems().map(x => x.id)); refresh(); }
function placePin(code, w) {
    change(() => {
        for (const f of doc.floors) f.pins = f.pins.filter(p => p.code !== code);
        const p = { id: uid('p'), code, at: [Math.round(w[0]), Math.round(w[1])] };
        floor().pins.push(p);
        sel = new Set([p.id]);
    });
    if (!analysis.roomAt(floor().pins.find(p => p.code === code).at)) toast('Put the task inside a room.', 'bad');
}
function findPin(code) {
    const i = doc.floors.findIndex(f => f.pins.some(p => p.code === code));
    if (i < 0) return false;
    switchFloor(i);
    const p = floor().pins.find(x => x.code === code);
    sel = new Set([p.id]); centerOn(p.at); refresh();
    return true;
}

// ---- drawing walls and doors -----------------------------------------------------------------------
function addSegment(s) {
    if (same(s.p, drawing.start)) { finishDrawing(); return; }
    const type = drawing.type, a = drawing.start;
    change(() => {
        const l = { id: uid('l'), type, a: [...a], b: [...s.p] };
        floor().lines.push(l);
        if (type === 'door') overwriteWalls(l);
    });
    drawing.count++;
    if (type === 'door' || ((s.kind === 'end' || s.kind === 'line') && drawing.count > 0)) { finishDrawing(); return; }
    drawing.start = [...s.p]; drawing.armed = true;
    renderTop();
}
function finishDrawing() { drawing = null; snapShown = null; renderTop(); render(); }

// ---- room names ------------------------------------------------------------------------------------
let popup = null;
function openNamePopup(roomId) {
    closeNamePopup(true);
    const r = floor().rooms.find(x => x.id === roomId);
    if (!r) return;
    const [sx, sy] = toScreen(r.at), sr = stage.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'popname';
    box.innerHTML = `<input type="text" maxlength="60" placeholder="Room name" aria-label="Room name" value="${esc(r.name)}"><button type="button">OK</button>`;
    box.style.left = Math.max(8, Math.min(sr.width - 260, sx - sr.left - 120)) + 'px';
    box.style.top = Math.max(8, Math.min(sr.height - 50, sy - sr.top - 54)) + 'px';
    stage.appendChild(box);
    const input = box.querySelector('input');
    popup = { box, roomId };
    const commit = () => {
        const v = input.value.trim();
        closeNamePopup(false);
        const room = floor().rooms.find(x => x.id === roomId);
        if (room && room.name !== v) change(() => { room.name = v; });
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') closeNamePopup(true); });
    box.querySelector('button').addEventListener('click', commit);
    input.addEventListener('blur', () => setTimeout(() => { if (popup && popup.box === box && !box.contains(document.activeElement)) commit(); }, 80));
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
function closeNamePopup() { if (popup) { popup.box.remove(); popup = null; } }

// ---- pointer handling on the canvas ----------------------------------------------------------------
const pointers = new Map();
svg.addEventListener('pointerdown', e => {
    closeNamePopupIfOutside(e);
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const w = toWorld(e.clientX, e.clientY);
    cursor = w;
    if (pointers.size === 2) {   // pinch: zoom and pan with two fingers
        const [p1, p2] = [...pointers.values()];
        drag = { mode: 'pinch', d0: Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), k0: view.k, c0: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], t0: [view.tx, view.ty], w0: toWorld((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2) };
        return;
    }
    if (e.button === 1 || e.button === 2 && tool !== 'wall' || tool === 'pan' || spaceDown) {
        e.preventDefault();
        drag = { mode: 'pan', c: [e.clientX, e.clientY], t: [view.tx, view.ty] };
        stage.classList.add('panning');
        return;
    }
    if (e.button !== 0) return;

    if (tool === 'wall' || tool === 'door') {
        const s = snapPoint(w, { from: drawing && drawing.start, shift: e.shiftKey, alt: e.altKey });
        if (!drawing) drawing = { type: tool, start: [...s.p], armed: false, down: [e.clientX, e.clientY], count: 0 };
        else drawing.down = [e.clientX, e.clientY];
        snapShown = s;
        renderTop(); renderOverlay();
        return;
    }
    if (tool === 'room') { drag = { mode: 'click', c: [e.clientX, e.clientY] }; return; }
    if (tool === 'erase') {
        drag = { mode: 'erase', before: snapshot(), done: 0 };
        if (erasePiece(pieceAt(w))) { drag.done++; erasePreview = pieceAt(w); quickRefresh(); }
        return;
    }

    // select tool
    const hit = hitTest(w);
    if (hit && hit.kind === 'rotate') {
        drag = { mode: 'rotate', before: snapshot(), r: hit.r };
        return;
    }
    if (hit && hit.kind === 'end') {
        const ends = [];
        for (const l of floor().lines) for (const key of ['a', 'b']) if (same(l[key], hit.point)) ends.push({ l, key });
        drag = { mode: 'corner', before: snapshot(), ends, exclude: new Set(ends.map(x => x.l.id)), moved: false, c: [e.clientX, e.clientY], w0: w, shift: e.shiftKey, alt: e.altKey };
        return;
    }
    if (hit && (hit.kind === 'ref' || hit.kind === 'refScale')) {
        const ref = floor().reference;
        drag = { mode: hit.kind, before: snapshot(), w0: w, o: { ...ref } };
        return;
    }
    if (hit && hit.id) {
        const ids = withGroup(hit.id, e.altKey);
        if (e.shiftKey) { const on = sel.has(hit.id); ids.forEach(id => (on ? sel.delete(id) : sel.add(id))); refresh(); return; }
        if (!sel.has(hit.id)) { sel = new Set(ids); refresh(); }
        drag = { mode: 'move', before: snapshot(), w0: w, set: moveSet(), moved: false, c: [e.clientX, e.clientY] };
        return;
    }
    if (!e.shiftKey && sel.size) { sel.clear(); refresh(); }
    drag = { mode: 'box', w0: w, base: new Set(sel), rect: null };
});

function closeNamePopupIfOutside(e) { if (popup && !popup.box.contains(e.target)) { const input = popup.box.querySelector('input'); input.blur(); } }

svg.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const w = toWorld(e.clientX, e.clientY);
    cursor = w;
    $('stPos').textContent = `x ${(w[0] / 100).toFixed(2)} m · y ${(w[1] / 100).toFixed(2)} m`;
    if (drag && drag.mode === 'pinch' && pointers.size === 2) {
        const [p1, p2] = [...pointers.values()], r = svg.getBoundingClientRect();
        const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), c = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        view.k = Math.max(0.02, Math.min(6, drag.k0 * d / drag.d0));
        view.tx = c[0] - r.left - drag.w0[0] * view.k; view.ty = c[1] - r.top - drag.w0[1] * view.k;
        applyView();
        return;
    }
    if (drag && drag.mode === 'pan') {
        view.tx = drag.t[0] + e.clientX - drag.c[0]; view.ty = drag.t[1] + e.clientY - drag.c[1];
        applyView(false);
        return;
    }
    if (tool === 'wall' || tool === 'door') {
        snapShown = snapPoint(w, { from: drawing && drawing.start, shift: e.shiftKey, alt: e.altKey });
        renderOverlay();
        return;
    }
    if (tool === 'erase') {
        const pc = pieceAt(w);
        if (drag && drag.mode === 'erase' && pc) { erasePiece(pc); drag.done++; quickRefresh(); }
        erasePreview = pieceAt(w);
        renderOverlay();
        return;
    }
    if (drag && drag.mode === 'rotate') {
        const P = drag.r.line[drag.r.pivotKey];
        let deg = angleOf(P, w);
        if (!e.altKey) deg = Math.round(deg / 15) * 15;
        setAngle(drag.r, deg, !e.altKey);
        quickRefresh();
        return;
    }
    if (!drag) {
        const h = tool === 'select' || tool === 'room' ? hitTest(w) : null;
        const hp = h && h.kind === 'pin' ? h.id : null;
        if (hp !== hoverPin) { hoverPin = hp; render(); }
        return;
    }
    if (drag.mode === 'corner') {
        if (!drag.moved && Math.hypot(e.clientX - drag.c[0], e.clientY - drag.c[1]) < 3) return;
        drag.moved = true;
        const s = snapPoint(w, { alt: e.altKey, exclude: drag.exclude });
        for (const x of drag.ends) x.l[x.key] = [...s.p];
        snapShown = s;
        quickRefresh();
    } else if (drag.mode === 'move') {
        if (!drag.moved && Math.hypot(e.clientX - drag.c[0], e.clientY - drag.c[1]) < 3) return;
        drag.moved = true;
        let d = [w[0] - drag.w0[0], w[1] - drag.w0[1]];
        if (snapGrid && !e.altKey) d = d.map(v => Math.round(v / GRID) * GRID);
        applyMove(drag.set, d);
        quickRefresh();
    } else if (drag.mode === 'ref' || drag.mode === 'refScale') {
        const ref = floor().reference;
        if (drag.mode === 'ref') { ref.x = drag.o.x + w[0] - drag.w0[0]; ref.y = drag.o.y + w[1] - drag.w0[1]; }
        else { const s = Math.max(0.05, (w[0] - drag.o.x) / drag.o.w); ref.w = drag.o.w * s; ref.h = drag.o.h * s; }
        render();
    } else if (drag.mode === 'box') {
        const x = Math.min(drag.w0[0], w[0]), y = Math.min(drag.w0[1], w[1]), wd = Math.abs(w[0] - drag.w0[0]), ht = Math.abs(w[1] - drag.w0[1]);
        drag.rect = [x, y, wd, ht];
        drag.crossing = w[0] < drag.w0[0];
        const inside = p => p[0] >= x && p[0] <= x + wd && p[1] >= y && p[1] <= y + ht;
        // does segment ab touch the box? (an end inside, or crossing one of its sides)
        const touches = (a, b) => {
            if (inside(a) || inside(b)) return true;
            const c = [[x, y], [x + wd, y], [x + wd, y + ht], [x, y + ht]];
            const cr = (p, q, r, s) => { const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]); if (!d) return false; const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d, u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d; return t >= 0 && t <= 1 && u >= 0 && u <= 1; };
            return c.some((p, i) => cr(a, b, p, c[(i + 1) % 4]));
        };
        const f = floor(), hits = new Set(drag.base);
        for (const l of f.lines) if (drag.crossing ? touches(l.a, l.b) : (inside(l.a) && inside(l.b))) withGroup(l.id).forEach(id => hits.add(id));
        for (const r of f.rooms) if (inside(r.at)) withGroup(r.id).forEach(id => hits.add(id));
        for (const p of f.pins) if (inside(p.at)) withGroup(p.id).forEach(id => hits.add(id));
        sel = hits;
        render();
        $('stSel').textContent = sel.size ? `${sel.size} selected` : '';
    }
});

function endPointer(e) {
    pointers.delete(e.pointerId);
    if (drag && drag.mode === 'pinch') { if (pointers.size < 2) drag = null; return; }
    stage.classList.remove('panning');
    const w = toWorld(e.clientX, e.clientY);
    if ((tool === 'wall' || tool === 'door') && drawing && e.type === 'pointerup' && e.button === 0) {
        const moved = drawing.down && Math.hypot(e.clientX - drawing.down[0], e.clientY - drawing.down[1]) > 6;
        if (drawing.armed || moved) addSegment(snapPoint(w, { from: drawing.start, shift: e.shiftKey, alt: e.altKey }));
        else { drawing.armed = true; renderTop(); }
        return;
    }
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'click' && tool === 'room' && Math.hypot(e.clientX - d.c[0], e.clientY - d.c[1]) < 5) {
        const hit = hitTest(w);
        if (hit && hit.kind === 'room') { sel = new Set([hit.id]); refresh(); openNamePopup(hit.id); return; }
        const face = analysis.roomAt(w);
        if (!face) { toast('Click inside an enclosed room. Close the walls around it first.'); return; }
        if (face.roomId) { sel = new Set([face.roomId]); refresh(); openNamePopup(face.roomId); return; }
        const id = uid('r');
        change(() => { floor().rooms.push({ id, name: '', at: [Math.round(w[0]), Math.round(w[1])] }); sel = new Set([id]); });
        openNamePopup(id);
        return;
    }
    if (d.mode === 'corner' && !d.moved) {
        // a click (no drag) near a line end selects the line there, like clicking its middle
        const f = floor();
        let line = null, best = Infinity;
        for (const x of d.ends) { const q = project(d.w0, x.l.a, x.l.b); const dd = q.d + (q.t <= 0 || q.t >= 1 ? 0.001 : 0); if (dd < best) { best = dd; line = x.l; } }
        if (line && f.lines.includes(line)) {
            const ids = withGroup(line.id, d.alt);
            if (d.shift) { const on = sel.has(line.id); ids.forEach(id => (on ? sel.delete(id) : sel.add(id))); }
            else sel = new Set(ids);
        }
        snapShown = null; refresh();
        return;
    }
    if (d.mode === 'erase') {
        erasePreview = pieceAt(w);
        if (snapshot() !== d.before) pushUndo(d.before);
        refresh();
        return;
    }
    if (d.mode === 'corner' || d.mode === 'move' || d.mode === 'ref' || d.mode === 'refScale' || d.mode === 'rotate') {
        snapShown = null;
        if (snapshot() !== d.before) pushUndo(d.before);
        refresh();
    } else if (d.mode === 'box') { refresh(); }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('pointerleave', () => { if (!drag && !drawing) { snapShown = null; erasePreview = null; renderOverlay(); } });
svg.addEventListener('dblclick', () => { if (drawing) finishDrawing(); });
svg.addEventListener('contextmenu', e => { e.preventDefault(); if (drawing) finishDrawing(); });
svg.addEventListener('wheel', e => {
    e.preventDefault();
    // pinch on a trackpad (ctrl) or a mouse wheel zooms; two-finger scrolling pans
    const pans = !e.ctrlKey && e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) < 40);
    if (pans) { view.tx -= e.deltaX; view.ty -= e.deltaY; applyView(false); return; }
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

// ---- dragging tasks from the panel onto the plan ---------------------------------------------------
$('pane-tasks').addEventListener('pointerdown', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    e.preventDefault();
    const code = chip.dataset.code, start = [e.clientX, e.clientY];
    let ghost = null;
    const move = ev => {
        if (!ghost && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 5) return;
        if (!ghost) { ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = partName(code); document.body.appendChild(ghost); }
        ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    };
    const up = ev => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        if (!ghost) { if (!findPin(code)) toast('Drag it onto a room on the plan.'); return; }
        ghost.remove();
        const r = svg.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) placePin(code, toWorld(ev.clientX, ev.clientY));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});

// ---- panels: clicks and edits ----------------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.pane));
}));
function showPane(name) { document.querySelector(`.tabs button[data-pane="${name}"]`).click(); }

$('pane-problems').addEventListener('click', e => {
    const b = e.target.closest('.prob');
    if (!b) return;
    const p = check.problems[+b.dataset.i];
    if (!p) return;
    if (p.code === 'unit-partial') { showPane('tasks'); return; }
    const i = doc.floors.findIndex(f => f.id === p.floor);
    if (i >= 0) switchFloor(i);
    sel = new Set((p.ids || []).filter(id => findItem(id)));
    if (p.at) { if (view.k < 0.5) view.k = 0.6; centerOn(p.at); }
    refresh();
});

$('pane-inspect').addEventListener('click', e => {
    const id = e.target.id;
    const f = floor();
    if (id === 'fLeft' || id === 'fRight') {
        const j = id === 'fLeft' ? fi - 1 : fi + 1;
        change(() => { const [x] = doc.floors.splice(fi, 1); doc.floors.splice(j, 0, x); fi = j; });
    } else if (id === 'fDel') {
        if (!confirm(`Delete "${f.name}" and everything on it? Its tasks go back to the task list.`)) return;
        change(() => { doc.floors.splice(fi, 1); fi = Math.max(0, fi - 1); });
        fit();
    } else if (id === 'rImp') { $('refFile').click(); }
    else if (id === 'rVis') { change(() => { f.reference.visible = !f.reference.visible; }); }
    else if (id === 'rAdj') { refAdjust = !refAdjust; if (refAdjust) setTool('select'); renderInspector(); render(); }
    else if (id === 'rDel') { refAdjust = false; change(() => { f.reference = null; }); }
    else if (id === 'lRotL') rotateBy(15);
    else if (id === 'lRotR') rotateBy(-15);
    else if (id === 'tWall') setType('wall');
    else if (id === 'tDoor') setType('door');
    else if (id === 'aRot') rotate();
    else if (id === 'aFlipH') flipH();
    else if (id === 'aFlipV') flipV();
    else if (id === 'aGroup') group();
    else if (id === 'aUngroup') ungroup();
    else if (id === 'aDup') duplicate();
    else if (id === 'aDel') deleteSelection();
});
$('pane-inspect').addEventListener('change', e => {
    const f = floor(), id = e.target.id, v = e.target.value;
    if (id === 'fName') change(() => { f.name = v.trim(); });
    else if (id === 'roomName') { const r = selected().rooms[0]; if (r) change(() => { r.name = v.trim(); }); }
    else if (id === 'lAng') { const r = selectedRotatable(); if (r && Number.isFinite(+v)) change(() => setAngle(r, +v)); }
    else if (id === 'rOp') change(() => { f.reference.opacity = +v; });
    else if (id === 'rW') { const w = Math.max(100, +v * 100); if (w) change(() => { const s = w / f.reference.w; f.reference.w = w; f.reference.h *= s; }); }
    e.target.blur();
});
$('pane-inspect').addEventListener('input', e => { if (e.target.id === 'rOp') { floor().reference.opacity = +e.target.value; render(); } });
$('pane-inspect').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });

$('refFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const res = await fetch('/floorplan/reference', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Upload failed.');
        const url = URL.createObjectURL(file), img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const r = svg.getBoundingClientRect(), c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
            const w = Math.min(4000, Math.max(800, img.naturalWidth)), h = w * (img.naturalHeight / img.naturalWidth || 0.7);
            change(() => { floor().reference = { file: out.file, x: Math.round(c[0] - w / 2), y: Math.round(c[1] - h / 2), w, h, opacity: 0.5, visible: true }; });
            refAdjust = true; renderInspector(); render();
            toast('Drag the image to place it, drag its corner to size it, and set its real width.');
        };
        img.src = url;
    } catch (err) { toast(err.message, 'bad'); }
});

$('floors').addEventListener('click', e => { const b = e.target.closest('.ftab'); if (b && !b.querySelector('input')) switchFloor(+b.dataset.i); });
$('floors').addEventListener('dblclick', e => {
    const b = e.target.closest('.ftab');
    if (!b) return;
    const i = +b.dataset.i, f = doc.floors[i];
    b.innerHTML = `<input type="text" maxlength="60" value="${esc(f.name)}" aria-label="Floor name">`;
    const input = b.querySelector('input');
    input.focus(); input.select();
    const done = save => { if (save && input.value.trim() !== f.name) change(() => { f.name = input.value.trim(); }); else renderFloors(); };
    input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = f.name; input.blur(); } });
    input.addEventListener('blur', () => done(true));
});
$('addFloor').addEventListener('click', () => {
    views.set(floor().id, { ...view });
    change(() => { doc.floors.push(emptyFloor(doc.floors.length + 1)); fi = doc.floors.length - 1; sel.clear(); });
    fit();
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('save').addEventListener('click', save);

// ---- export / import -------------------------------------------------------------------------------
// The file holds the whole plan as it is on screen (unsaved changes too) plus the reference images, so it
// can be moved to another server or kept as a backup. Importing replaces the plan in the editor (undoable)
// and only reaches the server when it is saved.
const EXPORT_FORMAT = 'among-us-irl-floorplan';
const blobToDataUrl = blob => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(blob); });

async function exportPlan() {
    if (drawing) finishDrawing();
    const images = {};
    for (const f of doc.floors) {
        const file = f.reference && f.reference.file;
        if (!file || images[file]) continue;
        try {
            const res = await fetch('/floorplan/ref/' + encodeURIComponent(file));
            if (res.ok) images[file] = await blobToDataUrl(await res.blob());
        } catch (e) { /* exported without that image */ }
    }
    const out = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), plan: doc, images };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `floorplan-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const missing = doc.floors.filter(f => f.reference && !images[f.reference.file]).length;
    toast(missing ? `Exported. ${missing} reference image${missing > 1 ? 's' : ''} could not be included.` : 'Exported.', missing ? 'bad' : 'good');
}

// Keeps only well-formed parts of an imported plan, so a hand-edited file can't break the editor.
function cleanImported(plan) {
    const num = v => typeof v === 'number' && Number.isFinite(v);
    const pt = v => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
    const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');
    const idOk = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
    const floors = (Array.isArray(plan && plan.floors) ? plan.floors : []).slice(0, 50).map(f => ({
        id: idOk(f.id) ? f.id : uid('f'),
        name: str(f.name, 60),
        reference: f.reference && typeof f.reference.file === 'string' && ['x', 'y', 'w', 'h'].every(k => num(f.reference[k]))
            ? { file: f.reference.file, x: f.reference.x, y: f.reference.y, w: f.reference.w, h: f.reference.h, opacity: num(f.reference.opacity) ? Math.max(0, Math.min(1, f.reference.opacity)) : 0.5, visible: f.reference.visible !== false }
            : null,
        lines: (Array.isArray(f.lines) ? f.lines : []).filter(l => l && pt(l.a) && pt(l.b)).map(l => ({ id: idOk(l.id) ? l.id : uid('l'), type: l.type === 'door' ? 'door' : 'wall', a: [l.a[0], l.a[1]], b: [l.b[0], l.b[1]], ...(idOk(l.group) ? { group: l.group } : {}) })),
        rooms: (Array.isArray(f.rooms) ? f.rooms : []).filter(r => r && pt(r.at)).map(r => ({ id: idOk(r.id) ? r.id : uid('r'), name: str(r.name, 60), at: [r.at[0], r.at[1]], ...(idOk(r.group) ? { group: r.group } : {}) })),
        pins: (Array.isArray(f.pins) ? f.pins : []).filter(p => p && pt(p.at) && typeof p.code === 'string').map(p => ({ id: idOk(p.id) ? p.id : uid('p'), code: p.code.slice(0, 80), at: [p.at[0], p.at[1]], ...(idOk(p.group) ? { group: p.group } : {}) }))
    }));
    return { version: 1, floors };
}

async function importPlan(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { toast('That file is not a floor plan export (it is not valid JSON).', 'bad'); return; }
    const plan = data && data.format === EXPORT_FORMAT ? data.plan : data;   // a bare map.json works too
    if (!plan || !Array.isArray(plan.floors) || !plan.floors.length) { toast('That file has no floors in it.', 'bad'); return; }
    if (!confirm('Replace the floor plan in the editor with the imported one? You can undo this, and nothing changes on the server until you save.')) return;
    const clean = cleanImported(plan);
    // Reference images travel inside the file; upload them again and use the new file names.
    const images = (data && data.images) || {};
    let lost = 0;
    for (const f of clean.floors) {
        if (!f.reference) continue;
        const url = images[f.reference.file];
        if (typeof url !== 'string' || !url.startsWith('data:image/')) { f.reference = null; lost++; continue; }
        try {
            const blob = await (await fetch(url)).blob();
            const res = await fetch('/floorplan/reference', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
            const out = await res.json();
            if (!res.ok) throw new Error(out.error);
            f.reference.file = out.file;
        } catch (e) { f.reference = null; lost++; }
    }
    if (!clean.floors.length) clean.floors.push(emptyFloor(1));
    change(() => { doc = clean; fi = 0; sel.clear(); drawing = null; });
    views.clear();
    fit();
    const known = new Set(units.flatMap(u => u.parts.map(p => p.code)));
    const unknown = clean.floors.reduce((n, f) => n + f.pins.filter(p => !known.has(p.code)).length, 0);
    const notes = [];
    if (lost) notes.push(`${lost} reference image${lost > 1 ? 's were' : ' was'} missing`);
    if (unknown) notes.push(`${unknown} task${unknown > 1 ? 's' : ''} on the plan don't exist on this server (see Problems)`);
    toast(`Imported ${clean.floors.length} floor${clean.floors.length > 1 ? 's' : ''}. Save to keep it.` + (notes.length ? ' ' + notes.join('; ') + '.' : ''), notes.length ? 'bad' : 'good');
}
$('exportBtn').addEventListener('click', exportPlan);
$('importBtn').addEventListener('click', () => $('planFile').click());
$('planFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importPlan(f); });
$('fitBtn').addEventListener('click', fit);
$('gridBtn').addEventListener('click', () => { snapGrid = !snapGrid; renderTop(); });
$('helpBtn').addEventListener('click', () => $('help').classList.add('on'));
$('helpClose').addEventListener('click', () => $('help').classList.remove('on'));
$('help').addEventListener('click', e => { if (e.target.id === 'help') $('help').classList.remove('on'); });
$('sideToggle').addEventListener('click', () => $('side').classList.toggle('open'));
document.querySelectorAll('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

// ---- keyboard --------------------------------------------------------------------------------------
document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
        if ($('help').classList.contains('on')) { $('help').classList.remove('on'); return; }
        if (drawing) { finishDrawing(); return; }
        if (refAdjust) { refAdjust = false; renderInspector(); render(); return; }
        if (sel.size) { sel.clear(); refresh(); }
        return;
    }
    if (mod) {
        if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
        else if (key === 'c') { e.preventDefault(); copy(); }
        else if (key === 'x') { e.preventDefault(); copy(true); }
        else if (key === 'v') { e.preventDefault(); paste(); }
        else if (key === 'd') { e.preventDefault(); duplicate(); }
        else if (key === 'a') { e.preventDefault(); selectAll(); }
        else if (key === 'g') { e.preventDefault(); e.shiftKey ? ungroup() : group(); }
        return;
    }
    if (e.key === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; renderTop(); } return; }
    if (e.key === 'Enter' && drawing) { finishDrawing(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = (snapGrid ? GRID : 1) * (e.shiftKey ? 10 : 1);
        nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        return;
    }
    if (e.shiftKey && key === 'r') { rotate(); return; }
    if (e.shiftKey && key === 'h') { flipH(); return; }
    if (e.shiftKey && key === 'v') { flipV(); return; }
    if (e.key === '?') { $('help').classList.add('on'); return; }
    if (e.key === '[') { rotateBy(15); return; }
    if (e.key === ']') { rotateBy(-15); return; }
    const tools = { v: 'select', w: 'wall', d: 'door', r: 'room', e: 'erase', h: 'pan' };
    if (tools[key]) { setTool(tools[key]); return; }
    if (key === 'g') { snapGrid = !snapGrid; renderTop(); toast(snapGrid ? 'Grid snap on' : 'Grid snap off'); return; }
    if (key === 'f') { fit(); return; }
    if (key === 't') { toggleType(); return; }
    if (key === '+' || key === '=') { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); return; }
    if (key === '-') { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); return; }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; renderTop(); } });
window.addEventListener('blur', () => { spaceDown = false; renderTop(); });
window.addEventListener('resize', () => applyView());
window.addEventListener('beforeunload', e => { if (JSON.stringify(doc) !== savedState) { e.preventDefault(); e.returnValue = ''; } });

// ---- saving ----------------------------------------------------------------------------------------
async function save() {
    if (saving) return;
    if (drawing) finishDrawing();
    check = validatePlan(doc, units);
    if (check.problems.length) {
        refresh(); showPane('problems'); $('side').classList.add('open');
        toast(`Fix ${check.problems.length} problem${check.problems.length > 1 ? 's' : ''} before saving.`, 'bad');
        return;
    }
    saving = true; renderTop();
    try {
        const res = await fetch('/floorplan/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: doc }) });
        const out = await res.json().catch(() => ({}));
        if (res.status === 422 && out.problems) { check.problems = out.problems; renderProblems(); showPane('problems'); throw new Error('The server found problems in the plan.'); }
        if (!res.ok) throw new Error(out.error || 'Saving failed.');
        savedState = JSON.stringify(doc);
        const off = out.disabled || [];
        toast(off.length ? `Saved. Switched off (not on the plan): ${off.join(', ')}.` : 'Saved. Every task is on the plan.', 'good');
    } catch (err) {
        toast(err.message, 'bad');
    } finally {
        saving = false; renderTop();
    }
}

// ---- start -----------------------------------------------------------------------------------------
async function start() {
    let data;
    try {
        const res = await fetch('/floorplan/data');
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load the floor plan.');
    } catch (err) {
        document.body.innerHTML = `<div style="padding:24px;color:#e9ecf1;font:14px system-ui">${esc(err.message)} <a href="/host" style="color:#ffb02e">Log in as host</a></div>`;
        return;
    }
    units = data.units || [];
    gameRunning = !!data.gameRunning;
    doc = normalise(data.plan);
    savedState = data.plan ? JSON.stringify(doc) : '';
    if (!data.plan) savedState = JSON.stringify(doc);
    refresh();
    fit();
    setTool('select');
    if (gameRunning) toast('A game is running. You can edit, but saving waits until it ends.', 'bad');
    // QA hook for automated tests: ?qa=1 exposes plan <-> screen conversion and the plan.
    if (/[?&]qa=1/.test(location.search)) window.__fp = { toScreen, doc: () => doc, check: () => check, undo: () => undoStack.length };
}
start();
