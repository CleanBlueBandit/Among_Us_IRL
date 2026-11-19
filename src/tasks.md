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

## Settings per task (`tasks.json`)

`tasks.json` in the project root switches tasks on and off, says where each QR code is, makes tasks
repeat and binds tasks together:

```
{
  "tasks": {
    "swipe_card":  { "enabled": true,  "repeat": 1, "location": "Admin" },
    "wires":       { "enabled": true,  "repeat": 3, "location": ["Electrical", "Storage", "Kitchen"] },
    "refuel_tank": { "enabled": true,  "repeat": 1, "location": "Garage" },
    "fuel_engine": { "enabled": true,  "repeat": 1, "location": "Engine room" },
    "keypad_code": { "enabled": false, "repeat": 1, "location": "" }
  },
  "binds": {
    "refuel_tank": "fuel_engine"
  }
}
```

- **tasks**: one entry per minigame. The server adds an entry for every new minigame by itself
  (switched on, repeat 1, empty location), so you only have to fill in the locations.
  - `enabled`: `false` switches the task off. It is never handed out, a scan of it is declined, and its
    QR codes are left out of `tasks.txt`. The codes keep working once you switch it back on.
  - `repeat`: makes a repeating task. `3` gives it three QR codes (`wires#1`, `wires#2`, `wires#3` in
    `tasks.txt`), hung in three places and done one after another. It counts as **one** task; the
    tablet shows "Wires (1/3)", then (2/3), then (3/3), each with its own location.
  - `location`: shown under the task name. For a repeating task it is a list with one place per QR
    code (the server makes the list the right length). A location left empty falls back to the
    minigame's own `<meta name="location" content="...">`, for tasks that don't repeat.
    When the server starts it warns how many QR codes have no location in `tasks.json`.
- **binds**: `"refuel_tank": "fuel_engine"` chains the two into **one** task. The tablet shows only
  refuel_tank; once it is done, fuel_engine takes its place. Scanning fuel_engine before that is declined.
  A list makes a longer chain: `"a": ["b", "c"]` is a, then b, then c. A task can be in only one
  chain. A chain is never handed out when one of its tasks is missing or switched off.

Changes to `tasks.json` apply at the next scan or game start; no restart needed.
The server log warns about entries that name a task with no minigame file. If `tasks.json` has a
typo, the server leaves it untouched and treats every task as switched on, with no location, no
repeats and no binds, until it is fixed.

## Floor plan editor

The host's **Floor plan** button (in the lobby) does all of the above without editing `tasks.json` by
hand: drag each task's QR codes into the rooms on the plan and save. Placed tasks are switched on with
their room as location (with the floor name when there are several floors); tasks left off the plan are
switched off. Repeats and binds still come from `tasks.json`.

## QR codes

Each task is scanned through a random secret token, so a task link can't be guessed from its name.
The server makes a token for every task by itself and keeps them in `tokens.json`, so printed codes
stay valid across restarts. The links are in `tasks.txt`, every QR code as its name and then its link:

```
swipe_card:
http://192.168.1.20:8812/task/9f1c0e...
wires#1:
http://192.168.1.20:8812/task/03ab7d...
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
