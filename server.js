import express from 'express';
import fs from 'fs/promises';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server } from 'socket.io';



// Constants

const PORT = 6767;

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
            impostor: true,
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

    try{
        if (data.players[cookies.session]) {
            socket.emit("sabotage_data_request", { sData : data.activeSabotages, time : 30})  // change this when countdown logic will be implemented.
            socket.emit("player_data_request", data.players[cookies.session])
            socket.emit("game_data_request", data.gameState)
        }
        else{
            socket.emit("Err", {error:"username not found."})
        }
        socket.on('disconnect', () => {
            console.log('Client disconnected.');
        });
    }
    catch (err){
        socket.emit("Err", {error:err})
    }
})
