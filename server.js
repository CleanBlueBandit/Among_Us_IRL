import express from 'express';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import 'dotenv/config';
import { renderCrewmateWinHtml, renderImpostorWinHtml } from './winscreen.js';
import { renderRoleRevealHtml } from './roleReveal.js';
import { debuglog } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const btoActive = true;

let cooldownTime = Date.now();

const betaTestingOverride = {
    "emergencyCountdown": 30,
    "meetingCooldown": 40
}


// --- LOGGING SYSTEM ---
const DEBUG_LOG = path.join(__dirname, 'debug.log');
const ERROR_LOG = path.join(__dirname, 'error.log');

function logDebug(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[DEBUG] [${timestamp}] ${message}`;
    console.log(logMsg);
    // Fire and forget to avoid blocking the event loop
    fs.appendFile(DEBUG_LOG, logMsg + '\n', 'utf-8').catch(e => console.error("Logger error:", e));
}

function logError(message, error = "") {
    const timestamp = new Date().toISOString();
    const errorStr = error instanceof Error ? (error.stack || error.message) : String(error);
    const logMsg = `[ERROR] [${timestamp}] ${message} ${errorStr}`;
    console.error(logMsg);
    // Fire and forget
    fs.appendFile(ERROR_LOG, logMsg + '\n', 'utf-8').catch(e => console.error("Logger error:", e));
}
// ----------------------

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
    logError("PASSWORD_HASH variable missing in .env, defaulting to the password \"Password\"");
    host_pass = "$2b$10$Okp8WCSOnQ23BEJMYWKcCO.L8QkpABXWEFCrcN3PYVvKwUwsgF7D2";
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
app.use(express.json());
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
    emergencyCooldown : 30
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
        if (!data.settings) data.settings = { ...DEFAULT_SETTINGS };
        
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
    logDebug("data saved");
}

httpServer.listen(PORT, () => {
    logDebug(`Server connected. Express server running on ${protocol}://${IP}:${PORT}`);
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
            };

            data.players[UUID] = playerData;
            data.gameState.playerCount = Object.keys(data.players).length;
            data.gameState.alivePlayers = Object.keys(data.players).length;

            await saveGame(data);
            // Anyone already watching the lobby (host included) needs to see the new player count.
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
                return res.sendFile(path.join(__dirname, 'public', 'server.html'))
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

app.get("/end", async (req, res) => {
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

app.get("/restart", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            logDebug(`Unauthorised game restart attempt by session: ${session}`);
            return res.status(401).json({ message: "You are not the host.", failed: true });
        }

        logDebug("Host restarted the game.");
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

        return res.redirect("/waiting")
    });
});

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
        return res.status(401).json({ err: "401 unauthorised" })
    }
    data.servers[req.cookies.session] = sf;
    logDebug(`${sf} server is now online and registered to session ${req.cookies.session}`);
    await saveGame(data);
    io.emit('servers_data_request', {
        servers: data.servers,
        operational: isGameOperational(data.servers)
    });
    return res.status(200).json({ ok: true });
})

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

app.get("/control%20panel", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
        
    }
    if(data.servers[req.cookies.session] != "control panel"){
            return res.redirect(data.servers[req.cookies.session])
        }
    return res.status(200).sendFile(publicPath("control panel"));
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
    clearAllSabotageTimers();
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
        return res.status(401).json({ message: "401 Unauthorized", hint: "No host - no admin controls." });
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
            totalTasks: data.settings.tasks
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

            if (data.gameState.emergencyMeeting && data.gameState.emergencyMeetingEndTime) {
                socket.emit("emergency_ack", {
                    countdown: Math.max(0, Math.round((data.gameState.emergencyMeetingEndTime - Date.now()) / 1000)),
                    endTime: data.gameState.emergencyMeetingEndTime,
                    players: buildEmergencyRoster(data)
                });
            }
        }
        else if (validateServer(data.servers, cookies.session)) {
            // Previously server/room devices (o2, reactor, emergency, control panel) fell through
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
            logDebug(`Client (${cookies.session}) requested sabotage: ${sabdata ? sabdata.type : 'unknown'}`);
            try {
                if (!sabdata || !sabdata.type || typeof sabdata.countdown !== 'number') {
                    socket.emit('Err', { error: 'invalid sabotage payload' });
                    socket.emit('sabotage_ack', {ok:false})
                    return;
                }
                // Load fresh state instead of the stale snapshot captured at connect time,
                // and check o2 (not reactor twice, as before) for an already-active sabotage.
                const freshData = await loadGame();
                if(freshData.activeSabotages.o2.sabotaged || freshData.activeSabotages.reactor.sabotaged || freshData.activeSabotages.reactor.meltdown || freshData.activeSabotages.o2.depleted){
                    socket.emit('Err', { error: 'already sabotaged' });
                    socket.emit('sabotage_ack', {ok:false})
                    return;
                }
                await startSabotageCountdown(sabdata.type, sabdata.countdown);
                socket.emit('sabotage_ack', { ok:true });
            } catch (e) {
                logError("Sabotage error:", e);
                socket.emit('Err', { error: e.message });
            }
        });
        
        socket.on("emergency", async (payload) => {
            logDebug(`Client (${cookies.session}) triggered emergency event.`);
            try {
                const hasResults = payload && typeof payload === 'object' && payload.votes && typeof payload.votes === 'object';
                if (hasResults) {
                    await resolveEmergencyMeeting(payload);
                    return;
                }
                // FIXED: Corrected condition to properly check if cooldown has elapsed
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

    const [impostorsRaw, cdRaw, tasksRaw, emergencyRaw] = rawSettings;

    const impostors = parseInt(impostorsRaw, 10);
    const meltdownCountdown = parseInt(cdRaw, 10);
    const tasks = parseInt(tasksRaw, 10);
    const emergencyCountdown = emergencyRaw === undefined
        ? DEFAULT_SETTINGS.emergencyCountdown
        : parseInt(emergencyRaw, 10);

    if (isNaN(impostors) || isNaN(meltdownCountdown) || isNaN(tasks) || isNaN(emergencyCountdown)) return null;
    if (impostors < 0 || meltdownCountdown < 0 || tasks < 0 || emergencyCountdown < 0) return null;
    if (playerCount !== undefined && impostors >= playerCount) return null;

    return { impostors, meltdownCountdown, tasks, emergencyCountdown };
}

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
            return res.status(202).json({ message: "Cant start the game - o2, reactor or emergency server is missing.", failed: true })
        }

        const allPlayerIds = Object.keys(data.players);
        const totalRealPlayers = allPlayerIds.length;

        const parsedSettings = parseSettingsArray(req.body.settings, totalRealPlayers);
        if (!parsedSettings) {
            logDebug("Game start blocked: Invalid or missing settings.");
            return res.status(400).json({ message: "Invalid or missing settings.", failed: true });
        }

        logDebug(`Starting game with ${totalRealPlayers} players.`);
        
        clearEmergencyMeetingTimer();

        data.settings = parsedSettings;
        const targetImpostors = data.settings.impostors;
        meltdownCountdownSeconds = btoActive ? betaTestingOverride.meetingCooldown : data.settings.meltdownCountdown;
        emergencyCountdownSeconds = btoActive ? betaTestingOverride.emergencyCountdown : data.settings.emergencyCountdown;

        let roleDeck = [];
        for (let i = 0; i < allPlayerIds; i++) {
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
            data.players[id].totalTasks = data.settings.tasks;
            data.players[id].tasksCompleted = 0;
            totalTasks += data.settings.tasks;
            
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
        
        // FIXED: Corrected variable name and property path
        const meetingCooldownSeconds = btoActive
            ? betaTestingOverride.emergencyCountdown
            : (data.settings.emergencyCooldown + 20);
        cooldownTime = Date.now() + (meetingCooldownSeconds * 1000);
        
        logDebug("Game successfully started.");
        io.emit("start", {started:true})
        io.emit("game_data_request", data.gameState);
        return res.status(200).json({ message: "May a fine game take place, among us!", failed: false });
    });
});

app.get("/reset", async (req, res) => {
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