const socket = io("http://localhost:6767");


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
})

socket.on("sabotage_data_request", (data) => {
    if(data.sData.o2.depleted){
        document.getElementById("o2").innerText = "depleted";
        document.getElementById("o2").className = "unstable";
        document.getElementById("time").innerText = data.time;
        document.getElementById("reactor").className = "stable";
    }
    else if(data.sData.reactor.meltdown){
        document.getElementById("reactor").innerText = "meltdown";
        document.getElementById("reactor").className = "unstable";
        document.getElementById("time").innerText = data.time;
        document.getElementById("o2").className = "stable";
    }
    else{
        document.getElementById("time").innerText = ""
    }

})

socket.on("Err", (data) => {
    console.error("Sever error\n" + data.error);
});




