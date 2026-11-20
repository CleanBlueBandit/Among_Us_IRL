// Floor plan geometry and rules, shared by the editor (browser) and the server (Node).
// The server runs exactly the same checks before it accepts a save, so the editor's live problem list
// and the server's verdict can never disagree.
//
// A plan:
//   { version: 1, floors: [ {
//       id, name,
//       reference: null | { file, x, y, w, h, opacity, visible },   // optional image to trace over
//       lines: [ { id, type: 'wall' | 'door', a: [x, y], b: [x, y], group? } ],
//       rooms: [ { id, name, at: [x, y], group?, void? } ],           // a room's name, placed inside it;
//                                                                     // void: true marks the space as void
//       pins:  [ { id, code, at: [x, y], group? } ]                   // a task's QR code, placed inside a room
//   } ] }
// Coordinates are in centimetres.
//
// Rules:
//   - Every line end touches another line: its end, or anywhere along it.
//   - A door's ends each touch exactly one other line, and that line is a wall. Nothing touches the
//     middle of a door, and a door crosses nothing.
//   - Walls may cross each other (that makes a junction). Lines may not overlap.
//   - Every enclosed area is a room and needs exactly one name. Names are unique on a floor.
//   - ...or it is void: a space that isn't part of the game (a shaft, a gap between buildings). A void
//     has a void marker instead of a name, no doors, and no tasks, and is not a room.
//   - Every room on a floor can be reached from every other room through doors; a door separates two
//     different spaces (a room and outside counts).
//   - Task pins sit inside a room. Every part of a bound or repeating task is placed, or none of it.

export const EPS = 0.01;            // cm: points closer than this are the same point
const MIN_FACE_AREA = 1;            // cm²: smaller enclosed slivers are ignored

// ---- small vector helpers --------------------------------------------------------------------------
export const same = (p, q) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
export const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// Closest point of segment ab to p, with its position t along the segment (0 = a, 1 = b).
export function project(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + dx * t, a[1] + dy * t];
    return { point: q, t, d: dist(p, q) };
}

// Is p on the inside of segment ab (not at either end)?
export function onInterior(p, a, b) {
    if (same(p, a) || same(p, b)) return false;
    const r = project(p, a, b);
    return r.d < EPS && r.t > 0 && r.t < 1;
}

// Proper crossing of ab and cd strictly inside both segments; returns the point or null.
function crossing(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) return null;
    const qp = [c[0] - a[0], c[1] - a[1]];
    const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
    const p = [a[0] + r[0] * t, a[1] + r[1] * t];
    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
    if (same(p, a) || same(p, b) || same(p, c) || same(p, d)) return null;
    return p;
}

// Do collinear segments ab and cd share more than a point?
function overlaps(a, b, c, d) {
    const ab = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(ab[0], ab[1]);
    if (len < EPS) return false;
    const cross = q => Math.abs(((q[0] - a[0]) * ab[1] - (q[1] - a[1]) * ab[0]) / len);
    if (cross(c) > EPS || cross(d) > EPS) return false;
    const along = q => ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / len;
    const lo = Math.max(0, Math.min(along(c), along(d))), hi = Math.min(len, Math.max(along(c), along(d)));
    return hi - lo > EPS;
}

export function polygonArea(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
}

export function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
}

// A point well inside a polygon, and outside its holes (for putting a hint or label in an unnamed room).
export function interiorPoint(poly, holes = []) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    let best = null, bestD = -1;
    const N = 14;
    for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
        const p = [minX + (maxX - minX) * i / N, minY + (maxY - minY) * j / N];
        if (!pointInPolygon(p, poly) || holes.some(h => pointInPolygon(p, h))) continue;
        let d = Infinity;
        for (const ring of [poly, ...holes]) for (let k = 0; k < ring.length; k++) d = Math.min(d, project(p, ring[k], ring[(k + 1) % ring.length]).d);
        if (d > bestD) { bestD = d; best = p; }
    }
    return best || poly[0];
}

// ---- floor analysis --------------------------------------------------------------------------------
// Returns {
//   problems: [{ code, message, at: [x, y], ids: [...] }],
//   faces:    [{ id, poly, area, holes: [poly], roomId, name, void, door }]   every enclosed area
//             (roomId is its name or void marker; door: a door touches it)
//   roomAt(p) -> face or null                                     the enclosed area containing point p
//   doorSides: Map doorLineId -> [faceId | 'outside', faceId | 'outside']
// }
export function analyzeFloor(floor) {
    const lines = (floor.lines || []).filter(l => l && l.a && l.b);
    const problems = [];
    const add = (code, message, at, ids = []) => problems.push({ code, message, at, ids });

    // 1. lines on their own
    const good = [];
    for (const l of lines) {
        if (dist(l.a, l.b) < EPS) add('zero', 'A line has no length.', l.a, [l.id]);
        else good.push(l);
    }

    // 2. what touches what
    const touching = (p, self) => good.filter(m => m !== self && (same(p, m.a) || same(p, m.b) || onInterior(p, m.a, m.b)));
    for (const l of good) {
        for (const end of [l.a, l.b]) {
            const t = touching(end, l);
            if (l.type === 'door') {
                if (t.length === 0) add('loose-door', 'Door end is not connected to a wall.', end, [l.id]);
                else if (t.length > 1) add('door-crowded', 'A door end must touch exactly one wall.', end, [l.id, ...t.map(m => m.id)]);
                else if (t[0].type === 'door') add('door-door', 'A door cannot connect to another door.', end, [l.id, t[0].id]);
            } else {
                if (t.length === 0) add('loose', 'Wall end is not connected to anything.', end, [l.id]);
                for (const m of t) {
                    if (m.type === 'door' && onInterior(end, m.a, m.b)) add('door-middle', 'Nothing can connect to the middle of a door.', end, [l.id, m.id]);
                }
            }
        }
    }

    // 3. crossings and overlaps
    const crossings = [];   // wall/wall junctions: [lineA, lineB, point]
    for (let i = 0; i < good.length; i++) {
        for (let j = i + 1; j < good.length; j++) {
            const l = good[i], m = good[j];
            if (overlaps(l.a, l.b, m.a, m.b)) { add('overlap', 'Two lines lie on top of each other.', project(m.a, l.a, l.b).point, [l.id, m.id]); continue; }
            const p = crossing(l.a, l.b, m.a, m.b);
            if (!p) continue;
            if (l.type === 'door' || m.type === 'door') add('door-cross', 'A door crosses another line.', p, [l.id, m.id]);
            else crossings.push([l, m, p]);
        }
    }

    // 4. planar graph: split every line where something meets it
    const verts = [];
    const vertexAt = p => {
        for (let i = 0; i < verts.length; i++) if (same(verts[i], p)) return i;
        verts.push([p[0], p[1]]);
        return verts.length - 1;
    };
    const cuts = new Map(good.map(l => [l, [0, 1]]));
    for (const l of good) {
        for (const m of good) {
            if (m === l) continue;
            for (const e of [m.a, m.b]) if (onInterior(e, l.a, l.b)) cuts.get(l).push(project(e, l.a, l.b).t);
        }
    }
    for (const [l, m, p] of crossings) { cuts.get(l).push(project(p, l.a, l.b).t); cuts.get(m).push(project(p, m.a, m.b).t); }
    const edges = [];   // { u, v, line }
    const seen = new Set();
    for (const l of good) {
        const ts = [...new Set(cuts.get(l))].sort((x, y) => x - y);
        let prev = vertexAt(l.a);
        for (let k = 1; k < ts.length; k++) {
            const p = k === ts.length - 1 ? l.b : [l.a[0] + (l.b[0] - l.a[0]) * ts[k], l.a[1] + (l.b[1] - l.a[1]) * ts[k]];
            const v = vertexAt(p);
            if (v !== prev) {
                const key = prev < v ? `${prev}-${v}` : `${v}-${prev}`;
                if (!seen.has(key)) { seen.add(key); edges.push({ u: prev, v, line: l }); }
            }
            prev = v;
        }
    }

    // 5. faces, by walking half-edges (always turning to the next edge clockwise)
    const out = verts.map(() => []);
    const half = [];
    for (const e of edges) {
        for (const [u, v] of [[e.u, e.v], [e.v, e.u]]) {
            const h = { u, v, edge: e, angle: Math.atan2(verts[v][1] - verts[u][1], verts[v][0] - verts[u][0]), face: -1 };
            half.push(h); out[u].push(h);
        }
    }
    for (const list of out) list.sort((x, y) => x.angle - y.angle);
    const twin = h => out[h.v].find(g => g.v === h.u && g.edge === h.edge);
    const next = h => {
        const list = out[h.v], i = list.indexOf(twin(h));
        return list[(i - 1 + list.length) % list.length];
    };
    const rawFaces = [];
    for (const h of half) {
        if (h.face >= 0) continue;
        const id = rawFaces.length, poly = [], hs = [];
        let g = h, guard = 0;
        while (g.face < 0 && guard++ < half.length + 2) { g.face = id; poly.push(verts[g.u]); hs.push(g); g = next(g); }
        rawFaces.push({ id, poly, hs, area: polygonArea(poly) });
    }

    // components (for telling outer boundaries from rooms and nesting one building part in a room)
    const parent = verts.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const e of edges) parent[find(e.u)] = find(e.v);

    const bounded = rawFaces.filter(f => f.area > MIN_FACE_AREA);
    // Smallest enclosed area containing p, optionally ignoring one component.
    const smallestContaining = (p, skipComponent) => {
        let best = null;
        for (const f of bounded) {
            if (skipComponent !== undefined && find(f.hs[0].u) === skipComponent) continue;
            if (pointInPolygon(p, f.poly) && (!best || f.area < best.area)) best = f;
        }
        return best;
    };
    // Outer boundary of a component that sits inside a room of another component is a hole of that room.
    const container = new Map();   // raw face id -> bounded face (or null = outside)
    for (const f of rawFaces) {
        if (f.area > MIN_FACE_AREA) continue;
        const comp = find(f.hs[0].u);
        container.set(f.id, smallestContaining(verts[f.hs[0].u], comp));
    }
    const resolve = f => (f.area > MIN_FACE_AREA ? f : container.get(f.id) || null);

    const faces = bounded.map(f => ({ id: f.id, poly: f.poly, area: f.area, holes: [], roomId: null, name: '', void: false, door: false }));
    const faceById = new Map(faces.map(f => [f.id, f]));
    for (const f of rawFaces) {
        const c = f.area > MIN_FACE_AREA ? null : container.get(f.id);
        if (c && Math.abs(f.area) > MIN_FACE_AREA) faceById.get(c.id).holes.push(f.poly);
    }
    const roomAt = p => {
        const f = smallestContaining(p);
        return f ? faceById.get(f.id) : null;
    };

    // 6. room names and void markers
    const named = new Map();   // face id -> room label or void marker
    for (const r of floor.rooms || []) {
        const f = roomAt(r.at);
        if (!f) { add(r.void ? 'void-outside' : 'name-outside', r.void ? 'This void marker is not inside an enclosed area.' : 'This room name is not inside a room.', r.at, [r.id]); continue; }
        if (named.has(f.id)) {
            const o = named.get(f.id);
            if (r.void && o.void) add('void-twice', 'This space has two void markers.', r.at, [r.id, o.id]);
            else if (r.void || o.void) add('void-named', 'This space has a room name and a void marker. It is either a room or void.', r.at, [r.id, o.id]);
            else add('name-twice', 'A room has two names.', r.at, [r.id, o.id]);
            continue;
        }
        named.set(f.id, r);
        f.roomId = r.id;
        if (r.void) { f.void = true; continue; }
        f.name = (r.name || '').trim();
        if (!f.name) add('name-empty', 'Give this room a name.', r.at, [r.id]);
    }
    for (const f of faces) if (!named.has(f.id)) add('unnamed', 'This room has no name. Name it, or mark it as void.', interiorPoint(f.poly, f.holes), []);
    const byName = new Map();
    for (const f of faces) {
        if (!f.name) continue;
        const key = f.name.toLowerCase();
        if (byName.has(key)) add('name-dup', `Two rooms on this floor are called "${f.name}".`, (floor.rooms.find(r => r.id === f.roomId) || {}).at || interiorPoint(f.poly), [f.roomId, byName.get(key).roomId]);
        else byName.set(key, f);
    }

    // 7. doors: what they connect, and whether every room can be reached
    const doorSides = new Map();
    const links = new Map(faces.map(f => [f.id, new Set()]));
    const voidDoors = new Map();   // void face id -> its door line ids
    for (const e of edges) {
        if (e.line.type !== 'door') continue;
        const hs = half.filter(h => h.edge === e);
        const sides = hs.map(h => resolve(rawFaces[h.face]));
        const ids = sides.map(s => (s ? s.id : 'outside'));
        doorSides.set(e.line.id, ids);
        for (const raw of sides) if (raw) {
            const s = faceById.get(raw.id);
            s.door = true;
            if (s.void) { if (!voidDoors.has(s.id)) voidDoors.set(s.id, new Set()); voidDoors.get(s.id).add(e.line.id); }
        }
        if (ids[0] === ids[1]) {
            const mid = [(verts[e.u][0] + verts[e.v][0]) / 2, (verts[e.u][1] + verts[e.v][1]) / 2];
            add('door-nowhere', 'This door has the same room on both sides.', mid, [e.line.id]);
        } else if (ids[0] !== 'outside' && ids[1] !== 'outside') {
            links.get(ids[0]).add(ids[1]); links.get(ids[1]).add(ids[0]);
        }
    }
    for (const [id, doors] of voidDoors) {
        const f = faceById.get(id);
        add('void-door', 'A void cannot have doors. This space has one, so it must be a room.', (floor.rooms.find(r => r.id === f.roomId) || {}).at || interiorPoint(f.poly, f.holes), [f.roomId, ...doors]);
    }
    const rooms = faces.filter(f => !f.void);
    if (rooms.length > 1) {
        const groups = [], done = new Set();
        for (const f of rooms) {
            if (done.has(f.id)) continue;
            const g = [], stack = [f.id];
            done.add(f.id);
            while (stack.length) { const c = stack.pop(); g.push(c); for (const n of links.get(c)) if (!done.has(n) && !faceById.get(n).void) { done.add(n); stack.push(n); } }
            groups.push(g);
        }
        if (groups.length > 1) {
            groups.sort((x, y) => y.length - x.length);
            for (const g of groups.slice(1)) {
                const f = faceById.get(g[0]);
                const names = g.map(id => faceById.get(id).name || 'an unnamed room').join(', ');
                add('sealed', `No door leads from the other rooms to: ${names}.`, (floor.rooms.find(r => r.id === f.roomId) || {}).at || interiorPoint(f.poly), []);
            }
        }
    }

    // 8. task pins
    for (const pin of floor.pins || []) {
        const f = roomAt(pin.at);
        if (!f) add('pin-outside', `Task ${pin.code} is not inside a room.`, pin.at, [pin.id]);
        else if (f.void) add('pin-void', `Task ${pin.code} is inside a void. Tasks go in rooms.`, pin.at, [pin.id]);
    }

    return { problems, faces, roomAt, doorSides };
}

// ---- whole plan ------------------------------------------------------------------------------------
// units: [{ id, name, parts: [{ code, name }] }] - every task the server knows; a unit's parts are all
// its QR codes (a bound chain, a repeating task, or a single code).
// Returns { problems: [{ floor, code, message, at, ids }], placements: Map code -> { floor, room } }.
export function validatePlan(plan, units) {
    const problems = [];
    const placements = new Map();
    const floors = (plan && plan.floors) || [];
    const add = (floor, code, message, at = null, ids = []) => problems.push({ floor, code, message, at, ids });
    if (!floors.length) add(null, 'no-floors', 'Add at least one floor.');
    const floorNames = new Map();
    const known = new Map();
    for (const u of units || []) for (const p of u.parts) known.set(p.code, u);

    for (const floor of floors) {
        const name = (floor.name || '').trim();
        if (!name) add(floor.id, 'floor-name', 'Give this floor a name.');
        else if (floorNames.has(name.toLowerCase())) add(floor.id, 'floor-dup', `Two floors are called "${name}".`);
        else floorNames.set(name.toLowerCase(), floor);
        const a = analyzeFloor(floor);
        for (const p of a.problems) problems.push({ floor: floor.id, ...p });
        if (!a.faces.some(f => !f.void)) add(floor.id, 'no-rooms', `${name || 'This floor'} has no rooms yet.`);
        for (const pin of floor.pins || []) {
            if (!known.has(pin.code)) { add(floor.id, 'pin-unknown', `There is no task called ${pin.code}.`, pin.at, [pin.id]); continue; }
            if (placements.has(pin.code)) { add(floor.id, 'pin-twice', `Task ${pin.code} is placed twice.`, pin.at, [pin.id]); continue; }
            const room = a.roomAt(pin.at);
            placements.set(pin.code, { floor: floor.id, floorName: name, room: room ? room.name : '' });
        }
    }
    for (const u of units || []) {
        const placed = u.parts.filter(p => placements.has(p.code));
        if (placed.length && placed.length < u.parts.length) {
            const missing = u.parts.filter(p => !placements.has(p.code)).map(p => p.code).join(', ');
            add(null, 'unit-partial', `${u.name}: place every part or none. Missing: ${missing}.`);
        }
    }
    return { problems, placements };
}
