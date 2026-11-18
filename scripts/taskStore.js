// Tasks live in the "minigames" folder at the project root: every .html file there is one task and the
// file name (without ".html") is its task.id. Nothing to import.
//   minigames/wires.html  ->  task.id "wires", name "Wires"
// Optional, inside the file's <head>:  <meta name="location" content="Electrical">
// Files starting with "_" are ignored (handy for templates / unfinished games).
//
// Each task is scanned through a random secret token (/task/<token>) that the server generates by itself
// the first time it sees the task. Tokens are saved in tokens.json so printed QR codes stay valid across
// restarts, and tasks.txt (one link per line) is rewritten whenever a token is created or rotated.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const MINIGAMES_DIR = path.join(ROOT, 'minigames');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const LINKS_FILE = path.join(ROOT, 'tasks.txt');

// "calibrate_power" -> "Calibrate power"
function prettify(id) {
    const s = id.replace(/[-_]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

async function readLocation(file) {
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

// Returns [{ id, name, location, file }] sorted by id.
export async function readTasks() {
    let files;
    try {
        files = await fs.readdir(MINIGAMES_DIR);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }

    const tasks = [];
    for (const file of files.sort()) {
        if (file.startsWith('_') || file.startsWith('.') || path.extname(file).toLowerCase() !== '.html') continue;
        const id = path.parse(file).name;
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            console.warn(`Skipping minigames/${file}: file names may only use letters, numbers, "-" and "_" (they become URLs).`);
            continue;
        }
        tasks.push({ id, name: prettify(id), location: await readLocation(path.join(MINIGAMES_DIR, file)), file });
    }
    return tasks;
}

// ---- tokens ----------------------------------------------------------------------------------------

let tokenMap = null;               // { [task.id]: token }, loaded once, then kept in memory
let queue = Promise.resolve();     // serialises token creation so two scans can't invent different tokens

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

async function writeLinks(tasks, map) {
    const lines = tasks.filter(t => map[t.id]).map(t => `${baseUrl()}/task/${map[t.id]}`);
    await fs.writeFile(LINKS_FILE, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
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
        if (changed) {
            await fs.writeFile(TOKENS_FILE, JSON.stringify(map, null, 2), 'utf-8');
            await writeLinks(tasks, map);
        }
        return tasks.map(t => ({ ...t, token: map[t.id] }));
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

export { baseUrl };
