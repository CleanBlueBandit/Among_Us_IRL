import express from 'express';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';



// Constants

const PORT = 6767;
const host_pass = "amogus";

// Variables

var timeLeft = 0

// Middleware

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());




// Start server

async function loadGame() {
    try {
        const rawData = await fs.readFile('./game.json', 'utf-8');
        const data = JSON.parse(rawData);
        
        if (!data.players) {
            data.players = {};
        }
        return data;
    } catch (error) {
        return { players: {} };
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
        const session = req.cookies.session;
        const data = await loadGame();
        
        const username = req.body.username ? String(req.body.username) : "Anonymous Crewmate";

        if (session && typeof session === 'string' && data.players[session]) {
            return res.status(200).json({message:"username accepted!"})
        }

        const UUID = crypto.randomUUID();
        res.cookie('session', UUID, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 12 // 12 hours
        });

        const playerData = {
            id: UUID,
            username: username,
            alive: true,
            tasksCompleted: 0,
            totalTasks: 5,
        };

        data.players[UUID] = playerData;
        
        await saveGame(data); 
        
        return res.status(200).json({message:"username created!"})

    } catch (error) {
        console.error("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})


app.get("/host", (req, res) => {
    res.status(200).redirect("/host-login.html")
})

app.post('/enter-host', async (req, res) => {
    try {
        const session = req.cookies.session;
        const data = await loadGame();
        const username = req.body.username;
        const password = req.body.password;

        if(password != host_pass){
            return res.status(401).json({error:"invalid credentials"})
        }
        
        const UUID = crypto.randomUUID();
        res.cookie('session', UUID, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 12 // 12 hours
        });

        const playerData = {
            id: UUID,
            username: username,
            alive: true,
            tasksCompleted: 0,
            totalTasks: 5,
        };

        data.players[UUID] = playerData;
        data.gameState.host = data.players[UUID].username;
        
        await saveGame(data); 
        
        return res.status(200).json({message:"wellcome, host!"})

    } catch (error) {
        console.error("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
})

async function assignPlayerRoles() {
    const data = await loadGame();
    const playerIds = Object.keys(data.players);
    const totalPlayers = playerIds.length;

    let roleDeck = [];
    
    const targetImpostors = 2; 

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
    });

    await saveGame(data);
    
    console.log("Roles dealt perfectly and evenly across the lobby!");
}

app.get('/dashboard', async (req, res) => {
    const data = await loadGame();
    const session = req.cookies.session;
    if(!data.players[session]){
        return res.status(401).json({error:"401 unauthorised."});
    }
    const playerData = data.players[session];

    if(playerData.impostor){
        return res.redirect("impostor.html");
    }
    return res.redirect("crewmate.html")
})

app.post('/dashboard', async (req, res) => {
    try {
        const session = req.cookies.session;
        const data = await loadGame();
        
        var playerData = data.players[session];
        return res.status(200).json({
            created: true,
            id: playerData.id,
            impostor: playerData.impostor,
            username: playerData.username,
            alive: playerData.alive,
            tasksCompleted: playerData.tasksCompleted,
            totalTasks: playerData.totalTasks,
            reactor: data.activeSabotages.reactor.meltdown,
            o2: data.activeSabotages.o2.depleted,
            tCompletedTasks: data.gameState.completedTasks,
            tTotalTasks: data.gameState.totalTasks,
            timeLeft: data.activeSabotages.reactor.timeLeft + data.activeSabotages.o2.timeLeft,

        });

    } catch (error) {
        console.error("Error managing game entry:", error);
        return res.status(500).json({ error: "Internal Server Error during lobby entry." });
    }
});

app.get('/logout', async(req, res) => {
    const session = req.cookies.session;
    const data = await loadGame();
    if (data.players && session) {
        delete data.players[session];
        await saveGame(data);
    }
    res.clearCookie('session', {
        httpOnly: true
    });

    res.redirect('/');
})

let localVisualTimer = null;

app.get("/socket", (req, res) => {
    res.redirect("/socket.html");
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
        return res.redirect("waiting_lobby.html");
    }
    res.status(401).json({error:"401 unauthorised"})
})

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

