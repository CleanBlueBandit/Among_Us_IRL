// Usage: npm run task-links            show the link of every QR code (and make sure tasks.txt is up to date)
//        npm run task-links -- --new   throw away all tokens and issue new ones (old QR codes stop working)
// The server creates tokens by itself, so you normally never need this; it just prints what to turn into QR codes.
import { readLibrary, baseUrl } from './taskStore.js';

const { tasks } = await readLibrary({ rotate: process.argv.includes('--new') });
if (tasks.length === 0) {
    console.error('No tasks found. Add .html files to the minigames/ folder.');
    process.exit(1);
}

const on = tasks.filter(t => t.enabled);
const off = tasks.filter(t => !t.enabled);
const codes = on.flatMap(t => t.steps);
console.log(`${codes.length} QR codes in tasks.txt (base: ${baseUrl()}):`);
for (const s of codes) console.log(`  ${s.label}  ->  ${baseUrl()}/task/${s.token}   (${s.location || 'no location yet'})`);
if (off.length) console.log(`Switched off in tasks.json (not in tasks.txt): ${off.map(t => t.id).join(', ')}`);
const notInJson = codes.filter(s => s.locationFrom !== 'tasks.json');
if (notInJson.length) console.log(`${notInJson.length} of ${codes.length} QR codes have no location in tasks.json (${codes.filter(s => s.locationFrom === 'meta').length} use their minigame's meta tag).`);
