# Tasks

Tasks are physical QR codes placed around the play area. Each player is assigned
a random set of tasks at game start (the "tasks" setting in the host lobby) and
sees them, with their locations, on their tablet. Impostors get tasks too, but
theirs never count towards the crew total.

## Setup (before the game)

1. Write a JSON file of tasks, e.g. `tasks.example.json`:

```
[
  { "name": "Fix the wires", "location": "Electrical" },
  { "name": "Refuel the tank", "location": "Garage" }
]
```

(optional `"id"` per entry; otherwise derived from name + location)

Optional `"minigame"` per entry makes the scan open a minigame; finishing it completes the task:

| Key | What the player does |
| --- | --- |
| `wires` | Drag each wire to the matching colour |
| `calibrate_power` | Set the channel on the sticky note to its target amps |
| `refuel_tank` | Hold the button to fill the fuel tank |
| `fuel_engine` | Hold the button to fuel the engine from the tank (needs a `refuel_tank` task too) |
| `swipe_card` | Take the card from the wallet and swipe it at the right speed (about 0.45 to 1.15 s) |
| `empty_trash` | Pull and hold the lever until the bin is empty; when it jams, let go and pull again |
| `upload_data` | Keep the antenna inside the drifting signal band until the upload finishes |

2. `npm run import:tasks -- tasks.json`  - stores tasks and locations
3. `npm run generate:tasks`  - writes `tasks.txt`, one link per line
   (`npm run generate:tasks -- 2` makes two links per task)
4. Turn each line of `tasks.txt` into a QR code, print it and hang it at the task's location.

Re-run step 3 whenever `IP`/`PORT` in `.env` change, since the links contain them.

## Scanning

Players scan with their phone camera, which opens the link and the server accepts or declines it.
Declined when: not in the game, game not running, emergency meeting, sabotage in progress,
unknown code, task not assigned to you, or already done.
The crew wins when every crewmate task is done.

Players must open the link in the same browser they joined the game with (the login is a cookie).
