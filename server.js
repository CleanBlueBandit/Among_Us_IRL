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
const host_pass = "$2b$10$xvIai9yC6zGdmBhNq5Dzt.n48g1dP8h1wRM/J9VGZz.YcWZuDo3m2";

var timeLeft = 0

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use((req, res, next) => {
    if (req.path.endsWith('.html')) {
        return res.status(403).json({ error: "Direct access to HTML files is forbidden." });
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
    tasks: 30
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
    console.log(`Server running on http://localhost:${PORT}`);
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
        const dynamicHtml = `
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

    await saveGame(data);
    res.status(200).json({ message: `Successfully added ${toAdd} dummy players.` });
});

app.get("/socket", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'socket.html'));
})

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
        return res.sendFile(path.join(__dirname, 'public', 'waiting_lobby.html'));
    }
    res.status(401).json({error:"401 unauthorised"})
})

// Settings array sent by the waiting-room UI is built from
// document.querySelectorAll('[id*="_val"]') in DOM order, which is:
//   [0] impostor_val      -> number of impostors
//   [1] cd_val             -> meltdown/sabotage countdown (seconds)
//   [2] tasks_val          -> total tasks per player
//   [3] dummy_val          -> leftover testing control, NOT a game setting
// Only indices 0-2 are consumed here; index 3 (if present) is ignored.
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

    // Can't have more impostors than players (and never fewer than 1 once a game starts).
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
        });

        data.gameState.started = true;
        data.gameState.aliveImpostors = targetImpostors;
        data.gameState.playerCount = totalPlayers;
        data.gameState.alivePlayers = totalPlayers;

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
    if(data.players[req.cookies.session].username != data.gameState.host){
        return res.status(401).json({ message : "wth is wrong with you? why would you want to erase the game?", access : "denied. (ofc)", response : "401 unauthorised."})
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
            completedTasks: 0,
            host: "",
            aliveImpostors: 0,
            playerCount: 0,
            alivePlayers: 0
        },
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
    res.status(200).json({message:"json file is reset."})

})