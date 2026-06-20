import express from 'express';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 6767;
const IP = "0.0.0.0";
const host_pass = "$2b$10$xvIai9yC6zGdmBhNq5Dzt.n48g1dP8h1wRM/J9VGZz.YcWZuDo3m2";

var timeLeft = 0

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
    tasks: 5
};

async function loadGame() {
    try {
        const rawData = await fs.readFile('./game.json', 'utf-8');
        const data = JSON.parse(rawData);

        if (!data.players) {
            data.players = {};
        }
        if (!data.gameState) {
            data.gameState = { host: "", started: false, playerCount: 0, alivePlayers: 0 };
        }
        if (!data.activeSabotages) {
            data.activeSabotages = {
                o2: { depleted: false, timeLeft: 0 },
                reactor: { meltdown: false, timeLeft: 0 }
            };
        }
        if (!data.settings) {
            data.settings = { ...DEFAULT_SETTINGS };
        }
        return data;
    } catch (error) {
        return {
            players: {},
            gameState: { host: "", started: false, playerCount: 0, alivePlayers: 0 },
            activeSabotages: {
                o2: { depleted: false, timeLeft: 0 },
                reactor: { meltdown: false, timeLeft: 0 }
            },
            settings: { ...DEFAULT_SETTINGS }
        };
    }
}

async function saveGame(data) {
    await fs.writeFile('./game.json', JSON.stringify(data, null, 2), 'utf-8');
}

httpServer.listen(PORT, () => {
    console.log(`Server running on http://${IP}:${PORT}`);
});



app.post('/enter', async (req, res) => {
    try {
        await withGameLock(async () => {
            const session = req.cookies.session;
            const data = await loadGame();

            const username = req.body.username ? String(req.body.username) : "Anonymous Crewmate";

            if (session && typeof session === 'string' && data.players[session]) {
                return res.status(200).json({message:"username accepted!"})
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

            return res.status(200).json({message:"username created!"})
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

            if (data.gameState.host != "") {
                return res.status(400).json({error:"Host is already in the game!"})
            }


            if (!(await bcrypt.compare(password, host_pass))) {
                return res.status(401).json({error:"invalid credentials"})
            }

            if(req.body.server){
                const UUID = crypto.randomUUID();
                res.cookie('session', UUID, {
                    httpOnly: true,
                    secure: false,
                    sameSite: 'lax',
                    maxAge: 1000 * 60 * 60 * 12
                });
                data.serverIDs += UUID;
                await saveGame(data);
                return res.sendFile(path.join(__dirname, 'public', 'server.html'))
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

            return res.status(200).json({message:"wellcome, host!"})
        });
    } catch (error) {
        console.error("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})

app.get("/end", async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if(data.players[session].username != data.gameState.host){
        return res.sendStatus(401);
    }

    data.gameState.started = false;

    await saveGame(data);
    res.sendStatus(200);
})

app.get('/dashboard', async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if(!data.players[session]){
        return res.status(401).json({error:"401 unauthorised."});
    }

    if(!data.gameState.started){
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

    if(playerData.impostor){
        return res.sendFile(path.join(__dirname, 'public', 'impostor.html'));
    }
    return res.sendFile(path.join(__dirname, 'public', 'crewmate.html'));
})

app.get('/logout', async(req, res) => {
    const session = req.cookies.session;

    await withGameLock(async () => {
        const data = await loadGame();
        if (data.players && session) {
            if(data.gameState.host == data.players[session].username){
                data.gameState.host = "";
                data.gameState.started = false;
            }
            delete data.players[session];
            data.gameState.playerCount -= 1;
            await saveGame(data);
        }
    });

    res.clearCookie('session', {
        httpOnly: true
    });

    res.redirect('/');
})

app.post("/deviceFunc", (req, res) => {
    
})

// TODO: get paths for o2, reactor and control panel


let localVisualTimer = null;

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

            if (data.activeSabotages.o2.depleted) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.o2.timeLeft * 1000);
            } else if (data.activeSabotages.reactor.meltdown) {
                targetEndTimestamp = Date.now() + (data.activeSabotages.reactor.timeLeft * 1000);
            }
            socket.emit("sabotage_data_request", {
                sData: data.activeSabotages,
                endTime: targetEndTimestamp
            });
        }
        else {
            socket.emit("Err", { error: "username not found." });
        }
        socket.on('disconnect', () => {
            console.log('Client disconnected.');
        });
    }
    catch (err) {
        socket.emit("Err", { error: err.message });
    }
});

app.get("/waiting", async (req, res) => {
    const session = req.cookies.session;
    const data = await loadGame();
    if(session && data.players[session]){
        if(data.players[session].username == data.gameState.host){
            return res.sendFile(path.join(__dirname, 'public', 'host_lobby.html'));
        }
        let authorise = false;
        for (const el of data.serverIDs) {
            if (el == session) {
                authorise = true;
                break; 
            }
        }
        if(authorise){
            return res.sendFile(path.join(__dirname, 'public', 'server.html'));
        }

        return res.sendFile(path.join(__dirname, 'public', 'waiting_lobby.html'));
    }

    res.status(401).json({error:"401 unauthorised"})
})


function parseSettingsArray(rawSettings, playerCount) {
    if (!Array.isArray(rawSettings)) {
        return null;
    }

    const [impostorsRaw, cdRaw, tasksRaw] = rawSettings;

    const impostors = parseInt(impostorsRaw, 10);
    const meltdownCountdown = parseInt(cdRaw, 10);
    const tasks = parseInt(tasksRaw, 10);

    if (isNaN(impostors) || isNaN(meltdownCountdown) || isNaN(tasks)) {
        return null;
    }

    if (impostors < 0 || meltdownCountdown < 0 || tasks < 0) {
        return null;
    }

    if (playerCount !== undefined && impostors >= playerCount) {
        return null;
    }

    return { impostors, meltdownCountdown, tasks };
}

app.post("/start", async (req, res) => {
    await withGameLock(async () => {
        const session = req.cookies.session;
        const data = await loadGame();

        if (!data.players[session] || data.players[session].username != data.gameState.host) {
            return res.status(401).json({ message: "Get outa here you dont have credentials clown.", auth: false });
        }

        const playerIds = Object.keys(data.players);
        const totalPlayers = playerIds.length;

        const parsedSettings = parseSettingsArray(req.body.settings, totalPlayers);
        if (!parsedSettings) {
            return res.status(400).json({ message: "Invalid or missing settings.", auth: true });
        }

        data.settings = parsedSettings;
        const targetImpostors = data.settings.impostors;

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
        data.gameState.aliveImpostors = targetImpostors;
        data.gameState.playerCount = totalPlayers;
        data.gameState.alivePlayers = totalPlayers;
        data.gameState.totalTasks = totalTasks;

        await saveGame(data);

        startTimestampCountdown(data.settings.meltdownCountdown);

        return res.status(200).json({ message: "May a fine game take place, among us!" });
    });
});

let gameKillTimeout = null;

function startTimestampCountdown(seconds) {
    if (gameKillTimeout) clearTimeout(gameKillTimeout);

    const msToWait = seconds * 1000;
    const targetEndTime = Date.now() + msToWait;

    io.emit("sabotage_countdown_start", {
        endTime: targetEndTime
    });

    gameKillTimeout = setTimeout(async () => {
        const data = await loadGame();
        if (data.activeSabotages.o2.depleted) {
            io.emit("game_over", { winner: "impostors" });
        }
    }, msToWait);
}

app.get("/reset", async (req, res) => {
    let data = await loadGame();

    if(!req.cookies.session || !data.players[req.cookies.session]){
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
    if(data.players[req.cookies.session].username != data.gameState.host){
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
    if (gameKillTimeout) {
        clearTimeout(gameKillTimeout);
        gameKillTimeout = null;
    }

    data = {
        gameState: {
            started: false,
            impostorsWon: false,
            crewmatesWon: false,
            emergencyMeeting: false,
            totalTasks: 0,
            completedTasks: 0,
            host: "",
            aliveImpostors: 0,
            playerCount: 0,
            alivePlayers: 0
        },
        serverIDs:{},
        players: {},
        activeSabotages: {
            reactor: {
                sabotaged: false,
                meltdown: false,
                timeLeft: 0
            },
            o2: {
                sabotaged: false,
                depleted: false,
                timeLeft: 0
            }
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
