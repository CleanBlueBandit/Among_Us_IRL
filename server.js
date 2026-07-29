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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if(!process.env.PORT){
    console.log(".env file is not configured properly")
}

const PORT = process.env.PORT;
const IP = process.env.IP;
const host_pass = process.env.PASSWORD_HASH;
const protocol = process.env.PROTOCOL;



const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use((req, res, next) => {
    if (req.path.endsWith('.html')) {
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
    emergencyCountdown: 30
};

// Authoritative duration (seconds) for stage 2 of a sabotage - the crisis
// phase that runs until impostors win. Set from settings.meltdownCountdown
// whenever a game starts, rather than trusting the client-supplied
// per-sabotage countdown for this stage.
let meltdownCountdownSeconds = DEFAULT_SETTINGS.meltdownCountdown;

// Authoritative duration (seconds) for the discussion/voting phase of an
// emergency meeting. Set from settings.emergencyCountdown whenever a game
// starts, same pattern as meltdownCountdownSeconds above.
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
    alivePlayers: 0
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

async function loadGame() {
    try {
        const rawData = await fs.readFile('./game.json', 'utf-8');
        const data = JSON.parse(rawData);

        if (!data.players) {
            data.players = {};
        }
        if (!data.gameState) {
            data.gameState = { ...DEFAULT_GAME_STATE };
        } else {
            // backfill any missing fields on old/partial saves
            data.gameState = { ...DEFAULT_GAME_STATE, ...data.gameState };
        }
        if (!data.activeSabotages) {
            data.activeSabotages = {
                o2: { ...DEFAULT_SABOTAGES.o2 },
                reactor: { ...DEFAULT_SABOTAGES.reactor }
            };
        }
        if (!data.servers) {
            data.servers = {};
        }
        if (!data.settings) {
            data.settings = { ...DEFAULT_SETTINGS };
        }
        return data;
    } catch (error) {
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
}

httpServer.listen(PORT, () => {
    console.log(`Server running on ${protocol}://${IP}:${PORT}`);
});

app.post('/enter', async (req, res) => {
    try {
        await withGameLock(async () => {
            const session = req.cookies.session;
            const data = await loadGame();

            const username = req.body.username ? String(req.body.username) : "Anonymous Crewmate";

            if (session && typeof session === 'string' && data.players[session]) {
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

            return res.status(200).json({ message: "username created!" })
        });
    } catch (error) {
        console.error("Error managing game entry:", error);
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

            if (!(await bcrypt.compare(password, host_pass))) {
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
                return res.sendFile(path.join(__dirname, 'public', 'server.html'))
            }

            if (data.gameState.host != "") {
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

            return res.status(200).json({ message: "wellcome, host!" })
        });
    } catch (error) {
        console.error("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})

app.get("/end", async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if (!data.players[session] || data.players[session].username != data.gameState.host) {
        return res.sendStatus(401);
    }

    data.gameState.started = false;

    await saveGame(data);
    res.sendStatus(200);
})


app.get("/restart", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            return res.status(401).json({ message: "You are not the host.", failed: true });
        }


        clearAllSabotageTimers();
        clearEmergencyMeetingTimer();

        for (const id of Object.keys(data.players)) {
            const p = data.players[id];
            p.impostor = false;
            p.role = "none";
            p.alive = true;
            p.tasksCompleted = 0;
            p.totalTasks = data.settings.tasks;
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

        return res.redirect("/waiting")
    });
});

app.post("/restart", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            return res.status(401).json({ message: "You are not the host.", failed: true });
        }


        clearAllSabotageTimers();
        clearEmergencyMeetingTimer();

        for (const id of Object.keys(data.players)) {
            const p = data.players[id];
            p.impostor = false;
            p.role = "none";
            p.alive = true;
            p.tasksCompleted = 0;
            p.totalTasks = data.settings.tasks; // settings untouched, just re-applied
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
    const playerData = data.players[session];
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
    return res.sendFile(path.join(__dirname, 'public', 'crewmate.html'));
})

app.get('/logout', async (req, res) => {
    const session = req.cookies.session;

    await withGameLock(async () => {
        const data = await loadGame();
        if (data.players[session]) {
            if (data.gameState.host == data.players[session].username) {
                data.gameState.host = "";
                data.gameState.started = false;
            }
            delete data.players[session];
            data.gameState.playerCount = Math.max(0, data.gameState.playerCount - 1);
            data.gameState.alivePlayers = Math.max(0, data.gameState.alivePlayers - 1);
            await saveGame(data);
        }

        if (data.servers && data.servers.hasOwnProperty(session)) {
            delete data.servers[session];
            await saveGame(data);
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
        return res.status(401).json({ err: "401 unauthorised" })
    }
    data.servers[req.cookies.session] = sf;
    await saveGame(data);
    return res.status(200).json({ ok: true });
})

app.get("/o2", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
    }
    return res.status(200).sendFile(publicPath("o2"));
})

app.get("/reactor", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
    }
    return res.status(200).sendFile(publicPath("reactor"));
})

app.get("/control%20panel", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
    }
    return res.status(200).sendFile(publicPath("control panel"));
})

app.get("/emergency", async (req, res) => {
    const data = await loadGame();
    if (!validateServer(data.servers, req.cookies.session)) {
        return res.status(401).json({ err: "401 unauthorised" })
    }
    return res.status(200).sendFile(publicPath("emergency"));
})

// One independent timer per sabotage type, so o2 and reactor can run concurrently.
const sabotageTimers = new Map(); // type -> intervalId




async function startSabotageCountdown(type, seconds) {
    if (!type || typeof seconds !== 'number' || seconds <= 0) return;
    if (type !== 'o2' && type !== 'reactor') return;

    // Only clear THIS type's existing timer, not every sabotage's timer.
    if (sabotageTimers.has(type)) {
        clearInterval(sabotageTimers.get(type));
        sabotageTimers.delete(type);
    }

    const data = await loadGame();

    // Stage 1: The Delay Phase Begins
    data.activeSabotages[type].sabotaged = true;
    data.activeSabotages[type].timeLeft = seconds;

    // Ensure the crisis hasn't started yet
    if (type === 'o2') data.activeSabotages.o2.depleted = false;
    else data.activeSabotages.reactor.meltdown = false;

    await saveGame(data);

    const timer = setInterval(async () => {
        try {
            const d = await loadGame();
            const sab = d.activeSabotages[type];

            // Failsafe if the sabotage was cleared (e.g. fixed) from elsewhere
            if (!sab || !sab.sabotaged) {
                clearInterval(timer);
                sabotageTimers.delete(type);
                return;
            }

            // Tick down the timer
            sab.timeLeft = Math.max(0, sab.timeLeft - 1);
            await saveGame(d);
            io.emit('sabotage_tick', { type, timeLeft: sab.timeLeft });

            // What happens when a timer hits 0?
            if (sab.timeLeft <= 0) {

                // Check which phase we just finished
                const isCrisisPhase = (type === 'o2' && sab.depleted) ||
                                      (type === 'reactor' && sab.meltdown);

                if (!isCrisisPhase) {
                    // STAGE 1 FINISHED: Start the Crisis Phase!
                    if (type === 'o2') sab.depleted = true;
                    else sab.meltdown = true;

                    // Stage 2's duration is the authoritative meltdownCountdown
                    // setting, not the client-supplied stage-1 "seconds" value.
                    sab.timeLeft = meltdownCountdownSeconds;
                    await saveGame(d);

                    // Tell the clients that the crisis has officially started so their UI updates
                    const targetEndTime = Date.now() + (meltdownCountdownSeconds * 1000);
                    io.emit('sabotage_data_request', {
                        sData: d.activeSabotages,
                        endTime: targetEndTime
                    });

                } else {
                    // STAGE 2 FINISHED: The crewmates failed. Game over!
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

                    // Push the final o2/reactor depleted/meltdown flags so
                    // clients update their UI even if they never reconnect.
                    io.emit('sabotage_data_request', {
                        sData: d.activeSabotages,
                        endTime: 0
                    });

                    // Push the updated gameState (impostorsWon, started, etc.)
                    // to everyone, not just clients that (re)connect later.
                    io.emit('game_data_request', d.gameState);

                    if (type === 'o2') {
                        io.emit('game_over', { winner: 'impostors', reason: 'o2' });
                    } else {
                        io.emit('reactor_meltdown', {});
                        io.emit('game_over', { winner: 'impostors', reason: 'reactor' });
                    }

                    // Clean up this type's interval only
                    clearInterval(timer);
                    sabotageTimers.delete(type);
                }
            }
        } catch (e) {
            console.error('Error in sabotage timer:', e);
        }
    }, 1000);

    sabotageTimers.set(type, timer);
}

// Crew successfully repairs a sabotage before its timer runs out.
async function fixSabotage(type) {
    if (!type || (type !== 'o2' && type !== 'reactor')) return false;

    if (sabotageTimers.has(type)) {
        clearInterval(sabotageTimers.get(type));
        sabotageTimers.delete(type);
    }

    const d = await loadGame();
    if (!d.activeSabotages[type] || !d.activeSabotages[type].sabotaged) {
        return false; // nothing to fix
    }

    d.activeSabotages[type] = type === 'o2'
        ? { sabotaged: false, depleted: false, timeLeft: 0 }
        : { sabotaged: false, meltdown: false, timeLeft: 0 };
    await saveGame(d);

    io.emit('sabotage_fixed', { type });
    return true;
}

function clearAllSabotageTimers() {
    for (const t of sabotageTimers.values()) {
        clearInterval(t);
    }
    sabotageTimers.clear();
}

// A single timer for the discussion/voting phase of an emergency meeting -
// only one meeting can be in progress at a time.
let emergencyMeetingTimer = null;

function clearEmergencyMeetingTimer() {
    if (emergencyMeetingTimer) {
        clearTimeout(emergencyMeetingTimer);
        emergencyMeetingTimer = null;
    }
}

// Called when the emergency device (or a player) requests a meeting.
async function startEmergencyMeeting() {
    const data = await loadGame();

    if (!data.gameState.started || data.gameState.impostorsWon || data.gameState.crewmatesWon) {
        io.emit('Err', { error: 'cannot call an emergency meeting right now' });
        return;
    }

    if (data.gameState.emergencyMeeting) {
        // A meeting is already underway - ignore duplicate calls.
        return;
    }

    clearEmergencyMeetingTimer();

    // Discussion time is the authoritative setting, not something the caller supplies.
    const countdown = emergencyCountdownSeconds;
    const endTime = Date.now() + (countdown * 1000);

    data.gameState.emergencyMeeting = true;
    data.gameState.emergencyMeetingEndTime = endTime;
    await saveGame(data);

    io.emit('emergency_ack', { countdown, endTime });

    emergencyMeetingTimer = setTimeout(async () => {
        emergencyMeetingTimer = null;
        // Discussion time is up - ask the emergency device for the final vote tally.
        io.emit('emergency', { requestResults: true });
    }, countdown * 1000);
}

// Called once the emergency device hands over the vote tally, whether that
// happens because we asked (countdown ran out) or prematurely (the device
// pushed results early, e.g. everyone voted before time ran out).
//
// Expected shape: { votes: { [playerId]: count, skip: count } }
// The highest-voted key wins the ejection, unless there's a tie for first
// place or the winner is "skip" - in either case nobody is ejected.
async function resolveEmergencyMeeting(resultData) {
    const data = await loadGame();

    if (!data.gameState.emergencyMeeting) {
        // No meeting in progress (already resolved, or none was ever called) - ignore.
        return;
    }

    clearEmergencyMeetingTimer();

    data.gameState.emergencyMeeting = false;
    data.gameState.emergencyMeetingEndTime = 0;

    const votes = (resultData && typeof resultData.votes === 'object' && resultData.votes) ? resultData.votes : {};
    const entries = Object.entries(votes).filter(([, count]) => typeof count === 'number' && count > 0);

    let ejectedId = null;

    if (entries.length > 0) {
        const topCount = Math.max(...entries.map(([, count]) => count));
        const topEntries = entries.filter(([, count]) => count === topCount);

        // Only eject if there's a single, unambiguous top vote-getter who isn't "skip".
        if (topEntries.length === 1 && topEntries[0][0] !== 'skip') {
            ejectedId = topEntries[0][0];
        }
    }

    if (ejectedId && data.players[ejectedId] && data.players[ejectedId].alive) {
        data.players[ejectedId].alive = false;
        data.gameState.alivePlayers = Math.max(0, data.gameState.alivePlayers - 1);
        if (data.players[ejectedId].impostor) {
            data.gameState.aliveImpostors = Math.max(0, data.gameState.aliveImpostors - 1);
        }
    }

    await saveGame(data);

    io.emit('emergency_result', {
        ejected: ejectedId,
        players: data.players,
        gameState: data.gameState
    });
}


app.post(`/env`, (req, res) => {
    return res.json({ip:IP, port:PORT});
})


app.post("/addDummyPlayers", async (req, res) => {
    const data = await loadGame();

    let amnt = parseInt(req.body.amnt);

    if (isNaN(amnt)) {
        return res.status(400).json({ message: "Invalid amount provided." });
    }

    if (data.players[req.cookies.session]?.username !== data.gameState.host) {
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

            socket.emit("sabotage_data_request", {
                sData: data.activeSabotages,
                endTime: targetEndTimestamp
            });

            if (data.gameState.emergencyMeeting && data.gameState.emergencyMeetingEndTime) {
                socket.emit("emergency_ack", {
                    countdown: Math.max(0, Math.round((data.gameState.emergencyMeetingEndTime - Date.now()) / 1000)),
                    endTime: data.gameState.emergencyMeetingEndTime
                });
            }
        }
        else {
            socket.emit("Err", { error: "username not found." });
        }
        socket.on("sabotage", async (sabdata) => {
            try {
                if (!sabdata || !sabdata.type || typeof sabdata.countdown !== 'number') {
                    socket.emit('Err', { error: 'invalid sabotage payload' });
                    socket.emit('sabotage_ack', {ok:false})
                    return;
                }
                if(data.activeSabotages.reactor.sabotaged || data.activeSabotages.reactor.sabotaged || data.activeSabotages.reactor.meltdown || data.activeSabotages.o2.depleted){
                    socket.emit('Err', { error: 'already sabotaged' });
                    socket.emit('sabotage_ack', {ok:false})
                }
                // delegate countdown handling
                await startSabotageCountdown(sabdata.type, sabdata.countdown);
                socket.emit('sabotage_ack', { ok:true });
            } catch (e) {
                socket.emit('Err', { error: e.message });
            }
        });
        socket.on("emergency", async (payload) => {
            try {
                const hasResults = payload && typeof payload === 'object' && payload.votes && typeof payload.votes === 'object';

                if (hasResults) {
                    // The emergency device is handing over the (possibly premature)
                    // final vote tally - resolve the meeting right away regardless
                    // of whether the discussion countdown has actually elapsed.
                    await resolveEmergencyMeeting(payload);
                    return;
                }

                // No vote data attached - this is a request to call a new meeting.
                await startEmergencyMeeting();
            } catch (e) {
                socket.emit('Err', { error: e.message });
            }
        });
        socket.on("im-dead", async () => {
            if(!data.players[cookies.session]){
                socket.emit("Err", {error:"No user found with associated session."})
                socket.emit("imdead_ack", {ok:false});
                return;
            }
            data.players[cookies.session].alive = false;
            socket.emit("imdead_ack", {ok:true});
            await saveGame(data);
        })
        socket.on("fix_sabotage", async (payload) => {
            try {
                if (!payload || !payload.type) {
                    socket.emit('Err', { error: 'invalid fix payload' });
                    socket.emit('fix_ack', {ok:false})
                    return;
                }
                const fixed = await fixSabotage(payload.type);
                socket.emit('fix_ack', { ok: fixed });
            } catch (e) {
                socket.emit('Err', { error: e.message });
                socket.emit('fix_ack', {ok:false})
            }
        });
        socket.on('disconnect', () => {
            console.log('Client disconnected.');
        });
    }
    catch (err) {
        socket.emit("Err", { error: err.message });
    }
});

app.get("/win", async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    const isHost = !!(session && data.players[session] && data.players[session].username === data.gameState.host);

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
            console.log("Server tried to log in, denied access.")
        }

        return res.sendFile(path.join(__dirname, 'public', 'waiting_lobby.html'));
    }

    res.status(401).json({ error: "401 unauthorised" })
})

function parseSettingsArray(rawSettings, playerCount) {
    if (!Array.isArray(rawSettings)) {
        return null;
    }

    const [impostorsRaw, cdRaw, tasksRaw, emergencyRaw] = rawSettings;

    const impostors = parseInt(impostorsRaw, 10);
    const meltdownCountdown = parseInt(cdRaw, 10);
    const tasks = parseInt(tasksRaw, 10);
    // 4th slot is optional so older clients that only send 3 settings still
    // work; falls back to the default discussion time.
    const emergencyCountdown = emergencyRaw === undefined
        ? DEFAULT_SETTINGS.emergencyCountdown
        : parseInt(emergencyRaw, 10);

    if (isNaN(impostors) || isNaN(meltdownCountdown) || isNaN(tasks) || isNaN(emergencyCountdown)) {
        return null;
    }

    if (impostors < 0 || meltdownCountdown < 0 || tasks < 0 || emergencyCountdown < 0) {
        return null;
    }

    if (playerCount !== undefined && impostors >= playerCount) {
        return null;
    }

    return { impostors, meltdownCountdown, tasks, emergencyCountdown };
}

app.post("/start", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            return res.status(401).json({ message: "Get outa here you dont have credentials clown.", failed: true });
        }

        if (!isGameOperational(data.servers)) {
            return res.status(202).json({ message: "Cant start the game, o2 and reactor are offline.", failed: true })
        }

        const playerIds = Object.keys(data.players);
        const totalPlayers = playerIds.length;

        const parsedSettings = parseSettingsArray(req.body.settings, totalPlayers);
        if (!parsedSettings) {
            return res.status(400).json({ message: "Invalid or missing settings.", failed: true });
        }

        // A fresh game means any leftover timers from a previous round must die.
        clearAllSabotageTimers();
        clearEmergencyMeetingTimer();

        data.settings = parsedSettings;
        const targetImpostors = data.settings.impostors;

        // Lock in the crisis-phase duration for the round from the host's settings.
        meltdownCountdownSeconds = data.settings.meltdownCountdown;

        // Lock in the emergency-meeting discussion duration for the round.
        emergencyCountdownSeconds = data.settings.emergencyCountdown;

        let roleDeck = [];
        for (let i = 0; i < totalPlayers; i++) {
            if (i < targetImpostors) {
                roleDeck.push("impostor");
            } else {
                roleDeck.push("crewmate");
            }
        }

        let totalTasks = 0;

        for (let i = roleDeck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const temp = roleDeck[i];
            roleDeck[i] = roleDeck[j];
            roleDeck[j] = temp;
        }

        playerIds.forEach((id, index) => {
            const assignedRole = roleDeck[index];
            data.players[id].impostor = (assignedRole === "impostor");
            data.players[id].role = assignedRole === "impostor" ? "impostor" : "crewmate";
            data.players[id].totalTasks = data.settings.tasks;
            data.players[id].tasksCompleted = 0;
            totalTasks += data.settings.tasks;
        });

        data.gameState.started = true;
        data.gameState.impostorsWon = false;
        data.gameState.crewmatesWon = false;
        data.gameState.aliveImpostors = targetImpostors;
        data.gameState.playerCount = totalPlayers;
        data.gameState.alivePlayers = totalPlayers;
        data.gameState.totalTasks = totalTasks;
        data.gameState.completedTasks = 0;
        data.gameState.emergencyMeeting = false;
        data.gameState.emergencyMeetingEndTime = 0;

        // Reset any stale sabotage state from a previous round
        data.activeSabotages = {
            o2: { ...DEFAULT_SABOTAGES.o2 },
            reactor: { ...DEFAULT_SABOTAGES.reactor }
        };

        await saveGame(data);

        return res.status(200).json({ message: "May a fine game take place, among us!", failed: false });
    });
});

app.get("/reset", async (req, res) => {
    let data = await loadGame();

    if (!req.cookies.session || !data.players[req.cookies.session]) {
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
    // Kill any in-flight sabotage timers so they can't keep writing
    // to the freshly-reset game.json.
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
        console.log(`[PERMA-TROLL] IP ${clientIp} requested ${req.path} -> Sending status ${randomStatus}`);
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
        console.log(`[WARN] Scanner hit from IP ${clientIp} on ${req.path}. Strikes: ${corporatePrankStore[clientIp].strikes}/${STRIKE_LIMIT}`);

        if (corporatePrankStore[clientIp].strikes >= STRIKE_LIMIT) {
            corporatePrankStore[clientIp].sessionLimited = true;
            console.log(`[LOCKDOWN] IP ${clientIp} is now session limited!`);
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