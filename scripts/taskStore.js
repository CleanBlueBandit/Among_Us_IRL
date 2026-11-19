// Tasks live in the "minigames" folder at the project root: every .html file there is one minigame and
// the file name (without ".html") is its id. Nothing to import.
//   minigames/wires.html  ->  id "wires", name "Wires"
// Files starting with "_" are ignored (handy for templates / unfinished games).
//
// tasks.json (project root) configures them:
//   {
//     "tasks": {
//       "swipe_card":  { "enabled": true, "repeat": 1, "location": "Admin" },
//       "wires":       { "enabled": true, "repeat": 3, "location": ["Electrical", "Storage", "Kitchen"] }
//     },
//     "binds": { "refuel_tank": "fuel_engine" }
//   }
// - Every minigame gets an entry automatically (enabled, repeat 1, empty location).
// - "repeat": N makes a repeating task: N QR codes, done one after another, counting as ONE task.
//   Its "location" is then a list with one place per QR code.
// - "binds": "refuel_tank": "fuel_engine" chains two minigames into ONE task: refuel_tank first, and
//   fuel_engine only appears once it is done. A list chains more: "a": ["b", "c"] is a, then b, then c.
// - A location left empty falls back to the minigame's <meta name="location" content="..."> (for
//   tasks that don't repeat).
//
// Each QR code is a random secret token (/task/<token>) that the server makes by itself. Tokens are
// saved in tokens.json so printed codes stay valid across restarts; tasks.txt ("<code name>:" then the
// link, for every QR code of every enabled task) is rewritten when it changes.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const MINIGAMES_DIR = path.join(ROOT, 'minigames');
export const CONFIG_FILE = path.join(ROOT, 'tasks.json');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const LINKS_FILE = path.join(ROOT, 'tasks.txt');
const MAX_REPEAT = 20;

// Tasks are re-read on every scan, so each config problem is only logged once.
const warned = new Set();
function warnOnce(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn(msg);
}

// "calibrate_power" -> "Calibrate power"
function prettify(id) {
    const s = id.replace(/[-_]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// <meta name="location" content="..."> in the minigame's <head>: its default location.
async function readMetaLocation(file) {
    const fh = await fs.open(file, 'r');
    try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const head = buf.toString('utf-8', 0, bytesRead);
        const m = head.match(/<meta\s+name=["']location["']\s+content=["']([^"']*)["']/i);
        return m ? m[1].trim() : '';
    } finally {
        await fh.close();
    }
}

async function listMinigames() {
    let files;
    try {
        files = await fs.readdir(MINIGAMES_DIR);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const found = [];
    for (const file of files.sort()) {
        if (file.startsWith('_') || file.startsWith('.') || path.extname(file).toLowerCase() !== '.html') continue;
        const id = path.parse(file).name;
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            warnOnce(`Skipping minigames/${file}: file names may only use letters, numbers, "-" and "_" (they become URLs).`);
            continue;
        }
        found.push({ id, file });
    }
    return found;
}

// ---- tasks.json ------------------------------------------------------------------------------------

// Reads tasks.json as written by the owner. Returns null when the file exists but can't be parsed,
// so a typo never gets overwritten by the automatic additions below.
async function readConfigFile() {
    let text;
    try {
        text = await fs.readFile(CONFIG_FILE, 'utf-8');
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        warnOnce(`Could not read tasks.json (${e.message}). Fix it; until then every task is switched on, with no location, no repeats and no binds.`);
        return null;
    }
}

// One entry, tidied: { enabled, repeat, location } where location is a string, or a list with one
// place per QR code when repeat > 1. Other keys the owner added are kept.
function normaliseEntry(e) {
    e = e && typeof e === 'object' && !Array.isArray(e) ? e : {};
    const repeat = Number.isInteger(e.repeat) ? Math.min(MAX_REPEAT, Math.max(1, e.repeat)) : 1;
    let location;
    if (repeat > 1) {
        const list = Array.isArray(e.location) ? e.location.map(l => (typeof l === 'string' ? l : ''))
            : [typeof e.location === 'string' ? e.location : ''];
        while (list.length < repeat) list.push('');
        location = list;                         // extra entries beyond "repeat" are kept, just unused
    } else {
        location = Array.isArray(e.location) ? (typeof e.location[0] === 'string' ? e.location[0] : '')
            : (typeof e.location === 'string' ? e.location : '');
    }
    return { ...e, enabled: e.enabled !== false, repeat, location };
}

// Makes sure every minigame has an entry and every entry is tidy; moves an older
// "locations": { id: "..." } section into the entries. Returns { config, changed }.
function completeConfig(raw, ids) {
    const config = { tasks: {}, binds: {} };
    let changed = false;
    if (raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks)) {
        for (const [id, entry] of Object.entries(raw.tasks)) {
            config.tasks[id] = normaliseEntry(entry);
            if (JSON.stringify(config.tasks[id]) !== JSON.stringify(entry)) changed = true;
        }
    } else if (raw.tasks !== undefined) {
        warnOnce('tasks.json: "tasks" should be an object like { "wires": { "enabled": true, "repeat": 1, "location": "" } }; rebuilding it.');
        changed = true;
    }
    if (raw.locations && typeof raw.locations === 'object') {
        for (const [id, loc] of Object.entries(raw.locations)) {
            if (typeof loc !== 'string') continue;
            const e = config.tasks[id] || (config.tasks[id] = normaliseEntry({}));
            if (!e.location) e.location = loc;
        }
        changed = true;   // the old "locations" section is dropped when the file is written back
    }
    for (const id of ids) {
        if (!config.tasks[id]) {
            config.tasks[id] = normaliseEntry({});
            changed = true;
        }
    }
    if (raw.binds && typeof raw.binds === 'object' && !Array.isArray(raw.binds)) config.binds = raw.binds;
    for (const [key, value] of Object.entries(raw)) {
        if (!['tasks', 'binds', 'locations'].includes(key)) config[key] = value;   // keep anything else the owner added
    }
    return { config, changed };
}

// tasks.json is written with one line per task, so it stays easy to edit by hand.
function formatConfig(config) {
    const ids = Object.keys(config.tasks);
    const lines = ['{', '  "tasks": {'];
    ids.forEach((id, i) => {
        const e = config.tasks[id];
        const extra = Object.entries(e).filter(([k]) => !['enabled', 'repeat', 'location'].includes(k))
            .map(([k, v]) => `, ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join('');
        lines.push(`    ${JSON.stringify(id)}: { "enabled": ${e.enabled}, "repeat": ${e.repeat}, "location": ${JSON.stringify(e.location).replace(/","/g, '", "')}${extra} }${i < ids.length - 1 ? ',' : ''}`);
    });
    lines.push('  },');
    const rest = Object.entries(config).filter(([k]) => k !== 'tasks');
    rest.forEach(([k, v], i) => {
        lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}${i < rest.length - 1 ? ',' : ''}`);
    });
    lines.push('}', '');
    return lines.join('\n');
}

// ---- tasks, chains and units -----------------------------------------------------------------------

// Returns { tasks, units } (see readLibrary). New minigames are added to tasks.json here.
async function readTasks() {
    const found = await listMinigames();
    const raw = await readConfigFile();

    let config;
    if (raw === null) {
        config = { tasks: {}, binds: {} };
    } else {
        const done = completeConfig(raw, found.map(f => f.id));
        config = done.config;
        if (done.changed) await fs.writeFile(CONFIG_FILE, formatConfig(config), 'utf-8');
    }

    const tasks = [];
    for (const { id, file } of found) {
        const entry = config.tasks[id] || normaliseEntry({});
        const repeat = entry.repeat;
        const steps = [];
        for (let n = 1; n <= repeat; n++) {
            let location = (repeat > 1 ? entry.location[n - 1] : entry.location).trim();
            let locationFrom = location ? 'tasks.json' : '';
            if (!location && repeat === 1) {
                location = await readMetaLocation(path.join(MINIGAMES_DIR, file));
                if (location) locationFrom = 'meta';
            }
            steps.push({
                n,
                key: n === 1 ? id : `${id}#${n}`,                  // token key: step 1 keeps the plain id
                label: repeat > 1 ? `${id}#${n}` : id,             // how the QR code is named in tasks.txt
                location, locationFrom
            });
        }
        tasks.push({ id, name: prettify(id), file, enabled: entry.enabled, repeat, steps, next: null, prev: null });
    }

    // binds -> chains (a, then b, then c)
    const byId = new Map(tasks.map(t => [t.id, t]));
    const blocked = new Map();   // id -> reason it can't be handed out
    for (const [first, deps] of Object.entries(config.binds || {})) {
        const seq = [first, ...(Array.isArray(deps) ? deps : [deps])].filter(d => typeof d === 'string' && d);
        for (let i = 0; i + 1 < seq.length; i++) {
            const a = seq[i], b = seq[i + 1];
            if (a === b) continue;
            if (!byId.has(b)) { warnOnce(`tasks.json: bind "${a}" -> "${b}": there is no minigames/${b}.html.`); break; }
            if (!byId.has(a)) {
                warnOnce(`tasks.json: bind "${a}" -> "${b}": there is no minigames/${a}.html, so "${b}" will never be handed out.`);
                blocked.set(b, `needs ${a}, which has no minigame`);
                break;
            }
            const ta = byId.get(a), tb = byId.get(b);
            if ((ta.next && ta.next !== b) || (tb.prev && tb.prev !== a)) {
                warnOnce(`tasks.json: bind "${a}" -> "${b}" ignored: ${ta.next && ta.next !== b ? `"${a}" already leads to "${ta.next}"` : `"${b}" already follows "${tb.prev}"`}. A task can be in only one chain.`);
                continue;
            }
            ta.next = b; tb.prev = a;
        }
    }

    // units: what a player is handed. A task on its own, or a whole chain; each counts as one task.
    const units = [];
    const inUnit = new Set();
    for (const t of tasks) {
        if (t.prev) continue;
        const chain = [];
        for (let cur = t, guard = 0; cur && guard < tasks.length + 1; cur = cur.next ? byId.get(cur.next) : null, guard++) {
            if (chain.includes(cur)) break;
            chain.push(cur);
        }
        chain.forEach(c => inUnit.add(c.id));
        let problem = '';
        for (const c of chain) {
            if (!c.enabled) { problem = `${c.id} is switched off`; break; }
            if (blocked.has(c.id)) { problem = `${c.id} ${blocked.get(c.id)}`; break; }
        }
        units.push({
            id: chain.map(c => c.id).join('>'),
            tasks: chain.map(c => c.id),
            steps: chain.flatMap(c => c.steps.map(s => ({ task: c.id, n: s.n, of: c.repeat }))),
            usable: !problem,
            problem
        });
    }
    for (const t of tasks) {
        if (!inUnit.has(t.id)) warnOnce(`tasks.json: "${t.id}" is in a bind loop, so it is never handed out.`);
    }
    for (const id of Object.keys(config.tasks)) {
        if (!byId.has(id)) warnOnce(`tasks.json: "${id}" is listed, but there is no minigames/${id}.html.`);
    }
    return { tasks, units };
}

// ---- tokens ----------------------------------------------------------------------------------------

let tokenMap = null;               // { [step key]: token }, loaded once, then kept in memory
let queue = Promise.resolve();     // serialises reads/writes so two scans can't race each other
let lastLinks = null;              // what tasks.txt was last written with

async function loadTokenMap() {
    if (tokenMap) return tokenMap;
    try {
        const parsed = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf-8'));
        tokenMap = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Could not read tokens.json (${e.message}), starting fresh.`);
        tokenMap = {};
    }
    return tokenMap;
}

function baseUrl() {
    return `${process.env.PROTOCOL || 'http'}://${process.env.IP || 'localhost'}:${process.env.PORT || 8080}`;
}

// tasks.txt, every QR code of every enabled task:
//   swipe_card:
//   http://192.168.1.20:8812/task/9f1c...
//   wires#1:
//   http://192.168.1.20:8812/task/03ab...
export function formatLinks(tasks) {
    const blocks = [];
    for (const t of tasks) {
        if (!t.enabled) continue;
        for (const s of t.steps) if (s.token) blocks.push(`${s.label}:\n${baseUrl()}/task/${s.token}`);
    }
    return blocks.join('\n') + (blocks.length ? '\n' : '');
}

async function writeLinks(tasks) {
    const text = formatLinks(tasks);
    if (text === lastLinks) return;
    let onDisk = null;
    try { onDisk = await fs.readFile(LINKS_FILE, 'utf-8'); } catch { /* missing */ }
    if (onDisk !== text) await fs.writeFile(LINKS_FILE, text, 'utf-8');
    lastLinks = text;
}

// Everything the server needs about tasks, with a token on every QR code (step):
//   tasks: [{ id, name, file, enabled, repeat, next, prev, steps: [{ n, key, label, location, locationFrom, token }] }]
//   units: [{ id, tasks: [ids], steps: [{ task, n, of }], usable, problem }]
//   byId: Map id -> task;  byToken: Map token -> { task, step }
// Disabled tasks keep their tokens, so switching one back on doesn't need new QR codes.
// Pass { rotate: true } to throw all tokens away and issue new ones (old QR codes stop working).
export function readLibrary({ rotate = false } = {}) {
    const run = async () => {
        const { tasks, units } = await readTasks();
        const map = await loadTokenMap();
        let changed = false;
        for (const t of tasks) {
            for (const s of t.steps) {
                if (rotate || !map[s.key]) { map[s.key] = crypto.randomBytes(12).toString('hex'); changed = true; }
                s.token = map[s.key];
            }
        }
        if (changed) await fs.writeFile(TOKENS_FILE, JSON.stringify(map, null, 2), 'utf-8');
        await writeLinks(tasks);
        const byId = new Map(tasks.map(t => [t.id, t]));
        const byToken = new Map();
        for (const t of tasks) for (const s of t.steps) byToken.set(s.token, { task: t, step: s });
        return { tasks, units, byId, byToken };
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

// Sets "enabled" and "location" of tasks in tasks.json (used by the floor plan editor's save).
// updates: { [taskId]: { enabled: bool, location: string | string[] } }. Other entries and binds are kept.
export function updateTaskConfig(updates) {
    const run = async () => {
        const raw = await readConfigFile();
        if (raw === null) throw new Error('tasks.json has a syntax error; fix it before saving the floor plan.');
        const found = await listMinigames();
        const { config } = completeConfig(raw, found.map(f => f.id));
        for (const [id, u] of Object.entries(updates)) {
            const e = config.tasks[id] || normaliseEntry({});
            config.tasks[id] = normaliseEntry({ ...e, enabled: u.enabled, location: u.location });
        }
        await fs.writeFile(CONFIG_FILE, formatConfig(config), 'utf-8');
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

export { baseUrl };
