# Running llm-graphs inside a Firstmate fleet

[Firstmate](https://github.com/kunchenguid/firstmate) is the command layer: intake, dispatch, durable records, escalation to you, and the delivery path (validation, PR or MR, merge). It watches each worker from outside. llm-graphs runs *inside* an omp worker. So the two fit together best when llm-graphs does the worker's side of Firstmate's contracts in code, and leaves Firstmate's own jobs to Firstmate.

This page says what the plugin does in a Firstmate worker and what to change on the Firstmate side. File and line references are to upstream `kunchenguid/firstmate` as of November 2026. A customized fork may differ, so check each one against your copy.

## What the plugin does in a worker

Firstmate sets `FM_TASK_ID` and `FM_TASK_INBOX` (the absolute `state/<id>.inbox` path) on every crewmate and scout it launches (`bin/fm-spawn.sh`, the "receives `FM_TASK_ID`" and "`FM_TASK_INBOX` export" notes). When both are set, the plugin switches to worker mode on its own:

| Firstmate contract | Before (the model follows the brief) | With the plugin (code does it) |
| --- | --- | --- |
| Steering inbox (`bin/fm-task-inbox-lib.sh`) | A doorbell line is typed into the pane. The model lists `*.msg`, reads each, and `mv`s it to `handled/`. If it doesn't, the watcher re-rings and finally escalates it as stuck. | New messages are checked after every tool call and every 5 s while idle. Each one is handed to the model at the next step boundary (OMP `deliverAs: "aside"`), or starts a turn if the worker is idle. Then it is moved to `handled/`. The doorbell line is swallowed, so it costs no turn. |
| Status `blocked:` line | The model must remember to append it, then stop. | When no step can continue (nothing active, something blocked), the plugin appends `blocked [at=<epoch>]: no step can continue. step N (<title>): <reason>`. It tells the model to finish with `report_summary` and end its turn. |
| Status `done:` line | Written by the model. | Optional (`OMP_GRAPHS_FM_DONE=1`): when `report_summary` closes a task with every step done, it appends `done [at=…]: <first sentence of the summary> Report: <path>`. Off by default, because a ship's definition of done (PR or MR URL, delivery mode) belongs to the brief. |
| Wedge evidence (`state/<id>.progress`) | Not written for omp. The watcher judges a long busy turn from pane captures and timers. | Every tool call, at most once every 30 s, runs `bin/fm-busy-event.sh progress <state> <id> --gen <busy-gen>`. That is Firstmate's own writer, bound to the current incarnation. `busy_turn_over_age` in `bin/fm-watch.sh` already reads that marker, so a long build no longer looks like a wedge. |
| What the worker is doing | Read from the pane. | `state/<id>.llmg.json`, rewritten on every change: active step, done/blocked/total, queued asks, last tool and its time, inbox messages handled, and the paths of `plan.md` and the report. |

The plugin also turns off the parts Firstmate already owns. Lead mode is off because the first mate leads. `verify`, `open_mr` and `watch_pipeline` are off because the delivery path validates and publishes, and those tools could push. Lessons are off because `/stow` keeps memory. The step list, change ledger, report, nudges and cleanup stay. Set `OMP_GRAPHS_DISABLE` to change that list.

## Changes on the Firstmate side

Each of these is small, and the fleet keeps working if you skip one: the plugin only writes through Firstmate's existing formats and scripts.

### 1. Make sure workers load the plugin and keep its settings

- `omp plugin install 'github:jstumfoll2/llm-graphs'` installs it for your user, and Firstmate's omp launch line (`bin/fm-spawn.sh`, the `omp)` launch template: `--config .omp/fm-worker-overlay.yml --auto-approve --cwd <worktree> -e state/<id>.omp-ext.ts`) loads installed plugins as usual. Nothing to change there.
- If your home uses the filtered launch environment (the `env -i` floor described in `bin/fm-spawn.sh`), `FM_TASK_ID` and `FM_TASK_INBOX` already survive it. Any `OMP_GRAPHS_*` settings you want in workers must be added to that allowlist too, or they'll be dropped.

### 2. Shorten the inbox section of omp briefs (`bin/fm-brief.sh`)

The "Firstmate instruction inbox" block (built as `INBOX_SECTION`, around the `# The receive-and-ack half of the steering-inbox contract` comment) tells the worker to list, read and `mv` messages. For omp workers with the plugin, replace it with one line:

> Instruction messages from Firstmate are delivered to you automatically and are already acknowledged. Do not list, read or move files in the inbox.

Keep the existing block for every other harness. The doorbell and re-ring ladder can stay as they are: a doorbell for an inbox the plugin already emptied is a no-op, which the inbox design already allows for.

### 3. Tell omp briefs who writes `blocked:`

In the status-protocol part of the brief, add for omp workers:

> When your step list reports "Firstmate has been told", the blocked line is already written. Do not append a second one.

`needs-decision:`, `paused:` and `done:` (with the PR or MR URL) stay with the brief.

### 4. Clean up the state file at teardown (`bin/fm-teardown.sh`)

Add `"$STATE/$ID.llmg.json"` next to `"$STATE/$ID.progress"` in the `rm -f` lists (upstream has them in the per-task cleanup and the secondmate child cleanup). Until you do, the file is left behind; it is small and harmless.

### 5. Read the state file before the pane (`.agents/skills/stuck-crewmate-recovery/SKILL.md`)

Add a first step: if `state/<id>.llmg.json` exists, read it, and `plan.md` if needed, before capturing the pane. It says which step the worker is on, how long ago it last ran a tool, and what is blocked, as data rather than as a screen to interpret. The same file can feed `/bearings` (`.agents/skills/bearings/SKILL.md`) if you want the active step in the digest.

### 6. Report location

Firstmate scouts write their own `data/<id>/report.md`. The plugin's report used to go only to its own task folder. Where it goes is now up to you, through `OMP_GRAPHS_REPORT_FILE`:

```sh
# beside Firstmate's task data, without overwriting the scout's report.md
OMP_GRAPHS_REPORT_FILE='{fm_home}/data/{fm_task}/llmg-report.md'

# or a folder of your own
OMP_GRAPHS_REPORT_FILE='{env:HOME}/reports/{repo}/{date}-{fm_task}.md'
```

`{fm_home}` is the parent of the state folder. If your home moves state elsewhere (`FM_STATE_OVERRIDE`), use `{fm_state}` or `{env:NAME}` instead. If a placeholder has no value (for example `{fm_task}` in a session Firstmate didn't launch), the report goes to the task folder as before. The worker state file always records where the report went.

### 7. The primary first mate session

The plugin also loads in your first mate's own omp session, which has no `FM_TASK_ID`, so it runs in normal mode there. The step list and report are useful for tracking a multi-part ask. Lead mode is off unless you turn it on, and verify does nothing without a config. To be explicit, start the primary with:

```sh
OMP_GRAPHS_DISABLE=lead,verify,lessons omp
```

The same goes for secondmates, which run in their own home and are not marked as tasks.

### 8. Update your own notes on the safety property

If your fork has a note like "no repo config exists for any checkout" (for example `docs/llm-graphs-step-list.md`), replace it. That was a convention. Now it is enforced in two places: inside Firstmate workers, `verify`/`open_mr`/`watch_pipeline` aren't registered at all, and everywhere else a `.llm-graphs.json` in the checkout is ignored unless `OMP_GRAPHS_TRUST_REPO_CONFIG=1`.

## What to stop using in a fleet

| Part | Why | How |
| --- | --- | --- |
| Lead mode (`/lead`, `agents/llmg-*`) | The first mate already leads, and a second lead adds a layer between intent and action | Off by default in workers |
| `verify`, `open_mr`, `watch_pipeline` | The project's delivery path owns validation and publishing | Off by default in workers |
| Lessons | Firstmate's `/stow` curates memory | Off by default in workers |
| `/ask` | Steer through Firstmate (`fm-send`). The plugin delivers it the same way | Still available, just unnecessary |

## Checking it

`SCENARIO=firstmate test/e2e/run.sh` runs a real omp worker against a fake Firstmate home. It checks that a waiting message is delivered and moved to `handled/`, that the `blocked:` line is written in Firstmate's format, that `fm-busy-event.sh progress` is called with the task's `busy-gen`, that the state file is current, that the report lands at the configured path, and that `verify` and the lesson tools are not offered.
