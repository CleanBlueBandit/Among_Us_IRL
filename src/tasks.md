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
- File names may only use letters, numbers, `-` and `_`.
- Files starting with `_` are ignored. Copy `minigames/_template.html` to make a new task.
- A minigame tells the server it is finished by calling `window.completeTask()`.

## Locations and binds (`tasks.json`)

`tasks.json` in the project root says where each task is and which tasks belong together:

```
{
  "locations": {
    "refuel_tank": "Garage",
    "fuel_engine": "Engine room"
  },
  "binds": {
    "refuel_tank": "fuel_engine"
  }
}
```

- **locations**: shown under the task name. A task missing here falls back to
  `<meta name="location" content="...">` in its minigame's `<head>`, if it has one.
- **binds**: `"refuel_tank": "fuel_engine"` means fuel_engine needs refuel_tank first.
  Whoever is given fuel_engine is also given refuel_tank, and scanning fuel_engine is declined
  until that player has done refuel_tank. One task can lead to several: `"a": ["b", "c"]`.
  A bound task whose first task has no minigame file is never handed out.

Changes to `tasks.json` apply at the next scan or game start; no restart needed.
The server log warns about entries that name a task with no minigame file.

## QR codes

Each task is scanned through a random secret token, so a task link can't be guessed from its name.
The server makes a token for every task by itself and keeps them in `tokens.json`, so printed codes
stay valid across restarts. The links are in `tasks.txt`, each task as its id and then its link:

```
wires:
http://192.168.1.20:8812/task/9f1c0e...
```

1. Start the server once (or run `npm run task-links`).
2. Turn each link in `tasks.txt` into a QR code, print it and hang it at the task's location.

A new minigame file gets its token the next time the server looks at the tasks (at the latest when a game starts),
and its link is added to `tasks.txt`. The links contain `IP`/`PORT` from `.env`: if those change, run
`npm run task-links -- --new` to rewrite them (this also issues new tokens, so reprint the codes).

## Scanning

Players scan with their phone camera, which opens the link and the server accepts or declines it.
Declined when: not in the game, game not running, emergency meeting, sabotage in progress,
unknown code, task not assigned to you, or already done.
The crew wins when every crewmate task is done.

Players must open the link in the same browser they joined the game with (the login is a cookie).
