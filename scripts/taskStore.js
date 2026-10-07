import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const TASKS_FILE = path.join(ROOT, 'tasks.json');

export async function readTaskLibrary() {
    try {
        const raw = await fs.readFile(TASKS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
            links: Array.isArray(parsed.links) ? parsed.links : []
        };
    } catch (e) {
        if (e.code === 'ENOENT') return { tasks: [], links: [] };
        throw e;
    }
}

export async function writeTaskLibrary(lib) {
    await fs.writeFile(TASKS_FILE, JSON.stringify(lib, null, 2), 'utf-8');
}
