// Usage: npm run import:tasks -- path/to/locations.json
// Accepts either an array, or { "tasks": [...] }, of:
//   { "id": "wires-electrical", "name": "Fix wires", "location": "Electrical", "minigame": "wires" }
// "minigame" is optional: one of calibrate_power, refuel_tank, fuel_engine, wires. Tasks with one open that
// minigame when scanned; completing it completes the task. fuel_engine needs a refuel_tank task too.
// "id" is optional (derived from the name). Re-importing replaces the task list;
// existing generated links are kept if their task id still exists.
import fs from 'fs/promises';
import path from 'path';
import { readTaskLibrary, writeTaskLibrary } from './taskStore.js';
import { MINIGAME_PAGES } from './minigames.js';

function slug(s) {
    return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const file = process.argv[2];
if (!file) {
    console.error('Usage: npm run import:tasks -- <file.json>');
    process.exit(1);
}

let parsed;
try {
    parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf-8'));
} catch (e) {
    console.error(`Could not read/parse ${file}: ${e.message}`);
    process.exit(1);
}

const list = Array.isArray(parsed) ? parsed : parsed.tasks;
if (!Array.isArray(list) || list.length === 0) {
    console.error('JSON must be a non-empty array, or an object with a non-empty "tasks" array.');
    process.exit(1);
}

const seen = new Set();
const tasks = [];
for (const [i, t] of list.entries()) {
    const name = t && typeof t.name === 'string' ? t.name.trim() : '';
    const location = t && typeof t.location === 'string' ? t.location.trim() : '';
    if (!name || !location) {
        console.error(`Entry #${i + 1} needs a non-empty "name" and "location".`);
        process.exit(1);
    }
    const minigame = t && t.minigame ? String(t.minigame).trim() : '';
    if (minigame && !Object.hasOwn(MINIGAME_PAGES, minigame)) {
        console.error(`Entry #${i + 1} has an unknown minigame "${minigame}". Use one of: ${Object.keys(MINIGAME_PAGES).join(', ')}.`);
        process.exit(1);
    }
    const id = t.id ? slug(t.id) : slug(`${name}-${location}`);
    if (!id || seen.has(id)) {
        console.error(`Entry #${i + 1} has a duplicate or empty id "${id}". Give it a unique "id".`);
        process.exit(1);
    }
    seen.add(id);
    tasks.push(minigame ? { id, name, location, minigame } : { id, name, location });
}

if (tasks.some(t => t.minigame === 'fuel_engine') && !tasks.some(t => t.minigame === 'refuel_tank')) {
    console.warn('Warning: "fuel_engine" is never assigned without a "refuel_tank" task, so it will be skipped.');
}

const lib = await readTaskLibrary();
const keptLinks = lib.links.filter(l => seen.has(l.taskId));
const dropped = lib.links.length - keptLinks.length;
await writeTaskLibrary({ tasks, links: keptLinks });

console.log(`Imported ${tasks.length} tasks.`);
if (dropped > 0) console.log(`Removed ${dropped} generated link(s) belonging to tasks no longer present - re-run "npm run generate:tasks".`);
for (const t of tasks) console.log(`  ${t.id}: ${t.name} @ ${t.location}`);
