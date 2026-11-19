import express from 'express';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser';
import crypto, { KeyObject } from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import 'dotenv/config';
import { renderCrewmateWinHtml, renderImpostorWinHtml } from './winscreen.js';
import { renderRoleRevealHtml } from './rolereveal.js';
import { renderTaskResultHtml } from './taskresult.js';
import { readLibrary, MINIGAMES_DIR, ROOT, updateTaskConfig } from './scripts/taskStore.js';
import { validatePlan } from './public/editor/geometry.js';
import { debuglog } from 'util';
import { marked } from "marked";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const btoActive = true;

let cooldownTime = Date.now();
let sabCooldownTime = Date.now();

const betaTestingOverride = {
    emergencyCountdown : 30,
    meetingCooldown: 40,
    sabotageCooldown: 30
} 

async function haltScript(){
    while(true){};
}

// Uncomment after this line

// const h = await bcrypt.hash("YOUR PASSWORD HERE", 10); // <-- Your password there
// console.log(`Your hash: ${h}`);

// await haltScript();

// Up to this line

const DEBUG_LOG = path.join(__dirname, 'debug.log');
const ERROR_LOG = path.join(__dirname, 'error.log');

function logDebug(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[DEBUG] [${timestamp}] ${message}`;
    console.log(logMsg);
    fs.appendFile(DEBUG_LOG, logMsg + '\n', 'utf-8').catch(e => console.error("Logger error:", e));
}

function logWarn(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[WARN] [${timestamp}] ${message}`;
    console.warn(logMsg);
    fs.appendFile(DEBUG_LOG, logMsg + '\n', 'utf-8').catch(e => console.error("Logger error:", e));
}

function logError(message, error = "") {
    const timestamp = new Date().toISOString();
    const errorStr = error instanceof Error ? (error.stack || error.message) : String(error);
    const logMsg = `[ERROR] [${timestamp}] ${message} ${errorStr}`;
    console.error(logMsg);
    fs.appendFile(ERROR_LOG, logMsg + '\n', 'utf-8').catch(e => console.error("Logger error:", e));
}

let PORT = process.env.PORT;
let IP = process.env.IP;
let host_pass = process.env.PASSWORD_HASH;
let protocol = process.env.PROTOCOL;

let ic = 0;
if(!process.env.PORT){
    logError("PORT variable missing in .env, defaulting to 8080");
    PORT = 8080
    ic++;
}
if(!process.env.IP){
    logError("IP variable missing in .env, defaulting to localhost");
    IP = "localhost";
    ic++
}
if(!process.env.PASSWORD_HASH){
    logError("PASSWORD_HASH variable missing in .env, defaulting to the password \"Amogus\"");
    host_pass = "$2b$10$uKDD79durabBkvd2X6fH.OhkyPc4jW/jNiwoQwYBqM/FbLXJoI5.i";
    ic++;
}
if(!process.env.PROTOCOL){
    logError("PROTOCOL variable missing in .env, defaulting to http");
    protocol = "http";
    ic++;
}

if(ic > 0){
    logError(`${ic}/4 .env variables missing. (Did you create the .env file?)`);
}
else{
    logDebug("All .env variables present.");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use((req, res, next) => {
    if (req.path.endsWith('.html')) {
        logDebug(`Direct access to HTML file forbidden: ${req.path}`);
        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>Unauthorised</title></head>
            <body>
                <p>401 - Direct access to html files is forbidden.</p>
                <a href="/"><button>back to login</button></a>
            </body>
            </html>
        `;

        res.set('Content-Type', 'text/html');
        return res.status(401).send(dynamicHtml);
    }
    next();
});

app.use(express.static('public'));
// The floor plan save carries the whole plan, so it gets a bigger body limit (see /floorplan/save).
const jsonBody = express.json();
app.use((req, res, next) => (req.path === '/floorplan/save' ? next() : jsonBody(req, res, next)));
app.use(cookieParser());

let gameLock = Promise.resolve();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withGameLock(fn) {
    const previous = gameLock;
    let release;
    gameLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await fn();
    } finally {
        release();
    }
}

const DEFAULT_SETTINGS = {
    impostors: 2,
    meltdownCountdown: 30,
    tasks: 5,
    emergencyCountdown: 120,
    emergencyCooldown : 30,
    sabotageCooldown:30
};

let meltdownCountdownSeconds = DEFAULT_SETTINGS.meltdownCountdown;
let emergencyCountdownSeconds = DEFAULT_SETTINGS.emergencyCountdown;

const DEFAULT_GAME_STATE = {
    started: false,
    winCondition: "",
    impostorsWon: false,
    crewmatesWon: false,
    emergencyMeeting: false,
    emergencyMeetingEndTime: 0,
    totalTasks: 0,
    completedTasks: 0,
    host: "",
    aliveImpostors: 0,
    playerCount: 0,
    alivePlayers: 0,
    lastEjection: null
};


const DEFAULT_SABOTAGES = {
    cooldown : 0,
    o2: { sabotaged: false, depleted: false, timeLeft: 0 },
    reactor: { sabotaged: false, meltdown: false, timeLeft: 0 }
};

function validateServer(servers, session) {
    if (!servers || !session) return false;
    return servers.hasOwnProperty(session);
}

function isGameOperational(servers) {
    if (!servers || typeof servers !== 'object') {
        return false;
    }
    const activeRoles = Object.values(servers);
    return activeRoles.includes('o2') && activeRoles.includes('reactor') && activeRoles.includes('emergency');
}

function publicPath(fileName) {
    return path.join(__dirname, 'public', fileName + '.html');
}



try {
    await fs.access("./game.json");
    logDebug(`game.json detected, proceeding.`);
} catch {
    await fs.copyFile("./default.json", "./game.json");
    logDebug(`game.json missing, copying data from default.json`);
}

// Tasks are the .html files in the minigames/ folder (see scripts/taskStore.js). tasks.json can make a
// minigame repeat (several QR codes, done in order) and bind minigames into chains. Either way the
// player is handed "units", and each unit counts as ONE task.
//
// player.tasks entries (one per unit) keep the shape the tablets draw: { id, name, location, done },
// where name/location are those of the step the player has to do next. Plus:
//   steps: [{ task, n, of, name, location, done }]   one per QR code, in order
//   step:  index of the next step to do

async function loadTaskLibrary() {
    try {
        return await readLibrary();
    } catch (error) {
        logError("Failed to read the minigames folder:", error);
        return { tasks: [], units: [], byId: new Map(), byToken: new Map() };
    }
}

// The units that can be handed out: every task in them switched on and present.
function eligibleUnits(library) {
    return library.units.filter(u => u.usable);
}

function stepName(task, n) {
    return task.repeat > 1 ? `${task.name} (${n}/${task.repeat})` : task.name;
}

// Points the unit's name/location/done at the step the player has to do next.
function refreshAssigned(entry) {
    const i = entry.steps.findIndex(s => !s.done);
    entry.done = i < 0;
    entry.step = i < 0 ? entry.steps.length - 1 : i;
    const cur = entry.steps[entry.step];
    entry.name = cur.name;
    entry.location = cur.location;
    return entry;
}

function pickRandomTasks(library, units, count) {
    const copy = [...units];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count).map(u => refreshAssigned({
        id: u.id,
        steps: u.steps.map(s => {
            const task = library.byId.get(s.task);
            const step = task.steps[s.n - 1];
            return { task: s.task, n: s.n, of: s.of, name: stepName(task, s.n), location: step.location, done: false };
        })
    }));
}

// Crew wins once every crewmate task is done. Impostor tasks are never part of the total.
function evaluateTaskWin(data) {
    const gs = data.gameState;
    if (!gs.started || gs.totalTasks <= 0 || gs.completedTasks < gs.totalTasks) return false;

    gs.crewmatesWon = true;
    gs.impostorsWon = false;
    gs.started = false;
    gs.winCondition = "THE CREW COMPLETED EVERY TASK";
    clearAllSabotageTimers();
    clearEmergencyMeetingTimer();
    return true;
}

// Read-only validation of a scanned task link, shared by the GET (before showing the minigame)
// and the POST (which then applies it). Returns { outcome } when declined, otherwise
// { player, entry, stepIndex, libTask, shown }. The wording is identical for crewmates and impostors so
// a scan never reveals the role.
function checkTaskScan(data, library, session, token) {
    const decline = (message, next = '/dashboard', task = null) =>
        ({ outcome: { accepted: false, status: 403, title: 'Task declined', message, next, task } });

    const player = session ? data.players[session] : null;
    if (!player) {
        return decline('You are not part of this game. Join from the login page first.', '/');
    }
    if (!data.gameState.started) {
        return decline('The game is not running.', '/waiting');
    }
    if (data.gameState.emergencyMeeting) {
        return decline('No tasks during an emergency meeting.');
    }
    if (data.activeSabotages.o2.sabotaged || data.activeSabotages.reactor.sabotaged) {
        return decline('A sabotage is in progress. Fix it first!');
    }

    const hit = token ? library.byToken.get(token) : null;
    if (!hit) {
        const d = decline('This code is not a valid task.');
        d.outcome.status = 404;
        return d;
    }
    const libTask = hit.task;
    const shown = { name: stepName(libTask, hit.step.n), location: hit.step.location };
    if (libTask.enabled === false) {
        return decline('This task is switched off.', '/dashboard', shown);
    }

    const mine = Array.isArray(player.tasks) ? player.tasks : [];
    let entry = null, stepIndex = -1;
    for (const e of mine) {
        if (!Array.isArray(e.steps)) continue;
        const i = e.steps.findIndex(s => s.task === libTask.id && s.n === hit.step.n);
        if (i >= 0) { entry = e; stepIndex = i; break; }
    }
    if (!entry) {
        return decline('This task is not assigned to you.', '/dashboard', shown);
    }
    if (entry.steps[stepIndex].done) {
        return decline('You already did this one.', '/dashboard', shown);
    }
    // Steps go in order: only the next one can be done.
    const next = entry.steps.findIndex(s => !s.done);
    if (stepIndex !== next) {
        const cur = entry.steps[next];
        return decline(`Not yet. First: ${cur.name}${cur.location ? ` (${cur.location})` : ''}.`, '/dashboard', shown);
    }

    return { player, entry, stepIndex, libTask, shown };
}

// Decides whether a scanned task link is accepted. Mutates `data` on success (caller saves it).
function processTaskScan(data, library, session, token) {
    const check = checkTaskScan(data, library, session, token);
    if (check.outcome) return check.outcome;
    const { player, entry, stepIndex, shown } = check;

    entry.steps[stepIndex].done = true;
    refreshAssigned(entry);
    if (!entry.done) {
        return { accepted: true, status: 200, title: 'Step done', message: `Next: ${entry.name}${entry.location ? ` (${entry.location})` : ''}.`, next: '/dashboard', task: shown };
    }
    if (!player.impostor) {
        player.tasksCompleted = (player.tasksCompleted || 0) + 1;
        data.gameState.completedTasks += 1;
    }
    return { accepted: true, status: 200, title: 'Task accepted', message: 'Task completed.', next: '/dashboard', task: shown };
}

// Injected into a minigame page: completeTask() POSTs the finished task back to the server once.
function completeTaskSnippet(token) {
    return `<script>window.TASK_TOKEN=${JSON.stringify(token)};window.completeTask=(function(){var sent=false;return function(delay){if(sent)return;sent=true;setTimeout(function(){var f=document.createElement('form');f.method='POST';f.action='/task/'+encodeURIComponent(window.TASK_TOKEN);document.body.appendChild(f);f.submit();},delay==null?1500:delay);};})();</script>`;
}

async function renderMinigameHtml(task, token) {
    const html = await fs.readFile(path.join(MINIGAMES_DIR, task.file), 'utf-8');
    const snippet = completeTaskSnippet(token);
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + snippet) : snippet + html;
}

async function loadGame() {
    try {
        
        const rawData = await fs.readFile('./game.json', 'utf-8');
        const data = JSON.parse(rawData);

        if (!data.players) data.players = {};
        if (!data.gameState) data.gameState = { ...DEFAULT_GAME_STATE };
        else data.gameState = { ...DEFAULT_GAME_STATE, ...data.gameState };
        
        if (!data.activeSabotages) {
            data.activeSabotages = {
                o2: { ...DEFAULT_SABOTAGES.o2 },
                reactor: { ...DEFAULT_SABOTAGES.reactor }
            };
        }
        if (!data.servers) data.servers = {};
        // Merge over the defaults so older game.json files (missing newer keys) still work.
        data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        
        logDebug("data loaded");
        return data;
    } catch (error) {
        logError("Failed to load game.json, returning defaults.", error);
        return {
            players: {},
            gameState: { ...DEFAULT_GAME_STATE },
            activeSabotages: {
                o2: { ...DEFAULT_SABOTAGES.o2 },
                reactor: { ...DEFAULT_SABOTAGES.reactor }
            },
            servers: {},
            settings: { ...DEFAULT_SETTINGS }
        };
    }
}

async function saveGame(data) {
    await fs.writeFile('./game.json', JSON.stringify(data, null, 2), 'utf-8');
    io.emit('game_data_request', data.gameState);
    io.emit('servers_data_request', { servers: data.servers, operational: false });

    let sabEndTime = 0;
    const { o2, reactor } = data.activeSabotages;
    if (o2.sabotaged) sabEndTime = Date.now() + (o2.timeLeft * 1000);
    else if (reactor.sabotaged) sabEndTime = Date.now() + (reactor.timeLeft * 1000);


    // I know this is insecure, but i dont want to write multiple step handshakes and authentication
    io.emit('sabotage_data_request', { sData: data.activeSabotages, endTime: sabEndTime });
    // Each player has a private socket room named after their session id.
    for (const [playerId, player] of Object.entries(data.players)) {
        io.to(playerId).emit('player_data_request', player);
    }
    logDebug("data saved and brodcasted");
}

httpServer.listen(PORT, () => {
    logDebug(`Server connected. Express server running on ${protocol}://${IP}:${PORT}`);
    loadTaskLibrary().then(lib => {
        const label = u => u.steps.length === 1 ? u.id
            : u.tasks.map(id => { const t = lib.byId.get(id); return t.repeat > 1 ? `${id} x${t.repeat}` : id; }).join(' > ');
        const usable = eligibleUnits(lib);
        const off = lib.tasks.filter(t => !t.enabled);
        const blocked = lib.units.filter(u => !u.usable && !(u.tasks.length === 1 && !lib.byId.get(u.tasks[0]).enabled));
        logDebug(`Tasks loaded from minigames/: ${usable.map(label).join(', ') || 'none'} (QR links in tasks.txt)`);
        if (off.length) logDebug(`Switched off in tasks.json: ${off.map(t => t.id).join(', ')}`);
        if (blocked.length) logWarn(`Not handed out: ${blocked.map(u => `${label(u)} (${u.problem})`).join(', ')}`);
        // Locations are per QR code: a repeating task has one per code.
        const codes = lib.tasks.filter(t => t.enabled).flatMap(t => t.steps.map(s => ({ t, s })));
        const fromMeta = codes.filter(c => c.s.locationFrom === 'meta');
        const none = codes.filter(c => !c.s.location);
        if (fromMeta.length || none.length) {
            logWarn(`${fromMeta.length + none.length} of ${codes.length} QR codes have no location in tasks.json.`
                + (fromMeta.length ? ` Using the minigame's <meta name="location"> for ${fromMeta.length}: ${fromMeta.map(c => `${c.s.label} (${c.s.location})`).join(', ')}.` : '')
                + (none.length ? ` No location at all for ${none.length}: ${none.map(c => c.s.label).join(', ')} - players will see them without one.` : ''));
        }
    });
});

app.post('/enter', async (req, res) => {
    try {
        await withGameLock(async () => {
            const session = req.cookies.session;
            const data = await loadGame();

            const username = req.body.username ? String(req.body.username) : "Anonymous Crewmate";

            if (session && typeof session === 'string' && data.players[session]) {
                logDebug(`Player re-entered with existing session: ${username}`);
                return res.status(200).json({ message: "username accepted!" })
            }

            const UUID = crypto.randomUUID();
            res.cookie('session', UUID, {
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                maxAge: 1000 * 60 * 60 * 12
            });

            const playerData = {
                id: UUID,
                username: username,
                alive: true,
                tasksCompleted: 0,
                totalTasks: data.settings.tasks,
                tasks: [],
            };

            data.players[UUID] = playerData;
            data.gameState.playerCount = Object.keys(data.players).length;
            data.gameState.alivePlayers = Object.keys(data.players).length;

            await saveGame(data);
            io.emit('game_data_request', data.gameState);
            logDebug(`New player joined: ${username} with ID ${UUID}`);

            return res.status(200).json({ message: "username created!" })
        });
    } catch (error) {
        logError("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})

app.get("/host", (req, res) => {
    res.status(200).sendFile(path.join(__dirname, 'public', 'host-login.html'));
})

app.post('/enter-host', async (req, res) => {
    try {
        await withGameLock(async () => {
            const session = req.cookies.session;
            const data = await loadGame();
            const username = req.body.username ? String(req.body.username) : "Host";
            const password = req.body.password ? String(req.body.password) : "";

             if (!password || !host_pass) {
                logDebug(`Host login failed: missing credentials for ${username}`);
                return res.status(401).json({ error: "invalid credentials" });
            }

            if (!(await bcrypt.compare(password, host_pass))) {
                logDebug(`Host login failed: invalid password for ${username}`);
                return res.status(401).json({ error: "invalid credentials" })
            }

            if (req.body.server) {
                const UUID = crypto.randomUUID();
                res.cookie('session', UUID, {
                    httpOnly: true,
                    secure: false,
                    sameSite: 'lax',
                    maxAge: 1000 * 60 * 60 * 12
                });

                data.servers[UUID] = "none";
                await saveGame(data);
                // Let the host lobby know a new device just connected (relevant to isGameOperational()).
                io.emit('servers_data_request', {
                    servers: data.servers,
                    operational: isGameOperational(data.servers)
                });

                logDebug(`New server joined with ID ${UUID}`);
                return res.sendFile(path.join(__dirname, 'public', 'server.html'));
            }

            if (data.gameState.host != "") {
                logDebug(`Host login denied: Host is already in the game.`);
                return res.status(400).json({ error: "Host is already in the game!" })
            }

            const UUID = crypto.randomUUID();
            res.cookie('session', UUID, {
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                maxAge: 1000 * 60 * 60 * 12
            });

            const playerData = {
                id: UUID,
                username: username,
                alive: true,
                tasksCompleted: 0,
                totalTasks: data.settings.tasks,
                tasks: [],
            };

            data.players[UUID] = playerData;
            data.gameState.host = username;
            data.gameState.playerCount = Object.keys(data.players).length;
            data.gameState.alivePlayers = Object.keys(data.players).length;

            await saveGame(data);
            io.emit('game_data_request', data.gameState);
            logDebug(`Host successfully joined: ${username} with ID ${UUID}`);

            return res.status(200).json({ message: "wellcome, host!" })
        });
    } catch (error) {
        logError("Error managing host entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})

app.post("/end", async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if (!data.players[session] || data.players[session].username != data.gameState.host) {
        logDebug(`Unauthorised game end attempt by session: ${session}`);
        return res.sendStatus(401);
    }

    data.gameState.started = false;
    logDebug("Host ended the game.");
    await saveGame(data);
    io.emit('game_data_request', data.gameState);
    res.sendStatus(200);
})

app.post("/restart", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            logDebug(`Unauthorised POST game restart attempt by session: ${session}`);
            return res.status(401).json({ message: "You are not the host.", failed: true });
        }

        logDebug("Host restarted the game via POST.");
        clearAllSabotageTimers();
        clearEmergencyMeetingTimer();

        for (const id of Object.keys(data.players)) {
            const p = data.players[id];
            const wasDummy = p.role === 'dummy';
            p.impostor = false;
            p.role = wasDummy ? 'dummy' : 'none';
            p.alive = true;
            p.tasksCompleted = 0;
            p.totalTasks = wasDummy ? 0 : data.settings.tasks;
            p.tasks = [];
        }

        const playerCount = Object.keys(data.players).length;

        data.gameState = {
            ...DEFAULT_GAME_STATE,
            host: data.gameState.host,
            playerCount,
            alivePlayers: playerCount
        };

        data.activeSabotages = {
            o2: { ...DEFAULT_SABOTAGES.o2 },
            reactor: { ...DEFAULT_SABOTAGES.reactor }
        };

        await saveGame(data);
        io.emit('restart_game', {});
        io.emit('game_data_request', data.gameState);

        return res.status(200).json({ message: "Game restarted.", failed: false });
    });
});

app.get('/dashboard', async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if (!data.players[session]) {
        return res.status(401).json({ error: "401 unauthorised." });
    }

    if (!data.gameState.started) {
        logDebug(`Player ${session} attempted to view dashboard before game start.`);
        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>Please wait</title></head>
            <body>
                <p>Please be more patient, the game hasnt been started yet.</p>
                <a href="/waiting"><button>back to the waiting lobby</button></a>
            </body>
            </html>
        `;
        res.set('Content-Type', 'text/html');
        return res.send(dynamicHtml);
    }
    return res.sendFile(path.join(__dirname, 'public', 'crewmate.html'));
})

app.get('/impostor', async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if (!data.players[session]) {
        return res.status(401).json({ error: "401 unauthorised." });
    }
    const playerData = data.players[session];

    if (playerData.impostor) {
        return res.sendFile(path.join(__dirname, 'public', 'impostor.html'));
    }
    logDebug(`Non-impostor ${session} tried to access /impostor`);
    return res.sendFile(path.join(__dirname, 'public', 'crewmate.html'));
})

app.get('/emergency-client', async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if (!data.players[session]) {
        return res.status(401).json({ error: "401 unauthorised." });
    }
    return res.sendFile(path.join(__dirname, 'public', 'EM.html'));
})

app.get('/logout', async (req, res) => {
    const session = req.cookies.session;

    await withGameLock(async () => {
        const data = await loadGame();
        if (data.players[session]) {
            const leavingPlayer = data.players[session];
            logDebug(`Player logged out: ${leavingPlayer.username} (${session})`);
            if (data.gameState.host == leavingPlayer.username) {
                logDebug(`Host logged out! Stopping game.`);
                data.gameState.host = "";
                data.gameState.started = false;
            }

            // Only decrement alive-related counters if this player was actually still alive -
            // previously this ran unconditionally, silently under-counting whenever a dead
            // player (or an impostor) logged out.
            const wasAlive = leavingPlayer.alive !== false;
            if (data.gameState.started && !leavingPlayer.impostor) {
                data.gameState.totalTasks = Math.max(0, data.gameState.totalTasks - (leavingPlayer.totalTasks || 0));
                data.gameState.completedTasks = Math.max(0, data.gameState.completedTasks - (leavingPlayer.tasksCompleted || 0));
            }
            delete data.players[session];
            data.gameState.playerCount = Math.max(0, data.gameState.playerCount - 1);

            if (wasAlive) {
                data.gameState.alivePlayers = Math.max(0, data.gameState.alivePlayers - 1);
                if (leavingPlayer.impostor) {
                    data.gameState.aliveImpostors = Math.max(0, data.gameState.aliveImpostors - 1);
                }
                evaluateWinConditions(data, {
                    crewWin: "THE CREW ELIMINATED EVERY IMPOSTOR",
                    impostorWin: "THE IMPOSTORS OVERWHELMED THE CREW"
                });
            }
            evaluateTaskWin(data);

            await saveGame(data);
            io.emit('game_data_request', data.gameState);

            if (!data.gameState.started && (data.gameState.crewmatesWon || data.gameState.impostorsWon)) {
                io.emit('game_over', {
                    winner: data.gameState.crewmatesWon ? 'crewmates' : 'impostors',
                    reason: 'disconnect'
                });
            }
        }

        if (data.servers && data.servers.hasOwnProperty(session)) {
            logDebug(`Server device logged out: ${session}`);
            delete data.servers[session];
            await saveGame(data);
            io.emit('servers_data_request', {
                servers: data.servers,
                operational: isGameOperational(data.servers)
            });
        }
    });

    res.clearCookie('session', {
        httpOnly: true
    });

    res.redirect('/');
})

app.post("/deviceFunc", async (req, res) => {
    const data = await loadGame();
    const sf = req.body.setting;

    if (!validateServer(data.servers, req.cookies.session)) {
        logDebug(`Unauthorised /deviceFunc request by ${req.cookies.session}`);
        return res.status(401).json({ ok: false, resp: "401 unauthorised" });
    }

    if (Object.values(data.servers).includes(sf)) {
        logDebug(`${req.cookies.session} tried to take on the role of an existing server, denying.`);
        return res.status(400).json({ ok: false, resp: "400 - the server role is already taken." });
    }

    data.servers[req.cookies.session] = sf;
    logDebug(`${sf} server is now online and registered to session ${req.cookies.session}`);
    await saveGame(data);

    io.emit('servers_data_request', {
        servers: data.servers,
        operational: isGameOperational(data.servers)
    });

    return res.status(200).json({ ok: true });
});

app.get("/o2", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
        
    }
    if(data.servers[req.cookies.session] != "o2"){
            return res.redirect(data.servers[req.cookies.session])
        }
    return res.status(200).sendFile(publicPath("o2"));
})

app.get("/reactor", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
    }
    if(data.servers[req.cookies.session] != "reactor"){
            return res.redirect(data.servers[req.cookies.session])
        }
    return res.status(200).sendFile(publicPath("reactor"));
})

app.get("/emergency", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
        
    }
    if(data.servers[req.cookies.session] != "emergency"){
            return res.redirect(data.servers[req.cookies.session])
        }
    return res.status(200).sendFile(publicPath("emergency"));
})

const sabotageTimers = new Map();

async function startSabotageCountdown(type, seconds) {
    if (!type || typeof seconds !== 'number' || seconds <= 0) return;
    if (type !== 'o2' && type !== 'reactor') return;

    if (sabotageTimers.has(type)) {
        clearInterval(sabotageTimers.get(type));
        sabotageTimers.delete(type);
    }

    const data = await loadGame();

    logDebug(`Sabotage started: ${type} with initial delay of ${seconds} seconds.`);
    data.activeSabotages[type].sabotaged = true;
    data.activeSabotages[type].timeLeft = seconds;

    if (type === 'o2') data.activeSabotages.o2.depleted = false;
    else data.activeSabotages.reactor.meltdown = false;

    await saveGame(data);

    // Broadcast immediately instead of waiting for the first 1s tick, so every
    // connected client (not just the one that triggered it) finds out right away.
    io.emit('sabotage_data_request', {
        sData: data.activeSabotages,
        endTime: Date.now() + (seconds * 1000)
    });

    const timer = setInterval(async () => {
        try {
            const d = await loadGame();
            const sab = d.activeSabotages[type];

            if (!sab || !sab.sabotaged) {
                logDebug(`Sabotage timer cancelled naturally for: ${type}`);
                clearInterval(timer);
                sabotageTimers.delete(type);
                return;
            }

            // Sabotage countdowns pause while a meeting is running and carry on afterwards.
            if (d.gameState.emergencyMeeting) return;

            sab.timeLeft = Math.max(0, sab.timeLeft - 1);
            await saveGame(d);
            io.emit('sabotage_tick', { type, timeLeft: sab.timeLeft });

            if (sab.timeLeft <= 0) {
                const isCrisisPhase = (type === 'o2' && sab.depleted) ||
                                      (type === 'reactor' && sab.meltdown);

                if (!isCrisisPhase) {
                    logDebug(`Sabotage ${type} reached crisis phase!`);
                    if (type === 'o2') sab.depleted = true;
                    else sab.meltdown = true;

                    sab.timeLeft = meltdownCountdownSeconds;
                    await saveGame(d);

                    const targetEndTime = Date.now() + (meltdownCountdownSeconds * 1000);
                    io.emit('sabotage_data_request', {
                        sData: d.activeSabotages,
                        endTime: targetEndTime
                    });

                } else {
                    logDebug(`Sabotage ${type} failed to be fixed. Impostors win!`);
                    d.gameState.impostorsWon = true;
                    d.gameState.crewmatesWon = false;
                    d.gameState.started = false;
                    
                    if(sab.depleted){
                        d.gameState.winCondition = "OXYGEN DEPRIVATION KILLED THE CREW"
                    }
                    else{
                        d.gameState.winCondition = "REACTOR EXPLOSION DESTROYED THE SHIP"
                    }
                    
                    await saveGame(d);

                    io.emit('sabotage_data_request', {
                        sData: d.activeSabotages,
                        endTime: 0
                    });

                    io.emit('game_data_request', d.gameState);

                    if (type === 'o2') {
                        io.emit('game_over', { winner: 'impostors', reason: 'o2' });
                    } else {
                        io.emit('reactor_meltdown', {});
                        io.emit('game_over', { winner: 'impostors', reason: 'reactor' });
                    }

                    clearInterval(timer);
                    sabotageTimers.delete(type);
                }
            }
        } catch (e) {
            logError(`Error in sabotage timer for ${type}:`, e);
        }
    }, 1000);

    sabotageTimers.set(type, timer);
}

async function fixSabotage(type) {
    if (!type || (type !== 'o2' && type !== 'reactor')) return false;

    if (sabotageTimers.has(type)) {
        clearInterval(sabotageTimers.get(type));
        sabotageTimers.delete(type);
    }

    const d = await loadGame();
    if (!d.activeSabotages[type] || !d.activeSabotages[type].sabotaged) {
        logDebug(`Ignored fix for non-active sabotage: ${type}`);
        return false;
    }

    logDebug(`Sabotage fixed by crew: ${type}`);
    d.activeSabotages[type] = type === 'o2'
        ? { sabotaged: false, depleted: false, timeLeft: 0 }
        : { sabotaged: false, meltdown: false, timeLeft: 0 };
    await saveGame(d);

    io.emit('sabotage_fixed', { type });
    io.emit("sabotage_data_request", { sData: d.activeSabotages, timeLeft:0})
    return true;
}

function clearAllSabotageTimers() {
    logDebug("Clearing all sabotage timers.");
    for (const t of sabotageTimers.values()) {
        clearInterval(t);
    }
    sabotageTimers.clear();
}

// Shared win-condition check, used by anything that can change alive/impostor counts
// (ejection, direct death reports, and players logging out mid-game). Consolidating
// this in one place also means the sabotage/meeting timers always get cleaned up
// consistently whenever the game actually ends, no matter what triggered the win.
function evaluateWinConditions(data, messages = {}) {
    if (!data.gameState.started) return false;

    const aliveImpostors = data.gameState.aliveImpostors;
    const aliveCrew = Math.max(0, data.gameState.alivePlayers - aliveImpostors);

    if (aliveImpostors <= 0) {
        data.gameState.crewmatesWon = true;
        data.gameState.impostorsWon = false;
        data.gameState.started = false;
        data.gameState.winCondition = messages.crewWin || "THE CREW ELIMINATED EVERY IMPOSTOR";
    } else if (aliveImpostors >= aliveCrew) {
        data.gameState.impostorsWon = true;
        data.gameState.crewmatesWon = false;
        data.gameState.started = false;
        data.gameState.winCondition = messages.impostorWin || "THE IMPOSTORS OVERWHELMED THE CREW";
    } else {
        return false;
    }

    clearAllSabotageTimers();
    clearEmergencyMeetingTimer();
    return true;
}

let emergencyMeetingTimer = null;
let emergencyVotes = {};

function clearEmergencyMeetingTimer() {
    if (emergencyMeetingTimer) {
        logDebug("Clearing emergency meeting timer.");
        clearTimeout(emergencyMeetingTimer);
        emergencyMeetingTimer = null;
    }
}

function buildEmergencyRoster(data) {
    return Object.entries(data.players).map(([id, p]) => ({
        id,
        name: p.username,
        dead: p.alive === false,
        voted: Object.prototype.hasOwnProperty.call(emergencyVotes, id)
    }));
}

function tallyEmergencyVotes() {
    const tally = {};
    for (const target of Object.values(emergencyVotes)) {
        tally[target] = (tally[target] || 0) + 1;
    }
    return tally;
}

function emergencyVoterIds(data) {
    return Object.keys(data.players).filter(id => {
        const p = data.players[id];
        return p.alive !== false && p.role !== 'dummy';
    });
}

async function startEmergencyMeeting() {
    const data = await loadGame();

    if (!data.gameState.started || data.gameState.impostorsWon || data.gameState.crewmatesWon) {
        logDebug("Emergency meeting rejected: Game not actively running.");
        io.emit('Err', { error: 'cannot call an emergency meeting right now' });
        return;
    }

    if (data.gameState.emergencyMeeting) {
        logDebug("Emergency meeting rejected: Meeting already underway.");
        return;
    }

    if (data.activeSabotages.o2.depleted || data.activeSabotages.reactor.meltdown) {
        logDebug("Emergency meeting rejected: Crisis is underway.");
        return;
    }


    logDebug("Emergency meeting started.");
    clearEmergencyMeetingTimer();
    emergencyVotes = {};

    const countdown = emergencyCountdownSeconds;
    const endTime = Date.now() + (countdown * 1000);

    data.gameState.emergencyMeeting = true;
    data.gameState.emergencyMeetingEndTime = endTime;
    await saveGame(data);

    io.emit('emergency_ack', { countdown, endTime, players: buildEmergencyRoster(data) });
    io.emit('game_data_request', data.gameState);

    emergencyMeetingTimer = setTimeout(async () => {
        logDebug("Emergency meeting timer concluded.");
        emergencyMeetingTimer = null;
        await resolveEmergencyMeeting({ votes: tallyEmergencyVotes() });
    }, countdown * 1000);
}

async function resolveEmergencyMeeting(resultData) {
    const data = await loadGame();

    if (!data.gameState.emergencyMeeting) {
        return;
    }

    clearEmergencyMeetingTimer();

    data.gameState.emergencyMeeting = false;
    data.gameState.emergencyMeetingEndTime = 0;
    emergencyVotes = {};

    const votes = (resultData && typeof resultData.votes === 'object' && resultData.votes) ? resultData.votes : {};
    const entries = Object.entries(votes).filter(([, count]) => typeof count === 'number' && count > 0);

    let ejectedId = null;
    let _result = "tie"; // Default result if votes are empty or tied

    if (entries.length > 0) {
        const topCount = Math.max(...entries.map(([, count]) => count));
        const topEntries = entries.filter(([, count]) => count === topCount);

        // If there's a single winner
        if (topEntries.length === 1) {
            const winner = topEntries[0][0];
            
            if (winner === 'skip') {
                _result = "skip";
            } else {
                _result = "ejection";
                ejectedId = winner;
            }
        } else {
            // Multiple top vote-getters = Tie
            _result = "tie";
        }
    }

    // Process ejection if valid player
    if (ejectedId && data.players[ejectedId] && data.players[ejectedId].alive) {
        data.players[ejectedId].alive = false;
        data.gameState.alivePlayers = Math.max(0, data.gameState.alivePlayers - 1);
        if (data.players[ejectedId].impostor) {
            data.gameState.aliveImpostors = Math.max(0, data.gameState.aliveImpostors - 1);
        }

        evaluateWinConditions(data, {
            crewWin: "THE CREW EJECTED EVERY IMPOSTOR",
            impostorWin: "THE IMPOSTORS OVERWHELMED THE CREW"
        });
    }

    data.gameState.lastEjection = {
        result: _result,
        playerId: ejectedId,
        playerName: ejectedId && data.players[ejectedId] ? data.players[ejectedId].username : null,
        wasImpostor: ejectedId && data.players[ejectedId] ? !!data.players[ejectedId].impostor : null
    };

    await saveGame(data);
    
    // FIXED: Calculate cooldown duration and convert to absolute end-timestamp
    const cooldownSeconds = btoActive ? betaTestingOverride.meetingCooldown : data.settings.emergencyCooldown;
    cooldownTime = Date.now() + (cooldownSeconds * 1000);

    io.emit('emergency_result', {
        ejected: ejectedId,
        players: data.players,
        gameState: data.gameState,
        result: _result,
        cooldownEndTime: cooldownTime
    });

    // Always broadcast the fresh game state - alive/impostor counts and the
    // emergencyMeeting flag just changed regardless of whether anyone won.
    io.emit('game_data_request', data.gameState);

    if (!data.gameState.started && (data.gameState.crewmatesWon || data.gameState.impostorsWon)) {
        io.emit('game_over', {
            winner: data.gameState.crewmatesWon ? 'crewmates' : 'impostors',
            reason: 'emergency_meeting'
        });
    }
}

app.post(`/env`, (req, res) => {
    return res.json({ip:IP, port:PORT});
})

function ejectHtml(textToType = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Text Reveal</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000000;
    overflow: hidden;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  
  .stage {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000000;
  }

  /* -------------------- Starfield -------------------- */
  .particles { 
    position: absolute; 
    inset: 0; 
    overflow: hidden; 
    pointer-events: none; 
    z-index: 1; 
  }
  
  .particle {
    position: absolute;
    width: 2px; 
    height: 2px;
    background: rgba(255, 255, 255, 0.6);
    border-radius: 50%;
    animation: drift linear infinite;
    opacity: 0;
  }
  
  @keyframes drift {
    0% { opacity: 0; transform: translateY(0); }
    10% { opacity: 0.7; }
    90% { opacity: 0.35; }
    100% { opacity: 0; transform: translateY(-40px); }
  }

  .vignette {
    position: absolute; 
    inset: 0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.85) 100%);
    pointer-events: none;
    z-index: 3;
  }

  /* -------------------- Text & Cursor -------------------- */
  .scene {
    position: relative;
    z-index: 2;
    text-align: center;
    width: 90vw;
    font-size: clamp(1.6rem, 5vw, 3rem);
    color: rgba(255, 255, 255, 0.85);
    font-weight: 300;
    letter-spacing: 0.05em;
    white-space: pre-wrap;
  }

  .cursor {
    display: inline-block;
    width: 3px;
    height: 1em;
    margin-left: 4px;
    vertical-align: text-bottom;
    background: rgba(255, 255, 255, 0.85);
    animation: blink 0.9s steps(1) infinite;
  }
  
  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="particles" id="particles"></div>
    
    <div class="scene">
      <span id="text-container"></span>
    </div>
    
    <div class="vignette"></div>
  </div>
<script>
  // Passed from server/generator
  const TEXT_TO_TYPE = \`${textToType.replace(/`/g, '\\`')}\`;

  // ---------------- Starfield ----------------
  const particleContainer = document.getElementById('particles');
  const starCount = 90;
  
  for (let i = 0; i < starCount; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 2 + 1;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.top = Math.random() * 100 + 'vh';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 8) + 's';
    particleContainer.appendChild(p);
  }

  // ---------------- Text Writing Logic ----------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function typeText(el, text, speed) {
    return new Promise((resolve) => {
      el.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      let i = 0;

      function step() {
        if (i < text.length) {
          el.textContent = text.slice(0, i + 1);
          el.appendChild(cursor);
          i++;
          // Slight randomness to typing speed makes it feel more organic
          const variableSpeed = speed + (Math.random() * 30 - 15);
          setTimeout(step, variableSpeed);
        } else {
          // Leave the cursor blinking after typing finishes
          setTimeout(resolve, 400);
        }
      }
      step();
    });
  }

  // ---------------- Initialization ----------------
  async function runSequence() {
    const textContainer = document.getElementById('text-container');
    
    // Wait a brief moment for the stars to settle in before typing begins
    await sleep(2000);
    
    // Type the text at 65ms per character (adjust as needed)
    await typeText(textContainer, TEXT_TO_TYPE, 65);

    await sleep(2000);
    window.location.href = "/emergency"
  }

  runSequence();
</script>
</body>
</html>`;
}

app.get("/revealResults", async (req, res) => {
    const data = await loadGame();
    const last = data.gameState.lastEjection;

    let text;
    if (!last || last.result === 'tie') {
        text = "NO ONE WAS EJECTED\n(TIE VOTE)";
    } else if (last.result === 'skip') {
        text = "NO ONE WAS EJECTED";
    } else if (last.result === 'ejection' && last.playerName) {
        text = `${last.playerName.toUpperCase()} WAS EJECTED\n${last.wasImpostor ? "THEY WERE THE IMPOSTOR" : "THEY WERE NOT THE IMPOSTOR"}`;
    } else {
        text = "NO ONE WAS EJECTED";
    }

    return res.send(ejectHtml(text));
})

app.post("/addDummyPlayers", async (req, res) => {
    const data = await loadGame();

    let amnt = parseInt(req.body.amnt);

    if (isNaN(amnt)) {
        logDebug(`Dummy player request failed: Invalid amount provided.`);
        return res.status(400).json({ message: "Invalid amount provided." });
    }

    if (data.players[req.cookies.session]?.username !== data.gameState.host) {
        logDebug(`Unauthorised dummy player request by ${req.cookies.session}`);
        return res.status(401).json({ message: "401 Unauthorized" });
    }

    const currentCount = Object.keys(data.players).length;
    const maxSlots = 20;
    const availableSlots = maxSlots - currentCount;

    const toAdd = Math.min(amnt, availableSlots);

    if (toAdd <= 0) {
        return res.status(200).json({ message: "No more slots available." });
    }

    for (let i = 1; i <= toAdd; i++) {
        const id = crypto.randomUUID();
        let dmnKey = `dummy_${Date.now()}_${i}`;

        data.players[dmnKey] = {
            id: id,
            username: `dummy_${currentCount + i}`,
            role: "dummy",
            alive: true,
            tasksCompleted: 0,
            totalTasks: data.settings.tasks,
            tasks: []
        };
    }

    const totalCount = Object.keys(data.players).length;
    data.gameState.playerCount = totalCount;
    data.gameState.alivePlayers = totalCount;

    await saveGame(data);
    io.emit('game_data_request', data.gameState);
    logDebug(`Host successfully added ${toAdd} dummy players.`);
    res.status(200).json({ message: `Successfully added ${toAdd} dummy players.` });
});


app.post("/addDummyServers", async (req, res) => {
    const data = await loadGame();


    if (data.players[req.cookies.session]?.username !== data.gameState.host) {
        logDebug(`Unauthorised dummy server request by ${req.cookies.session}`);
        return res.status(401).json({ message: "401 Unauthorized." });
    }

    const dummy_servers = {
        "o2_dummy": "o2",
        "reactor_dummy": "reactor",
        "emergency_dummy": "emergency"
    };

    const existingValues = Object.values(data.servers);
    for (let [key, value] of Object.entries(dummy_servers)) {
        if (existingValues.includes(value)) {
            delete dummy_servers[key];
        }
    }
    data.servers = { ...data.servers, ...dummy_servers };
    await saveGame(data);

    io.emit('game_data_request', data.gameState);
    logDebug(`Host successfully added servers.`);
    res.status(200).json({ message: `Successfully added dummy servers` });
});


function parseSocketCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        const name = parts[0].trim();
        const value = parts[1] ? parts[1].trim() : '';
        cookies[name] = decodeURIComponent(value);
    });
    return cookies;
}

io.on("connection", async (socket) => {
    const rawCookieHeader = socket.request.headers.cookie;
    const cookies = parseSocketCookies(rawCookieHeader);
    const data = await loadGame();
    
    logDebug(`Client connected via socket (session: ${cookies.session || 'unknown'})`);
    if (cookies.session) socket.join(cookies.session);

    try {
        if (data.players[cookies.session]) {
            socket.emit("player_data_request", data.players[cookies.session]);
            socket.emit("game_data_request", data.gameState);

            let targetEndTimestamp = 0;

            if (data.activeSabotages.o2 && data.activeSabotages.o2.sabotaged && !data.activeSabotages.o2.depleted) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.o2.timeLeft * 1000);
            } else if (data.activeSabotages.reactor && data.activeSabotages.reactor.sabotaged && !data.activeSabotages.reactor.meltdown) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.reactor.timeLeft * 1000);
            }

            logDebug(`client requested sabotage data (sent via connect for ${cookies.session})`);
            socket.emit("sabotage_data_request", {
                sData: data.activeSabotages,
                endTime: targetEndTimestamp
            });
            socket.emit("sabotage_cooldown", { endTime: sabCooldownTime });

            if (data.gameState.emergencyMeeting && data.gameState.emergencyMeetingEndTime) {
                socket.emit("emergency_ack", {
                    countdown: Math.max(0, Math.round((data.gameState.emergencyMeetingEndTime - Date.now()) / 1000)),
                    endTime: data.gameState.emergencyMeetingEndTime,
                    players: buildEmergencyRoster(data)
                });
            }
        }
        else if (validateServer(data.servers, cookies.session)) {
            // Previously server/room devices (o2, reactor, emergency) fell through
            // to the "username not found" branch below and got an unwarranted Err on every connect.
            logDebug(`Server device connected via socket (session: ${cookies.session}, role: ${data.servers[cookies.session]})`);

            let targetEndTimestamp = 0;

            if (data.activeSabotages.o2 && data.activeSabotages.o2.sabotaged && !data.activeSabotages.o2.depleted) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.o2.timeLeft * 1000);
            } else if (data.activeSabotages.reactor && data.activeSabotages.reactor.sabotaged && !data.activeSabotages.reactor.meltdown) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.reactor.timeLeft * 1000);
            }

            socket.emit("sabotage_data_request", {
                sData: data.activeSabotages,
                endTime: targetEndTimestamp
            });
            socket.emit("game_data_request", data.gameState);
            socket.emit("servers_data_request", {
                servers: data.servers,
                operational: isGameOperational(data.servers)
            });
        }
        else {
            logDebug(`Socket connection rejected: username not found for session ${cookies.session}`);
            socket.emit("Err", { error: "username not found." });
        }
        
        socket.on("sabotage", async (sabdata) => {
            const reject = (reason) => {
                socket.emit('Err', { error: reason });
                socket.emit('sabotage_ack', { ok: false, reason });
            };
            try {
                // Fresh data (not the connection-time snapshot), and the session is checked
                // inside the try so an unknown socket can't throw out of the handler.
                const freshData = await loadGame();
                const player = freshData.players[cookies.session];
                if (!player || !player.impostor) {
                    logDebug(`Unauthorised sabotage start request from ${cookies.session}. requested sabotage: ${sabdata ? sabdata.type : 'unknown'}`);
                    return reject('You are not impostor');
                }
                logDebug(`Client (${cookies.session}) requested sabotage: ${sabdata ? sabdata.type : 'unknown'}`);
                if (!freshData.gameState.started) return reject('The game is not running');
                if (freshData.gameState.emergencyMeeting) return reject('No sabotage during an emergency meeting');
                if (!sabdata || (sabdata.type !== 'o2' && sabdata.type !== 'reactor') ||
                    typeof sabdata.countdown !== 'number' || !Number.isFinite(sabdata.countdown)) {
                    return reject('invalid sabotage payload');
                }
                if (Date.now() < sabCooldownTime) {
                    logDebug("Sabotage request denied, cooldown not over yet");
                    return reject('Premature request, cooldown not over yet');
                }
                if (freshData.activeSabotages.o2.sabotaged || freshData.activeSabotages.reactor.sabotaged ||
                    freshData.activeSabotages.reactor.meltdown || freshData.activeSabotages.o2.depleted) {
                    return reject('already sabotaged');
                }
                // The delay is the impostor's choice, but the server keeps it in a sane range.
                const countdown = Math.min(120, Math.max(5, Math.round(sabdata.countdown)));
                await startSabotageCountdown(sabdata.type, countdown);
                socket.emit('sabotage_ack', { ok: true });
            } catch (e) {
                logError("Sabotage error:", e);
                socket.emit('Err', { error: e.message });
            }
        });

        socket.on("emergency", async () => {
            try {
                // Only known sessions can call a meeting. Results are never accepted from a client:
                // the server tallies votes itself (timer, or as soon as everyone has voted).
                const d = await loadGame();
                if (!d.players[cookies.session] && !validateServer(d.servers, cookies.session)) {
                    logDebug(`Unauthorised emergency meeting request from ${cookies.session || 'unknown'}`);
                    socket.emit('Err', { error: 'not part of this game' });
                    return;
                }
                logDebug(`Client (${cookies.session}) triggered emergency meeting.`);
                if (Date.now() >= cooldownTime) {
                    await startEmergencyMeeting();
                } else {
                    logDebug("Received premature emergency meeting request, denying.");
                    socket.emit('Err', { error: 'emergency meeting on cooldown' });
                }
            } catch (e) {
                logError("Emergency error:", e);
                socket.emit('Err', { error: e.message });
            }
        });

        socket.on("settings_data_request", async (payload) => {
            const data = await loadGame();
            // FIXED: Corrected typo in event name (was "settings_data_requst")
            socket.emit("settings_data_request", data.settings);
            logDebug(`Settings data sent to ${cookies.session}`);
        })
        socket.emit("settings_data_request", data.settings);
        
        socket.on("cast_vote", async (payload) => {
            try {
                const voterId = cookies.session;
                const d = await loadGame();

                if (!d.gameState.emergencyMeeting) {
                    socket.emit('Err', { error: 'no emergency meeting in progress' });
                    socket.emit('vote_ack', { ok: false });
                    return;
                }

                const voter = d.players[voterId];
                if (!voter) {
                    socket.emit('Err', { error: 'no player session' });
                    socket.emit('vote_ack', { ok: false });
                    return;
                }
                if (voter.alive === false) {
                    socket.emit('Err', { error: 'dead players cannot vote' });
                    socket.emit('vote_ack', { ok: false });
                    return;
                }
                if (Object.prototype.hasOwnProperty.call(emergencyVotes, voterId)) {
                    socket.emit('Err', { error: 'you already voted' });
                    socket.emit('vote_ack', { ok: false });
                    return;
                }

                const target = payload && payload.target;
                const targetIsSkip = target === 'skip';
                const targetPlayer = !targetIsSkip ? d.players[target] : null;

                if (!targetIsSkip && (!targetPlayer || targetPlayer.alive === false)) {
                    socket.emit('Err', { error: 'invalid vote target' });
                    socket.emit('vote_ack', { ok: false });
                    return;
                }

                logDebug(`${voterId} cast a vote for ${targetIsSkip ? 'skip' : target}`);
                emergencyVotes[voterId] = targetIsSkip ? 'skip' : target;
                socket.emit('vote_ack', { ok: true });

                io.emit('emergency_vote_update', { players: buildEmergencyRoster(d) });

                const requiredVoters = emergencyVoterIds(d);
                const allVoted = requiredVoters.length > 0 &&
                    requiredVoters.every(id => Object.prototype.hasOwnProperty.call(emergencyVotes, id));

                if (allVoted) {
                    logDebug("All votes have been cast. Resolving emergency meeting early.");
                    await resolveEmergencyMeeting({ votes: tallyEmergencyVotes() });
                }
            } catch (e) {
                logError("Cast vote error:", e);
                socket.emit('Err', { error: e.message });
                socket.emit('vote_ack', { ok: false });
            }
        });
        
        socket.on("im-dead", async () => {
            logDebug(`${cookies.session} requested death`);
            try {
                // Reload fresh instead of mutating the connection-scoped snapshot from
                // above - that snapshot could be stale by the time this fires and would
                // silently clobber anything else that changed in the meantime on save.
                const d = await loadGame();
                const player = d.players[cookies.session];

                if (!player) {
                    logDebug(`Death request failed: No user found for session ${cookies.session}`);
                    socket.emit("Err", { error: "No user found with associated session." });
                    socket.emit("imdead_ack", { ok: false });
                    return;
                }

                if (player.alive === false) {
                    socket.emit("imdead_ack", { ok: true });
                    return;
                }

                player.alive = false;
                d.gameState.alivePlayers = Math.max(0, d.gameState.alivePlayers - 1);
                if (player.impostor) {
                    d.gameState.aliveImpostors = Math.max(0, d.gameState.aliveImpostors - 1);
                }

                evaluateWinConditions(d, {
                    crewWin: "THE CREW ELIMINATED EVERY IMPOSTOR",
                    impostorWin: "THE IMPOSTORS OVERWHELMED THE CREW"
                });

                await saveGame(d);
                logDebug(`${cookies.session} death confirmed`);

                socket.emit("imdead_ack", { ok: true });
                socket.emit("player_data_request", player);
                io.emit("game_data_request", d.gameState);

                if (!d.gameState.started && (d.gameState.crewmatesWon || d.gameState.impostorsWon)) {
                    io.emit('game_over', {
                        winner: d.gameState.crewmatesWon ? 'crewmates' : 'impostors',
                        reason: 'death'
                    });
                }
            } catch (e) {
                logError("im-dead error:", e);
                socket.emit("Err", { error: e.message });
                socket.emit("imdead_ack", { ok: false });
            }
        })
        
        socket.on("fix_sabotage", async (payload) => {
            logDebug(`Client (${cookies.session}) requested to fix sabotage: ${payload ? payload.type : 'unknown'}`);
            try {
                if (!payload || !payload.type) {
                    socket.emit('Err', { error: 'invalid fix payload' });
                    socket.emit('fix_ack', {ok:false})
                    return;
                }
                const fixed = await fixSabotage(payload.type);
                socket.emit('fix_ack', { ok: fixed });

                const freshData = await loadGame();
                const sabCooldownSeconds = btoActive ? betaTestingOverride.sabotageCooldown : freshData.settings.sabotageCooldown;
                const cooldownEndTime = Date.now() + (sabCooldownSeconds * 1000);
                sabCooldownTime = cooldownEndTime;
                freshData.activeSabotages.cooldown = cooldownEndTime;

                await saveGame(freshData);
                io.emit("sabotage_cooldown", { endTime: cooldownEndTime });
            } catch (e) {
                logError("Fix sabotage error:", e);
                socket.emit('Err', { error: e.message });
                socket.emit('fix_ack', {ok:false})
            }
        });

        socket.on("unstable", (payload) => {
            // This previously lived on io.on("unstable", ...) at module scope, outside any
            // connection handler - io never emits custom app events itself (only sockets do),
            // and "socket" wasn't even in scope there, so this could never actually fire.
            logDebug(`Received unstable signal from ${cookies.session}, rebroadcasting for emergency server.`);
            io.emit("unstable", { active: true });
        });
        
        socket.on('disconnect', () => {
            logDebug(`Client disconnected (session: ${cookies.session || 'unknown'}).`);
        });
    }
    catch (err) {
        logError("Socket connection error:", err);
        socket.emit("Err", { error: err.message });
    }
});

app.get("/win", async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    const isHost = !!(session && data.players[session] && data.players[session].username === data.gameState.host);

    logDebug(`Client (${session}) fetching win screen.`);
    if (data.gameState.crewmatesWon) {
        return res.send(renderCrewmateWinHtml(data, isHost));
    }
    return res.send(renderImpostorWinHtml(data, isHost));
})

app.get('/reveal', async (req, res) => {
    let data = await loadGame();
    const session = req.cookies.session;
    const player = data.players[session];

    if (!player) {
        return res.status(401).json({ error: "401 unauthorized" });
    }

    if (!data.gameState.started) {
        await delay(1000);
        data = await loadGame();
        
        if (!data.gameState.started) {
            return res.redirect("/waiting");
        }
    }

    logDebug(`Client (${session}) fetched role reveal. Role: ${player.impostor ? 'Impostor' : 'Crewmate'}`);
    return res.send(renderRoleRevealHtml(player.impostor));
});

app.get("/waiting", async (req, res) => {
    const session = req.cookies.session;
    const data = await loadGame();
    if (session) {
        if (data.players[session]) {
            if (data.players[session].username == data.gameState.host) {
                return res.sendFile(path.join(__dirname, 'public', 'host_lobby.html'));
            }
        }

        if (validateServer(data.servers, session)) {
            return res.sendFile(path.join(__dirname, 'public', 'server.html'));
        }
        else {
            logDebug(`Server tried to log in, denied access for session ${session}`);
        }

        return res.sendFile(path.join(__dirname, 'public', 'waiting_lobby.html'));
    }

    logDebug("Unauthorised access attempt to /waiting.");
    res.status(401).json({ error: "401 unauthorised" })
})

function parseSettingsArray(rawSettings, playerCount) {
    if (!Array.isArray(rawSettings)) return null;

    const [impostorsRaw, cdRaw, tasksRaw, emergencyRaw, sabotageCdRaw, emergencyCdRaw] = rawSettings;

    const impostors = parseInt(impostorsRaw, 10);
    const meltdownCountdown = parseInt(cdRaw, 10);
    const tasks = parseInt(tasksRaw, 10);
    const emergencyCountdown = emergencyRaw === undefined
        ? DEFAULT_SETTINGS.emergencyCountdown
        : parseInt(emergencyRaw, 10);
    const sabotageCooldown = sabotageCdRaw === undefined
        ? DEFAULT_SETTINGS.sabotageCooldown
        : parseInt(sabotageCdRaw, 10);

    const emergencyCooldown = emergencyCdRaw === undefined
        ? DEFAULT_SETTINGS.emergencyCooldown
        : parseInt(emergencyCdRaw, 10);

    if (isNaN(impostors) || isNaN(meltdownCountdown) || isNaN(tasks) || isNaN(emergencyCountdown) ||
        isNaN(sabotageCooldown) || isNaN(emergencyCooldown)) return null;
    if (impostors < 0 || meltdownCountdown < 0 || tasks < 0 || emergencyCountdown < 0 ||
        sabotageCooldown < 0 || emergencyCooldown < 0) return null;
    if (playerCount !== undefined && impostors >= playerCount) return null;

    return { impostors, meltdownCountdown, tasks, emergencyCountdown, sabotageCooldown, emergencyCooldown };
}

app.get("/help", async (req, res) => {
    const value = req.query.topic;

    if (value === undefined || value === "" || value == "help") {
        let data = await fs.readFile(path.join(__dirname, "src", `help.md`), "utf-8");
        let entries = await fs.readdir(path.join(__dirname, "src"), { withFileTypes: true });
        let htmlContent = marked.parse(data);
        htmlContent += "<hr>\n<h3>3 - Follow these links</h3>\n<ul>"
        entries = entries.filter(entry => entry.isFile()).map(entry => path.parse(entry.name).name);
        entries.forEach(el => {
            htmlContent += `<li><a href="/help?topic=${el}">${el}</a></li>\n`;
        });
        htmlContent += "</ul>\n<hr>"
        
        return res.send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8"/>
                <title>help</title>
            </head>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/simpledotcss@2/simple.min.css">
            <body>
                <div id="content">
                    ${htmlContent}             
                </div>
                <style>
                    #content{
                        max-width: 100% !important;
                        width: 100% !important;
                    }
                </style>
            </body>
            </html>
        `);
    }
    try {
        const filePath = path.join(__dirname, "src", `${req.query.topic}.md`);
        const data = await fs.readFile(filePath, "utf-8");

        const htmlContent = marked.parse(data);

        return res.send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8"/>
                <title>${req.query.topic}</title>
            </head>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/simpledotcss@2/simple.min.css">
            <body>
                <div id="content">${htmlContent}</div>
                <style>
                    #content{
                        max-width: 100% !important;
                        width: 100% !important;
                    }
                </style>
            </body>
            </html>
        `);
    } catch (err) {
        if (err && err.code === "ENOENT") {
            return res.send({ err: "400 - bad request" }); 
        }
        throw err;
    }
})


app.post("/start", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            logDebug(`Unauthorised game start attempt by ${session}`);
            return res.status(401).json({ message: "Get outa here you dont have credentials clown.", failed: true });
        }

        if (!isGameOperational(data.servers)) {
            logDebug("Game start blocked: Operational servers are missing.");
            return res.status(202).json({ message: "Cant start the game - o2, reactor or emergency server is missing. (Or all of them idk)", failed: true })
        }

        const allPlayerIds = Object.keys(data.players);
        const totalRealPlayers = allPlayerIds.length;

        const parsedSettings = parseSettingsArray(req.body.settings, totalRealPlayers);
        if (!parsedSettings && Array.isArray(req.body.settings) && parseInt(req.body.settings[0], 10) >= totalRealPlayers) {
            const asked = parseInt(req.body.settings[0], 10);
            logDebug(`Game start blocked: ${asked} impostors requested but only ${totalRealPlayers} players.`);
            return res.status(400).json({ message: `Too many impostors: you set ${asked} but only ${totalRealPlayers} player${totalRealPlayers === 1 ? '' : 's'} joined. Impostors must be fewer than players.`, failed: true });
        }
        if (!parsedSettings) {
            logDebug("Game start blocked: Invalid or missing settings.");
            return res.status(400).json({ message: "Invalid or missing settings.", failed: true });
        }

        const taskLibrary = await loadTaskLibrary();
        const taskPool = eligibleUnits(taskLibrary);
        if (parsedSettings.tasks > 0 && taskPool.length === 0) {
            logDebug("Game start blocked: no tasks with generated links.");
            return res.status(202).json({ message: "Cant start the game - no tasks available. Add minigame .html files to the minigames folder (or set tasks to 0).", failed: true });
        }
        const tasksPerPlayer = Math.min(parsedSettings.tasks, taskPool.length);
        const taskWarning = tasksPerPlayer < parsedSettings.tasks
            ? ` (Only ${taskPool.length} tasks exist, so everyone got ${tasksPerPlayer} instead of ${parsedSettings.tasks}.)`
            : '';

        logDebug(`Starting game with ${totalRealPlayers} players.`);
        
        clearEmergencyMeetingTimer();

        data.settings = { ...DEFAULT_SETTINGS, ...data.settings, ...parsedSettings };
        const targetImpostors = data.settings.impostors;
        // No beta override exists for the meltdown countdown, so it always comes from the host's setting.
        meltdownCountdownSeconds = data.settings.meltdownCountdown;
        emergencyCountdownSeconds = btoActive ? betaTestingOverride.emergencyCountdown : data.settings.emergencyCountdown;

        let roleDeck = [];
        for (let i = 0; i < allPlayerIds.length; i++) {
            if (i < targetImpostors) {
                roleDeck.push("impostor");
            } else {
                roleDeck.push("crewmate");
            }
        }

        for (let i = roleDeck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const temp = roleDeck[i];
            roleDeck[i] = roleDeck[j];
            roleDeck[j] = temp;
        }

        let totalTasks = 0;

        allPlayerIds.forEach((id, index) => {
            const assignedRole = roleDeck[index];
            data.players[id].impostor = (assignedRole === "impostor");
            data.players[id].role = assignedRole === "impostor" ? "impostor" : "crewmate";
            data.players[id].totalTasks = tasksPerPlayer;
            data.players[id].tasksCompleted = 0;
            data.players[id].tasks = pickRandomTasks(taskLibrary, taskPool, tasksPerPlayer);
            // Impostors get tasks too (cover), but theirs never count towards the crew total.
            if (assignedRole !== "impostor") totalTasks += tasksPerPlayer;
            
            logDebug(`${id} is now ${assignedRole}`);
        });


        data.gameState.started = true;
        data.gameState.impostorsWon = false;
        data.gameState.crewmatesWon = false;
        data.gameState.aliveImpostors = targetImpostors;
        data.gameState.playerCount = totalRealPlayers;
        data.gameState.alivePlayers = totalRealPlayers;
        data.gameState.totalTasks = totalTasks;
        data.gameState.completedTasks = 0;
        data.gameState.emergencyMeeting = false;
        data.gameState.emergencyMeetingEndTime = 0;
        data.gameState.lastEjection = null;

        data.activeSabotages = {
            o2: { ...DEFAULT_SABOTAGES.o2 },
            reactor: { ...DEFAULT_SABOTAGES.reactor }
        };

        await saveGame(data);
        
        const meetingCooldownSeconds = btoActive
            ? betaTestingOverride.emergencyCountdown
            : (data.settings.emergencyCooldown + 20);
        cooldownTime = Date.now() + (meetingCooldownSeconds * 1000);
        
        logDebug("Game successfully started.");
        io.emit("start", {started:true})
        io.emit("game_data_request", data.gameState);
        return res.status(200).json({ message: "May a fine game take place, among us!" + taskWarning, failed: false });
    });
});

// Players scan a QR code (links are in tasks.txt, made by the server) which opens /task/<token> in their browser.
// GET validates the scan but never changes state, so link previewers, QR apps and prefetching can't
// complete a task by accident. It then shows the task's minigame, which POSTs back to the same URL
// (via completeTask()) to actually complete the task.
app.get("/task/:token", async (req, res) => {
    try {
        const data = await loadGame();
        const library = await loadTaskLibrary();
        const check = checkTaskScan(data, library, req.cookies.session, String(req.params.token || ''));
        if (check.outcome) {
            return res.status(check.outcome.status).send(renderTaskResultHtml(check.outcome));
        }
        return res.send(await renderMinigameHtml(check.libTask, String(req.params.token || '')));
    } catch (error) {
        logError("Error showing task page:", error);
        return res.status(500).send(renderTaskResultHtml({
            accepted: false, title: 'Task declined', message: 'Server error, try scanning again.', next: '/dashboard'
        }));
    }
});

app.post("/task/:token", async (req, res) => {
    let outcome;
    try {
        await withGameLock(async () => {
            const data = await loadGame();
            const library = await loadTaskLibrary();
            const session = req.cookies.session;

            outcome = processTaskScan(data, library, session, String(req.params.token || ''));
            logDebug(`Task scan by ${session || 'unknown'}: ${outcome.accepted ? 'ACCEPTED' : 'DECLINED'} - ${outcome.message}`);
            if (!outcome.accepted) return;

            const crewWon = evaluateTaskWin(data);
            await saveGame(data);
            io.emit('game_data_request', data.gameState);

            if (crewWon) {
                logDebug("All crew tasks completed. Crewmates win!");
                io.emit('game_over', { winner: 'crewmates', reason: 'tasks' });
            }
        });
    } catch (error) {
        logError("Error processing task scan:", error);
        outcome = { accepted: false, status: 500, title: 'Task declined', message: 'Server error, try scanning again.', next: '/dashboard' };
    }
    return res.status(outcome.status).send(renderTaskResultHtml(outcome));
});

// Read by the fuel_engine minigame: the tank counts as filled once this player has done every step
// before fuel_engine in its task (normally refuel_tank, bound to it in tasks.json).
// ---- floor plan editor (host only) ---------------------------------------------------------------
// The host draws the building in the editor (public/editor/). Saving checks the plan with the same rules
// the editor shows (public/editor/geometry.js), writes map/map.json, and updates tasks.json: every task
// placed in a room is switched on with that room as its location, every task left off the plan is
// switched off.
const MAP_DIR = path.join(ROOT, 'map');
const MAP_FILE = path.join(MAP_DIR, 'map.json');
const REF_DIR = path.join(MAP_DIR, 'refs');
const REF_NAME = /^[a-f0-9]{24}\.(png|jpg|webp|gif|svg)$/;
const REF_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

function isHostRequest(req, data) {
    const p = req.cookies.session ? data.players[req.cookies.session] : null;
    return !!(p && data.gameState.host && p.username === data.gameState.host);
}

async function readPlan() {
    try {
        return JSON.parse(await fs.readFile(MAP_FILE, 'utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') logError('Could not read map/map.json:', e);
        return null;
    }
}

// Every task as the editor sees it: a unit (a single task, a bound chain or a repeating task) and its
// parts, one per QR code.
function editorUnits(library) {
    return library.units.map(u => {
        const tasks = u.tasks.map(id => library.byId.get(id));
        const name = tasks.map(t => (t.repeat > 1 ? `${t.name} ×${t.repeat}` : t.name)).join(' → ');
        return {
            id: u.id, name, problem: u.usable ? '' : (tasks.every(t => !t.enabled) ? '' : u.problem),
            parts: u.steps.map(s => {
                const t = library.byId.get(s.task);
                return { code: t.steps[s.n - 1].label, task: s.task, name: stepName(t, s.n) };
            })
        };
    });
}

// Strict shape check of a plan coming from the browser. Throws with a message on anything unexpected.
function sanitizePlan(raw) {
    const fail = m => { throw new Error(m); };
    const id = v => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : fail('Bad id.'));
    const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : fail('Bad text.'));
    const num = v => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : fail('Bad number.'));
    const pt = v => (Array.isArray(v) && v.length === 2 ? [num(v[0]), num(v[1])] : fail('Bad point.'));
    const group = v => (v === undefined || v === null ? undefined : id(v));
    const list = (v, max) => (Array.isArray(v) && v.length <= max ? v : fail('Too many items.'));
    if (!raw || typeof raw !== 'object') fail('No plan.');
    return {
        version: 1,
        floors: list(raw.floors, 50).map(f => ({
            id: id(f.id),
            name: text(f.name, 60),
            reference: f.reference ? {
                file: REF_NAME.test(f.reference.file) ? f.reference.file : fail('Bad reference image.'),
                x: num(f.reference.x), y: num(f.reference.y), w: num(f.reference.w), h: num(f.reference.h),
                opacity: Math.max(0, Math.min(1, num(f.reference.opacity))), visible: f.reference.visible !== false
            } : null,
            lines: list(f.lines, 5000).map(l => ({ id: id(l.id), type: l.type === 'door' ? 'door' : 'wall', a: pt(l.a), b: pt(l.b), group: group(l.group) })),
            rooms: list(f.rooms, 1000).map(r => ({ id: id(r.id), name: text(r.name, 60), at: pt(r.at), group: group(r.group) })),
            pins: list(f.pins, 1000).map(p => ({ id: id(p.id), code: text(p.code, 80), at: pt(p.at), group: group(p.group) }))
        }))
    };
}

app.get("/floorplan", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.redirect('/host');
    return res.sendFile(path.join(__dirname, 'public', 'editor', 'floorplan.html'));
});

app.get("/floorplan/data", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.status(401).json({ error: 'Only the host can edit the floor plan.' });
    const library = await loadTaskLibrary();
    return res.json({ plan: await readPlan(), units: editorUnits(library), gameRunning: !!data.gameState.started });
});

app.post("/floorplan/reference", express.raw({ type: Object.keys(REF_TYPES), limit: '15mb' }), async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.status(401).json({ error: 'Only the host can edit the floor plan.' });
    const ext = REF_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send a PNG, JPG, WebP, GIF or SVG image.' });
    await fs.mkdir(REF_DIR, { recursive: true });
    const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(REF_DIR, file), req.body);
    return res.json({ file });
});

app.get("/floorplan/ref/:file", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.sendStatus(401);
    if (!REF_NAME.test(req.params.file)) return res.sendStatus(404);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return res.sendFile(path.join(REF_DIR, req.params.file), err => { if (err && !res.headersSent) res.sendStatus(404); });
});

app.post("/floorplan/save", express.json({ limit: '5mb' }), async (req, res) => {
    try {
        let result;
        await withGameLock(async () => {
            const data = await loadGame();
            if (!isHostRequest(req, data)) { result = { status: 401, body: { error: 'Only the host can edit the floor plan.' } }; return; }
            if (data.gameState.started) { result = { status: 409, body: { error: 'A game is running. Save the floor plan after it ends.' } }; return; }
            let plan;
            try { plan = sanitizePlan(req.body && req.body.plan); }
            catch (e) { result = { status: 400, body: { error: `The plan could not be read: ${e.message}` } }; return; }

            const library = await loadTaskLibrary();
            const units = editorUnits(library);
            const { problems, placements } = validatePlan(plan, units);
            if (problems.length) { result = { status: 422, body: { error: 'The plan has problems.', problems } }; return; }

            // map/map.json, written whole and then swapped in
            await fs.mkdir(MAP_DIR, { recursive: true });
            await fs.writeFile(MAP_FILE + '.tmp', JSON.stringify(plan, null, 1), 'utf-8');
            await fs.rename(MAP_FILE + '.tmp', MAP_FILE);
            const usedRefs = new Set(plan.floors.map(f => f.reference && f.reference.file).filter(Boolean));
            try {
                for (const f of await fs.readdir(REF_DIR)) if (REF_NAME.test(f) && !usedRefs.has(f)) await fs.unlink(path.join(REF_DIR, f));
            } catch (e) { if (e.code !== 'ENOENT') logError('Could not tidy map/refs:', e); }

            // tasks.json: placed -> on, with the room as location; not placed -> off
            const manyFloors = plan.floors.length > 1;
            const where = code => { const p = placements.get(code); return p ? (manyFloors ? `${p.room}, ${p.floorName}` : p.room) : null; };
            const updates = {}, enabled = [], disabled = [];
            for (const t of library.tasks) {
                const spots = t.steps.map(st => where(st.label));
                const on = spots.every(Boolean);
                updates[t.id] = on ? { enabled: true, location: t.repeat > 1 ? spots : spots[0] }
                    : { enabled: false, location: t.repeat > 1 ? t.steps.map(st => (st.locationFrom === 'tasks.json' ? st.location : '')) : (t.steps[0].locationFrom === 'tasks.json' ? t.steps[0].location : '') };
                (on ? enabled : disabled).push(t.id);
            }
            await updateTaskConfig(updates);
            logDebug(`Floor plan saved: ${plan.floors.length} floor(s); tasks on: ${enabled.join(', ') || 'none'}; off: ${disabled.join(', ') || 'none'}.`);
            result = { status: 200, body: { ok: true, enabled, disabled } };
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        logError('Error saving the floor plan:', error);
        return res.status(500).json({ error: 'Server error while saving. Nothing was changed.' });
    }
});

// ---- minigame test bench (host only) ---------------------------------------------------------------
// /minigames lists every minigame and plays it in a preview frame. Nothing is recorded: the preview gets
// its own completeTask() that only tells the page, and a pretend fuel tank for fuel_engine.
const PREVIEW_NAME = /^_?[A-Za-z0-9_-]+$/;

function previewSnippet() {
    return `<script>(function(){
var q=new URLSearchParams(location.search),sent=false,framed=window.parent!==window;
function tell(m){if(framed)parent.postMessage(m,location.origin);}
window.__MINIGAME_PREVIEW__=true;
window.completeTask=function(delay){if(sent)return;sent=true;setTimeout(function(){tell({type:'minigame-complete'});
 if(!framed){var d=document.createElement('div');d.textContent='✓ Finished (test run, nothing was recorded)';d.style.cssText='position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#16a34a;color:#fff;font:700 14px system-ui,sans-serif;padding:9px 16px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.5)';document.body.appendChild(d);}
},delay==null?1500:delay);};
var full=q.get('tank')!=='empty',f=window.fetch;
window.fetch=function(u){if(String(u).indexOf('/fill-rocket')===0)return Promise.resolve(new Response(JSON.stringify({filled:full,gallons:12.5}),{headers:{'Content-Type':'application/json'}}));return f.apply(this,arguments);};
window.addEventListener('error',function(e){tell({type:'minigame-error',message:String(e.message||e)});});
window.addEventListener('unhandledrejection',function(e){tell({type:'minigame-error',message:String(e.reason&&e.reason.message||e.reason)});});
})();</script>`;
}

app.get("/minigames", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.redirect('/host');
    return res.sendFile(path.join(__dirname, 'public', 'editor', 'minigames.html'));
});

app.get("/minigames/list", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.status(401).json({ error: 'Only the host can test minigames.' });
    const library = await loadTaskLibrary();
    const games = library.tasks.map(t => {
        const unit = library.units.find(u => u.tasks.includes(t.id));
        const chain = unit && unit.tasks.length > 1 ? unit.tasks : null;
        return {
            id: t.id, name: t.name, file: t.file, enabled: t.enabled, repeat: t.repeat,
            locations: t.steps.map(st => st.location), chain, draft: false
        };
    });
    let drafts = [];
    try {
        drafts = (await fs.readdir(MINIGAMES_DIR)).filter(f => f.startsWith('_') && f.toLowerCase().endsWith('.html') && PREVIEW_NAME.test(f.slice(0, -5)))
            .map(f => ({ id: f.slice(0, -5), name: f.slice(1, -5).replace(/[-_]+/g, ' ').trim() || f, file: f, enabled: false, repeat: 1, locations: [], chain: null, draft: true }));
    } catch (e) { /* no folder */ }
    return res.json({ games: [...games, ...drafts] });
});

app.get("/minigames/play/:id", async (req, res) => {
    const data = await loadGame();
    if (!isHostRequest(req, data)) return res.redirect('/host');
    const id = String(req.params.id || '');
    if (!PREVIEW_NAME.test(id)) return res.sendStatus(404);
    let html;
    try { html = await fs.readFile(path.join(MINIGAMES_DIR, id + '.html'), 'utf-8'); }
    catch (e) { return res.status(404).send('No such minigame.'); }
    const snippet = previewSnippet();
    res.set('Cache-Control', 'no-store');
    return res.send(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + snippet) : snippet + html);
});

app.get("/fill-rocket", async (req, res) => {
    const data = await loadGame();
    const player = data.players[req.cookies.session];
    if (!player) {
        return res.status(401).json({ error: "401 unauthorised" });
    }
    const mine = Array.isArray(player.tasks) ? player.tasks : [];
    let filled = false;
    for (const e of mine) {
        if (!Array.isArray(e.steps)) continue;
        const i = e.steps.findIndex(s => s.task === 'fuel_engine');
        if (i >= 0) { filled = e.steps.slice(0, i).every(s => s.done); break; }
    }
    return res.json({ filled, gallons: 12.5 });
});

async function reset(req, res){
    let data = await loadGame();

    if (!req.cookies.session || !data.players[req.cookies.session]) {
        logDebug("Unauthorised reset attempt: No valid session.");
        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>401</title></head>
            <body>
                <h1>401 forbidden</h1>
                <p>the user has no associated session.</p>
                <a href="/"><button>back to login</button></a>
            </body>
            </html>
        `;

        res.set('Content-Type', 'text/html');
        return res.status(401).send(dynamicHtml);
    }
    if (data.players[req.cookies.session].username != data.gameState.host) {
        logDebug(`Unauthorised reset attempt by non-host: ${req.cookies.session}`);
        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>401</title></head>
            <body>
                <h1>401 forbidden</h1>
                <p>You are not host</p>
                <a href="/"><button>back to login</button></a>
            </body>
            </html>
        `;

        res.set('Content-Type', 'text/html');
        return res.status(401).send(dynamicHtml);
    }

    logDebug("Host initiated full reset of game state.");
    clearAllSabotageTimers();
    clearEmergencyMeetingTimer();
    meltdownCountdownSeconds = DEFAULT_SETTINGS.meltdownCountdown;
    emergencyCountdownSeconds = DEFAULT_SETTINGS.emergencyCountdown;

    data = {
        gameState: { ...DEFAULT_GAME_STATE },
        servers: {},
        players: {},
        activeSabotages: {
            o2: { ...DEFAULT_SABOTAGES.o2 },
            reactor: { ...DEFAULT_SABOTAGES.reactor }
        },
        settings: { ...DEFAULT_SETTINGS }
    };

    await saveGame(data);
    // Everything just got wiped - make sure every connected client (players, host, and
    // room devices) hears about it instead of being left showing stale state.
    io.emit('game_data_request', data.gameState);
    io.emit('servers_data_request', { servers: data.servers, operational: false });
    io.emit('sabotage_data_request', { sData: data.activeSabotages, endTime: 0 });
    io.emit('restart_game', {});

    let dynamicHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Status</title></head>
        <body>
            <p>Json file is now reset.</p>
            <a href="/"><button>back to login</button></a>
        </body>
        </html>
    `;

    res.set('Content-Type', 'text/html');
    return res.send(dynamicHtml);
}

app.post("/reset", async (req, res) => {
    return reset(req, res);
})


app.get("/reset", async (req, res) => {
    if(!btoActive){
        return res.sendStatus(405);
    }
    return reset(req, res);
})

// Directory scan defence
const chaoticStatuses = [100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 307, 308, 401, 403, 400, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 420, 421, 422, 423, 425, 426, 429, 431, 451, 500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511];
const suspiciousKeywords = ['admin', '.env', '.git', 'wp-', 'backup', '.php', '.aspx', '.jsp'];

const corporatePrankStore = {};
const STRIKE_LIMIT = 3;

app.use((req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!corporatePrankStore[clientIp]) {
        corporatePrankStore[clientIp] = { strikes: 0, sessionLimited: false };
    }

    if (corporatePrankStore[clientIp].sessionLimited) {
        const randomStatus = chaoticStatuses[Math.floor(Math.random() * chaoticStatuses.length)];
        logDebug(`[PERMA-TROLL] IP ${clientIp} requested ${req.path} -> Sending status ${randomStatus}`);
        const targetKb = Math.floor(Math.random() * (800 - 300 + 1)) + 300;
        const byteLength = targetKb * 1024;
        const randomDataString = crypto.randomBytes(byteLength).toString('hex').slice(0, byteLength);

        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>Haha</title></head>
            <body>
                <p>You thought you found something didnt you</p>
                <p style="display:none">while im here, let me add some characters so that you wont be able to tell if you got the correct page or not</p>
                <p style="display:none">${randomDataString}</p>
            </body>
            </html>
        `;

        res.set('Content-Type', 'text/html');
        return res.status(randomStatus).send(dynamicHtml);
    }

    const isScannerPath = suspiciousKeywords.some(keyword =>
        req.path.toLowerCase().includes(keyword)
    );

    if (isScannerPath) {
        corporatePrankStore[clientIp].strikes += 1;
        logDebug(`[WARN] Scanner hit from IP ${clientIp} on ${req.path}. Strikes: ${corporatePrankStore[clientIp].strikes}/${STRIKE_LIMIT}`);

        if (corporatePrankStore[clientIp].strikes >= STRIKE_LIMIT) {
            corporatePrankStore[clientIp].sessionLimited = true;
            logDebug(`[LOCKDOWN] IP ${clientIp} is now session limited!`);
        }

        const randomStatus = chaoticStatuses[Math.floor(Math.random() * chaoticStatuses.length)];
        const targetKb = Math.floor(Math.random() * (800 - 300 + 1)) + 300;
        const byteLength = targetKb * 1024;
        const randomDataString = crypto.randomBytes(byteLength).toString('hex').slice(0, byteLength);

        let dynamicHtml = `
            <!DOCTYPE html>
            <html>
            <head><title>Haha</title></head>
            <body>
                <p>You thought you found something didnt you</p>
                <p style="display:none">while im here, let me add some characters so that you wont be able to tell if you got the correct page or not</p>
                <p style="display:none">${randomDataString}</p>
            </body>
            </html>
        `;

        res.set('Content-Type', 'text/html');
        return res.status(randomStatus).send(dynamicHtml);
    }

    next();
});