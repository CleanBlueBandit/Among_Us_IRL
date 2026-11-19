// Usage: npm run verify:floorplan
// Checks the floor plan rules (public/editor/geometry.js) on hand-built plans. Exits 1 if any check fails.
import { analyzeFloor, validatePlan } from '../public/editor/geometry.js';

let n = 0, failed = 0;
const W = (a, b) => ({ id: 'l' + (n++), type: 'wall', a, b });
const D = (a, b) => ({ id: 'l' + (n++), type: 'door', a, b });
const R = (name, at) => ({ id: 'r' + (n++), name, at });
const rect = (x0, y0, x1, y1) => [W([x0, y0], [x1, y0]), W([x1, y0], [x1, y1]), W([x1, y1], [x0, y1]), W([x0, y1], [x0, y0])];
const codes = f => analyzeFloor(f).problems.map(p => p.code).sort().join(',') || 'ok';
function check(label, got, want) {
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${got}${ok ? '' : `   (expected ${want})`}`);
}
const twoRooms = door => [
    W([0, 0], [400, 0]), W([400, 0], [800, 0]), W([800, 0], [800, 300]), W([800, 300], [400, 300]), W([400, 300], [0, 300]), W([0, 300], [0, 0]),
    ...(door ? [W([400, 0], [400, 120]), D([400, 120], [400, 200]), W([400, 200], [400, 300])] : [W([400, 0], [400, 300])])
];
const closet = [W([150, 100], [250, 100]), W([250, 100], [250, 200]), W([250, 200], [200, 200]), D([200, 200], [160, 200]), W([160, 200], [150, 200]), W([150, 200], [150, 100])];

check('one named room', codes({ lines: rect(0, 0, 400, 300), rooms: [R('Kitchen', [100, 100])] }), 'ok');
check('a room needs a name', codes({ lines: rect(0, 0, 400, 300), rooms: [] }), 'unnamed');
check('an empty name is not a name', codes({ lines: rect(0, 0, 400, 300), rooms: [R(' ', [100, 100])] }), 'name-empty');
check('two rooms joined by a door', codes({ lines: twoRooms(true), rooms: [R('A', [100, 100]), R('B', [600, 100])] }), 'ok');
check('two rooms split by a wall only', codes({ lines: twoRooms(false), rooms: [R('A', [100, 100]), R('B', [600, 100])] }), 'sealed');
check('room names are unique on a floor', codes({ lines: twoRooms(true), rooms: [R('A', [100, 100]), R('a', [600, 100])] }), 'name-dup');
check('a room has one name', codes({ lines: rect(0, 0, 400, 300), rooms: [R('A', [100, 100]), R('B', [200, 100])] }), 'name-twice');
check('a name must be inside a room', codes({ lines: rect(0, 0, 400, 300), rooms: [R('A', [100, 100]), R('B', [900, 100])] }), 'name-outside');
check('wall ends must connect', codes({ lines: [...rect(0, 0, 400, 300), W([200, 0], [200, 120])], rooms: [R('A', [100, 100])] }), 'loose');
check('a wall on another wall\'s middle splits a room', codes({ lines: [...rect(0, 0, 400, 300), W([200, 0], [200, 300])], rooms: [R('A', [100, 100]), R('B', [300, 100])] }), 'sealed');
check('a door from a wall end to a wall\'s middle', codes({ lines: [...rect(0, 0, 400, 300), W([200, 0], [200, 120]), D([200, 120], [200, 300])], rooms: [R('A', [100, 100]), R('B', [300, 100])] }), 'ok');
check('an entrance door to the outside', codes({ lines: [W([0, 0], [150, 0]), D([150, 0], [250, 0]), W([250, 0], [400, 0]), W([400, 0], [400, 300]), W([400, 300], [0, 300]), W([0, 300], [0, 0])], rooms: [R('Hall', [100, 100])] }), 'ok');
check('a door end may touch only one wall', codes({ lines: [...rect(0, 0, 400, 300), D([0, 0], [100, 100]), W([100, 100], [150, 100])], rooms: [R('A', [300, 200])] }), 'door-crowded,door-nowhere,loose');
check('a door cannot connect to a door', codes({ lines: [W([0, 0], [100, 0]), D([100, 0], [200, 0]), D([200, 0], [300, 0]), W([300, 0], [400, 0]), W([400, 0], [400, 300]), W([400, 300], [0, 300]), W([0, 300], [0, 0])], rooms: [R('A', [100, 100])] }), 'door-door,door-door');
check('nothing connects to a door\'s middle', codes({ lines: [W([0, 0], [100, 0]), D([100, 0], [300, 0]), W([300, 0], [400, 0]), W([400, 0], [400, 300]), W([400, 300], [0, 300]), W([0, 300], [0, 0]), W([200, 0], [200, 300])], rooms: [R('A', [50, 100]), R('B', [300, 100])] }), 'door-middle,sealed');
check('a door cannot cross a line', codes({ lines: [...rect(0, 0, 400, 300), W([200, 0], [200, 300]), D([100, 150], [300, 150])], rooms: [R('A', [50, 100]), R('B', [300, 100])] }), 'door-cross,door-nowhere,loose-door,loose-door,sealed');
check('lines cannot overlap', codes({ lines: [...rect(0, 0, 400, 300), W([100, 0], [300, 0])], rooms: [R('A', [100, 100])] }), 'overlap');
check('crossing walls make four rooms', codes({ lines: [...rect(0, 0, 400, 400), W([200, 0], [200, 400]), W([0, 200], [400, 200])], rooms: [R('A', [100, 100]), R('B', [300, 100]), R('C', [100, 300]), R('D', [300, 300])] }), 'sealed,sealed,sealed');
check('a closet with a door inside a room', codes({ lines: [...rect(0, 0, 400, 300), ...closet], rooms: [R('Room', [50, 50]), R('Closet', [200, 150])] }), 'ok');
check('a closet without a door', codes({ lines: [...rect(0, 0, 400, 300), ...rect(150, 100, 250, 200)], rooms: [R('Room', [50, 50]), R('Closet', [200, 150])] }), 'sealed');
check('a task must be inside a room', codes({ lines: rect(0, 0, 400, 300), rooms: [R('A', [100, 100])], pins: [{ id: 'p', code: 'wires#1', at: [900, 0] }] }), 'pin-outside');

const units = [
    { id: 'refuel_tank>fuel_engine', name: 'Refuel tank → Fuel engine', parts: [{ code: 'refuel_tank' }, { code: 'fuel_engine' }] },
    { id: 'swipe_card', name: 'Swipe card', parts: [{ code: 'swipe_card' }] }
];
const floor = { id: 'f1', name: 'Ground', lines: twoRooms(true), rooms: [R('Kitchen', [100, 100]), R('Garage', [600, 100])], pins: [{ id: 'p1', code: 'refuel_tank', at: [600, 200] }] };
check('a bound task needs every part', validatePlan({ floors: [floor] }, units).problems.map(p => p.code).join(',') || 'ok', 'unit-partial');
floor.pins.push({ id: 'p2', code: 'fuel_engine', at: [150, 250] });
const done = validatePlan({ floors: [floor] }, units);
check('every part placed', done.problems.map(p => p.code).join(',') || 'ok', 'ok');
check('placements know their room', [...done.placements].map(([c, p]) => `${c}@${p.room}`).join(' '), 'refuel_tank@Garage fuel_engine@Kitchen');
check('a floor needs a name', validatePlan({ floors: [{ ...floor, name: '' }] }, units).problems.map(p => p.code).join(','), 'floor-name');

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
