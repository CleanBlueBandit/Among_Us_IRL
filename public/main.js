const socket = io("http://localhost:6767");

let clientAnimationId = null;

function animateCountdown(targetEndTime) {
    if (clientAnimationId) cancelAnimationFrame(clientAnimationId);

    function updateFrame() {
        const now = Date.now();
        const genericTimeRemaining = targetEndTime - now;

        const secondsLeft = Math.max(0, (genericTimeRemaining / 1000)).toFixed(1);

        if (genericTimeRemaining <= 0) {
            document.getElementById("time").innerText = "0.0s - SYSTEM CRISIS!";
            cancelAnimationFrame(clientAnimationId);
            return;
        }

        document.getElementById("time").innerText = "Time left: " + secondsLeft + "s";
        clientAnimationId = requestAnimationFrame(updateFrame);
    }

    clientAnimationId = requestAnimationFrame(updateFrame);
}

socket.on("player_data_request", (data) => {
    document.getElementById("usr").innerText = "username: " + data.username;
    document.getElementById("id").innerText = "id: " + data.id;
    document.getElementById("alive").innerText = data.alive ? "Player is alive" : "Player is dead";
    
    var imp = data.impostor ? "impostor" : "crewmate";
    document.getElementById("impostor").innerText = "Player is " + imp;
    document.getElementById("tasksCompleted").innerText = "Your completed tasks: " + data.tasksCompleted + "/" + data.totalTasks;
});

socket.on("game_data_request", (data) => {
    document.getElementById("totalTasks").innerText = "Total tasks completed: " + data.completedTasks + "/" + data.totalTasks;
});

socket.on("sabotage_data_request", (data) => {
    if (clientAnimationId) {
        cancelAnimationFrame(clientAnimationId);
        document.getElementById("time").innerText = "";
    }

    if (data.sData.o2.depleted) {
        document.getElementById("o2").innerText = "depleted";
        document.getElementById("o2").className = "unstable";
        document.getElementById("reactor").className = "stable";
        
        animateCountdown(data.endTime);
    } 
    else if (data.sData.reactor.meltdown) {
        document.getElementById("reactor").innerText = "meltdown";
        document.getElementById("reactor").className = "unstable";
        document.getElementById("o2").className = "stable";
        
        animateCountdown(data.endTime);
    } 
    else {
        document.getElementById("o2").innerText = "stable";
        document.getElementById("o2").className = "stable";
        document.getElementById("reactor").innerText = "stable";
        document.getElementById("reactor").className = "stable";
        document.getElementById("time").innerText = "";
    }
});

socket.on("Err", (data) => {
    console.error("Server error\n" + data.error);
});