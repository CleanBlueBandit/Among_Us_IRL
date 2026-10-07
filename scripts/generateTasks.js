// Usage: npm run generate:tasks            (one link per imported task)
//        npm run generate:tasks -- 2       (two links per task, e.g. duplicate QR codes)
// Writes tasks.txt (one URL per line, ready for a QR generator) and stores the
// matching tokens in tasks.json so the server can validate scans.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';
import { readTaskLibrary, writeTaskLibrary, ROOT } from './taskStore.js';

const perTask = Math.max(1, parseInt(process.argv[2] || '1', 10) || 1);
const lib = await readTaskLibrary();

if (lib.tasks.length === 0) {
    console.error('No tasks imported yet. Run: npm run import:tasks -- <file.json>');
    process.exit(1);
}

const protocol = process.env.PROTOCOL || 'http';
const ip = process.env.IP || 'localhost';
const port = process.env.PORT || 8080;
const base = `${protocol}://${ip}:${port}`;

const links = [];
for (const task of lib.tasks) {
    for (let i = 0; i < perTask; i++) {
        links.push({ token: crypto.randomBytes(12).toString('hex'), taskId: task.id });
    }
}

await writeTaskLibrary({ tasks: lib.tasks, links });

const out = links.map(l => `${base}/task/${l.token}`).join('\n') + '\n';
await fs.writeFile(path.join(ROOT, 'tasks.txt'), out, 'utf-8');

console.log(`Wrote ${links.length} links to tasks.txt (base: ${base}).`);
const byId = Object.fromEntries(lib.tasks.map(t => [t.id, t]));
for (const l of links) console.log(`  ${l.token.slice(0, 6)}…  ${byId[l.taskId].name} @ ${byId[l.taskId].location}`);
