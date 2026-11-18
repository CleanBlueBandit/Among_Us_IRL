// Usage: npm run task-links            show the link of every task (and make sure tasks.txt is up to date)
//        npm run task-links -- --new   throw away all tokens and issue new ones (old QR codes stop working)
// The server creates tokens by itself, so you normally never need this; it just prints what to turn into QR codes.
import { readTasksWithTokens, baseUrl } from './taskStore.js';

const tasks = await readTasksWithTokens({ rotate: process.argv.includes('--new') });
if (tasks.length === 0) {
    console.error('No tasks found. Add .html files to the minigames/ folder.');
    process.exit(1);
}

console.log(`${tasks.length} links in tasks.txt (base: ${baseUrl()}):`);
for (const t of tasks) console.log(`  ${t.id}  ->  ${baseUrl()}/task/${t.token}${t.location ? `   (${t.location})` : ''}`);
