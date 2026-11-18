// Tasks live in the "minigames" folder at the project root: every .html file there is one task and the
// file name (without ".html") is its task.id. Nothing to import.
//   minigames/wires.html  ->  task.id "wires", name "Wires"
// Files starting with "_" are ignored (handy for templates / unfinished games).
//
// tasks.json (project root) configures them:
//   {
//     "tasks": {
//       "wires":       { "enabled": true, "location": "Electrical" },
//       "refuel_tank": { "enabled": true, "location": "" }
//     },
//     "binds": { "refuel_tank": "fuel_engine" }      // refuel_tank must be done before fuel_engine
//   }
// Every minigame gets an entry automatically (enabled, empty location) the first time the server sees
// it. A task's location is the "location" in tasks.json, or, while that is empty, the
// <meta name="location" content="..."> in the minigame's <head>. Disabled tasks are never handed out, can't be
// scanned and are left out of tasks.txt. A bind's value can also be a list: { "a": ["b", "c"] }.
// Whoever gets a bound task also gets the task(s) it depends on.
//
// Each task is scanned through a random secret token (/task/<token>) that the server generates by itself
// the first time it sees the task. Tokens are saved in tokens.json so printed QR codes stay valid across
// restarts, and tasks.txt ("task_id:" then its link, for every enabled task) is rewritten when it changes.
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

async function listMinigameIds() {
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
        warnOnce(`Could not read tasks.json (${e.message}). Fix it; until then every task is switched on, with no location and no binds.`);
        return null;
    }
}

// Makes sure every minigame has an entry, and moves an older "locations": { id: "..." } section into
// the entries. Returns { config, changed }.
function completeConfig(raw, ids) {
    const config = { tasks: {}, binds: {} };
    let changed = false;
    if (raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks)) {
        for (const [id, entry] of Object.entries(raw.tasks)) {
            const e = entry && typeof entry === 'object' ? entry : {};
            config.tasks[id] = { ...e, enabled: e.enabled !== false, location: typeof e.location === 'string' ? e.location : '' };
            if (e.enabled !== config.tasks[id].enabled || e.location !== config.tasks[id].location) changed = true;
        }
    } else if (raw.tasks !== undefined) {
        warnOnce('tasks.json: "tasks" should be an object like { "wires": { "enabled": true, "location": "" } }; rebuilding it.');
        changed = true;
    }
    if (raw.locations && typeof raw.locations === 'object') {
        for (const [id, loc] of Object.entries(raw.locations)) {
            if (typeof loc !== 'string') continue;
            const e = config.tasks[id] || (config.tasks[id] = { enabled: true, location: '' });
            if (!e.location) e.location = loc;
        }
        changed = true;   // the old "locations" section is dropped when the file is written back
    }
    for (const id of ids) {
        if (!config.tasks[id]) {
            config.tasks[id] = { enabled: true, location: '' };
            changed = true;
        }
    }
    if (raw.binds && typeof raw.binds === 'object' && !Array.isArray(raw.binds)) config.binds = raw.binds;
    for (const [key, value] of Object.entries(raw)) {
        if (!['tasks', 'binds', 'locations'].includes(key)) config[key] = value;   // keep anything else the owner added
    }
    return { config, changed };
}

function parseBinds(binds) {
    const out = {};
    for (const [id, deps] of Object.entries(binds || {})) {
        const list = (Array.isArray(deps) ? deps : [deps]).filter(d => typeof d === 'string' && d && d !== id);
        if (list.length) out[id] = list;
    }
    return out;
}

// Returns [{ id, name, location, locationFrom, enabled, file, requires: [ids] }] sorted by id.
// locationFrom is "tasks.json", "meta" or "" (no location anywhere).
// `requires` lists the tasks that must be done before this one (from the binds in tasks.json).
// New minigames are added to tasks.json here (enabled, empty location).
export async function readTasks() {
    const found = await listMinigameIds();
    const raw = await readConfigFile();

    let config;
    if (raw === null) {
        config = { tasks: {}, binds: {} };
    } else {
        const done = completeConfig(raw, found.map(f => f.id));
        config = done.config;
        if (done.changed) {
            await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        }
    }

    const tasks = [];
    for (const { id, file } of found) {
        const entry = config.tasks[id] || { enabled: true, location: '' };
        let location = entry.location.trim(), locationFrom = location ? 'tasks.json' : '';
        if (!location) {
            location = await readMetaLocation(path.join(MINIGAMES_DIR, file));
            if (location) locationFrom = 'meta';
        }
        tasks.push({ id, name: prettify(id), location, locationFrom, enabled: entry.enabled, file, requires: [] });
    }

    const byId = new Map(tasks.map(t => [t.id, t]));
    for (const id of Object.keys(config.tasks)) {
        if (!byId.has(id)) warnOnce(`tasks.json: "${id}" is listed, but there is no minigames/${id}.html.`);
    }
    for (const [first, deps] of Object.entries(parseBinds(config.binds))) {
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

// tasks.txt, enabled tasks only:
//   wires:
//   http://192.168.1.20:8812/task/9f1c...
export function formatLinks(tasks, map) {
    const blocks = tasks.filter(t => t.enabled && map[t.id]).map(t => `${t.id}:\n${baseUrl()}/task/${map[t.id]}`);
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
// Disabled tasks keep their token too, so switching one back on doesn't need a new QR code.
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
