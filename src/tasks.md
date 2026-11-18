# Tasks

Tasks are physical QR codes placed around the play area. Each player is assigned
a random set of tasks at game start (the "tasks" setting in the host lobby) and
sees them on the sticky note next to their tablet. Impostors get tasks too, but
theirs never count towards the crew total.

## How tasks work

Every `.html` file in the `minigames/` folder is one task. The file name (without
`.html`) is the `task.id`, so `minigames/wires.html` is the task `wires`. There
is nothing to import: add, rename or delete a file and the task list follows.

- The name shown to players is made from the file name (`calibrate_power` becomes "Calibrate power").
- Optional location, shown under the name: add `<meta name="location" content="Electrical">` to the file's `<head>`.
- File names may only use letters, numbers, `-` and `_`.
- Files starting with `_` are ignored. Copy `minigames/_template.html` to make a new task.
- A minigame tells the server it is finished by calling `window.completeTask()`.
- `refuel_tank` and `fuel_engine` share a fuel tank: `fuel_engine` only works after someone did `refuel_tank`, so keep both file names.

## QR codes

Each task is scanned through a random secret token, so a task link can't be guessed from its name.
The server makes a token for every task by itself and keeps them in `tokens.json`, so printed codes
stay valid across restarts. The links are in `tasks.txt`, one per line.

1. Start the server once (or run `npm run task-links`).
2. Turn each line of `tasks.txt` into a QR code, print it and hang it at the task's location.

A new minigame file gets its token the next time the server looks at the tasks (at the latest when a game starts),
and its link is added to `tasks.txt`. The links contain `IP`/`PORT` from `.env`: if those change, run
`npm run task-links -- --new` to rewrite them (this also issues new tokens, so reprint the codes).

## Scanning

Players scan with their phone camera, which opens the link and the server accepts or declines it.
Declined when: not in the game, game not running, emergency meeting, sabotage in progress,
unknown code, task not assigned to you, or already done.
The crew wins when every crewmate task is done.

Players must open the link in the same browser they joined the game with (the login is a cookie).
