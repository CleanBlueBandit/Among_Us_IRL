// Tasks live in the "minigames" folder at the project root: every .html file there is one task and the
// file name (without ".html") is its task.id. Nothing to import.
//   minigames/wires.html  ->  task.id "wires", name "Wires"
// Files starting with "_" are ignored (handy for templates / unfinished games).
//
// tasks.json (project root, optional) sets each task's location and binds tasks together:
//   {
//     "locations": { "wires": "Electrical" },
//     "binds": { "refuel_tank": "fuel_engine" }      // refuel_tank must be done before fuel_engine
//   }
// A bind's value can also be a list: { "a": ["b", "c"] }. Whoever gets a bound task also gets the
// task(s) it depends on. A location in tasks.json wins over <meta name="location" content="..."> in
// the minigame's <head>, which still works as a fallback.
//
// Each task is scanned through a random secret token (/task/<token>) that the server generates by itself
// the first time it sees the task. Tokens are saved in tokens.json so printed QR codes stay valid across
// restarts, and tasks.txt ("task_id:" then its link, for every task) is rewritten whenever it changes.
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

// Returns { locations: {id: string}, binds: {id: [dependent ids]} }; a missing or broken file means no config.
export async function readTaskConfig() {
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') warnOnce(`Could not read tasks.json (${e.message}); ignoring it.`);
        return { locations: {}, binds: {} };
    }
    const locations = {};
    const binds = {};
    if (parsed && typeof parsed.locations === 'object' && parsed.locations) {
        for (const [id, loc] of Object.entries(parsed.locations)) {
            if (typeof loc === 'string') locations[id] = loc.trim();
        }
    }
    if (parsed && typeof parsed.binds === 'object' && parsed.binds) {
        for (const [id, deps] of Object.entries(parsed.binds)) {
            const list = (Array.isArray(deps) ? deps : [deps]).filter(d => typeof d === 'string' && d && d !== id);
            if (list.length) binds[id] = list;
        }
    }
    return { locations, binds };
}

// Returns [{ id, name, location, file, requires: [ids] }] sorted by id.
// `requires` lists the tasks that must be done before this one (from the binds in tasks.json).
export async function readTasks() {
    let files;
    try {
        files = await fs.readdir(MINIGAMES_DIR);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const config = await readTaskConfig();

    const tasks = [];
    for (const file of files.sort()) {
        if (file.startsWith('_') || file.startsWith('.') || path.extname(file).toLowerCase() !== '.html') continue;
        const id = path.parse(file).name;
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            warnOnce(`Skipping minigames/${file}: file names may only use letters, numbers, "-" and "_" (they become URLs).`);
            continue;
        }
        const location = config.locations[id] ?? await readMetaLocation(path.join(MINIGAMES_DIR, file));
        tasks.push({ id, name: prettify(id), location, file, requires: [] });
    }

    const byId = new Map(tasks.map(t => [t.id, t]));
    for (const id of Object.keys(config.locations)) {
        if (!byId.has(id)) warnOnce(`tasks.json: location set for "${id}", but there is no minigames/${id}.html.`);
    }
    for (const [first, deps] of Object.entries(config.binds)) {
        for (const dep of deps) {
            if (!byId.has(dep)) { warnOnce(`tasks.json: bind "${first}" -> "${dep}": there is no minigames/${dep}.html.`); continue; }
            if (!byId.has(first)) warnOnce(`tasks.json: bind "${first}" -> "${dep}": there is no minigames/${first}.html, so "${dep}" will never be assigned.`);
            byId.get(dep).requires.push(first);
        }
    }
    return tasks;
}

// ---- tokens ----------------------------------------------------------------------------------------

let tokenMap = null;               // { [task.id]: token }, loaded once, then kept in memory
let queue = Promise.resolve();     // serialises token creation so two scans can't invent different tokens
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

// tasks.txt:
//   wires:
//   http://192.168.1.20:8812/task/9f1c...
export function formatLinks(tasks, map) {
    const blocks = tasks.filter(t => map[t.id]).map(t => `${t.id}:\n${baseUrl()}/task/${map[t.id]}`);
    return blocks.join('\n') + (blocks.length ? '\n' : '');
}

async function writeLinks(tasks, map) {
    const text = formatLinks(tasks, map);
    if (text === lastLinks) return;
    let onDisk = null;
    try { onDisk = await fs.readFile(LINKS_FILE, 'utf-8'); } catch { /* missing */ }
    if (onDisk !== text) await fs.writeFile(LINKS_FILE, text, 'utf-8');
    lastLinks = text;
}

// Gives every task a token (creating missing ones) and returns the tasks with `token` attached.
// Pass { rotate: true } to throw all tokens away and issue new ones (old QR codes stop working).
// Tokens of tasks whose file is missing are kept, so restoring a file doesn't invalidate its QR code.
export function readTasksWithTokens({ rotate = false } = {}) {
    const run = async () => {
        const tasks = await readTasks();
        const map = await loadTokenMap();
        let changed = false;
        for (const t of tasks) {
            if (rotate || !map[t.id]) {
                map[t.id] = crypto.randomBytes(12).toString('hex');
                changed = true;
            }
        }
        if (changed) await fs.writeFile(TOKENS_FILE, JSON.stringify(map, null, 2), 'utf-8');
        await writeLinks(tasks, map);
        return tasks.map(t => ({ ...t, token: map[t.id] }));
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

export { baseUrl };
