# llm-graphs

OMP plugins that make long agent runs easy to follow. The goal is a lead agent you talk to in OMP that hands out work, keeps track of it in files, and tells you plainly what it did.

It has six parts that install together: the **step list** keeps the agent on track, **verify and MR** move testing and GitLab into code, **lead mode** makes the agent hand work to workers, **lessons** carry what it learned to the next task, **cleanup** keeps disk use bounded, and the **report** tells you what it did.

Running workers under [Firstmate](https://github.com/kunchenguid/firstmate)? The plugin notices and becomes the worker-side half: it reads Firstmate's steering inbox in code, writes its status lines, feeds its stall detection, and turns off the parts Firstmate already owns. See [Firstmate workers](#firstmate-workers) and [docs/firstmate.md](docs/firstmate.md) for what to change on the Firstmate side.

## Step list

The task's steps live in a file, not in the model's memory. Code decides what is active and what comes next.

- **`plan_steps` tool.** The agent sets the ordered step list once, at the start. It can't be rewritten later.
- **`step_done` tool.** Finishes the active step only, and only with evidence (what was run or checked and what it showed). The reply names the next step.
- **`add_steps` tool.** Extra work goes after all existing steps; nothing is removed or reordered. At most 20 steps per call.
- **Substeps.** `add_steps` with `under: <id>` splits an open step into substeps. They are listed under it, run before the next step, and the step itself can't be closed while any of them is open. One level deep. So a high-level list from you stays readable as that list, with the agent's breakdown under each item.
- **`step_blocked` / `step_reopen` tools.** A step that can't be done gets a one-line reason and the agent moves on. Once the blocker is cleared (you or a lead agent answered), `step_reopen` makes it the active step again, pauses whatever was active, and resets that step's verify retry count. The report keeps the block and the reopen. You can also reopen one yourself with `/plan reopen <id> <what cleared it>`.
- **Your mid-task asks.** `/ask <text>` queues an ask. It joins the plan at the next step boundary, after the steps already there, so part 2 of your original ask can't be pushed out.
- **No going quiet.** If the agent stops with steps left, it gets a follow-up naming the open step. After 3 nudges with no progress it stops nudging and warns you. It doesn't nudge when its last message was a question for you.
- **Advisor capped.** The first advisor note during a step reaches the agent. Later ones in the same step are held back and listed in the report, which ends the advisor back-and-forth loop.
- **One list.** Calls to OMP's own `todo` tool are refused with a pointer to the step list. Subagents can't move the lead's plan.
- **Always in view.** The plan shows above the prompt (the last 8 lines) and in the system prompt at every turn. `/plan` opens the whole list with nothing cut: every step, its evidence or block reason, and your queued asks.
- **Readable from any shell.** The same whole list is rewritten to `plan.md` in the task folder on every change, so you can `less` it over SSH while the agent works. `/plan file` prints its path.

## Verify and merge request

Your build and tests are run by the plugin, not typed by the model, and the model can't skip them.

- **`verify` tool.** Runs the repo's configured checks in order (for example build, then unit tests), stopping at the first failure. Full output goes to the task folder; the model sees only the last 60 lines of the failing check. Progress lines appear every 30 seconds, so an hour-long build doesn't look stalled.
- **Gate.** If files were edited since the last passing verify, `step_done` is refused until verify passes. Investigation-only steps aren't affected.
- **Retry cap.** After 3 failed verifies on one step (configurable), verify refuses and tells the agent to mark the step blocked.
- **`open_mr` tool.** Refuses unless verify passed, the branch isn't the target branch, and the task's files are committed. Then it pushes and runs `glab mr create` with a description built from the task records (summary, files, checks run, steps done). If an MR already exists for the branch, it finds it.
- **`watch_pipeline` tool.** Polls `glab ci get` until the pipeline finishes, then returns each failed job's last 40 lines (full logs saved). The agent fixes, verifies, commits, pushes and watches again.
- **`/verify`** runs the checks yourself; **`/verify setup`** opens this repo's config in an editor.

### Repo config

`~/.omp/llm-graphs/repos/<repo>.json`, outside the checkout:

```json
{
  "verify": [
    { "name": "build", "cmd": "make -j16", "timeout_min": 90 },
    { "name": "unit tests", "cmd": "ctest --output-on-failure", "timeout_min": 30 }
  ],
  "max_attempts": 3,
  "mr": { "target_branch": "develop", "reviewers": ["alice"], "labels": ["agent"], "draft": true },
  "pipeline": { "poll_sec": 60, "max_wait_min": 120 },
  "lead": true
}
```

Leave out `mr` and the agent stops at "verified, ready for you". With no config, nothing is gated.

The config names commands that `verify` runs and turns on `open_mr`, which pushes and opens an MR, so the agent must not be able to write it:

- A `.llm-graphs.json` in the repo top is **ignored** unless you start omp with `OMP_GRAPHS_TRUST_REPO_CONFIG=1`. Anything in the checkout can be written by the agent or a worker. Only set this for a repo where that file is reviewed and the agent can't change it.
- A config path that resolves inside the checkout (for example `OMP_GRAPHS_CONFIG_DIR` pointing into it, or a symlink) is refused.
- The config is read once when the session's first prompt is built and kept for the session, so a file written later in the session has no effect. `/verify setup` reloads it.
- Not covered: an agent with shell access can still write `~/.omp/llm-graphs/repos/` for a *later* session. If your workers have unrestricted shell, make that folder read-only to them.

## Lead mode

The agent you talk to plans, hands each step to a worker, checks the worker's evidence, and reports. It doesn't edit files or run commands itself, so it stays on the plan instead of disappearing into one step for an hour.

- **Workers.** Three OMP subagents ship in `agents/`: `llmg-investigate` (find and explain, read-only), `llmg-test` (write and run tests, doesn't touch the code under test), `llmg-fix` (make one change and run the focused tests, doesn't commit). Each starts with a fresh context holding only its assignment, and the lead waits for its reply.
- **Enforced.** In lead mode the lead's `edit`, `write`, `ast_edit`, `bash` and `eval` calls are refused with a pointer to the workers. Single `git` or `glab` calls (no pipes or chaining) are still allowed, so the lead can commit and open the MR. Workers' edits land in the lead's ledger and report, and the verify gate still applies.
- **Turning it on.** `/lead on` or `/lead off` for this session, `OMP_GRAPH_LEAD=1` everywhere, or `"lead": true` in the repo config. Off by default.

## Lessons

What the agent learns in one task ("the build needs `module load gcc/12`") carries to the next task in the same repo, but only becomes a rule once it has proven useful.

- **`lesson_add` tool.** Saves one sentence (up to 300 characters) as a tip. Longer text is refused with a request to shorten it, never cut. Duplicates are caught.
- **`lesson_helped` tool.** When a tip saves time in a task, the agent says so. After a tip has helped in 2 tasks other than the one that wrote it (`OMP_GRAPHS_PROMOTE_AFTER`), it becomes a standing rule.
- **In the prompt.** Standing rules, then up to 10 unproven tips marked as such. The list is fixed when a task starts, so nothing learned mid-task changes the agent's instructions until the next task.
- **Yours to edit.** `/lessons` lists them. `/lessons add <rule>` adds a rule straight away, and `/lessons promote <id>` and `/lessons forget <id>` do what they say.
- **Stored** in `~/.omp/llm-graphs/memory/<repo>.json`, outside your checkout. At most 100 tips are kept; unused old ones go first. The report lists the lessons a task added, used and promoted.

## Storage cleanup

Keeps OMP's own session files and this plugin's task folders under a size cap, so disk use can't creep up to hundreds of GB.

- **Automatic.** At most once a day, in the background when a session starts, the oldest OMP sessions (each `.jsonl` with its artifacts folder) are removed until the total is under `OMP_GRAPHS_SESSION_CAP_GB` (default 20). Task folders are capped at `OMP_REPORT_CAP_GB` (default 5) as well as by count.
- **Never removed:** anything written in the last `OMP_GRAPHS_SESSION_KEEP_DAYS` (default 3), the running session, pinned sessions, and the current task folder. OMP's shared blob store is measured but not touched. If the sessions folder isn't in OMP's usual layout (`.../sessions/<project>/`), it is left alone unless you set `OMP_GRAPHS_SESSIONS_DIR`.
- **`/cleanup`** shows the sizes and what would go; **`/cleanup now`** does it. Set `OMP_GRAPHS_SESSION_CAP_GB=0` to turn session cleanup off.

## Report

The agent writes a short, fixed-shape note after each step. A hook logs every edit and command on its own. `/report` turns both into one `REPORT.md` per task, so you read one page instead of hours of logs.

- **Change ledger.** Every `edit`, `write` and `bash` call is logged to `ledger.jsonl` by a hook. Nothing relies on the model remembering what it changed.
- **`report_step` tool.** After each step the model records: what it did (2 to 5 sentences, enforced), decisions and why, tests run, open questions, and anything that needs you. Changed files are added by the plugin from the ledger and `git status`.
- **`report_summary` tool.** A 3 to 8 sentence overview when the task is done or blocked, plus the MR link.
- **Nudge.** If the agent stops after 3 or more unreported edits or commands, it gets one follow-up asking it to report. Only one per gap, so it cannot loop.
- **Subagents.** A lead's subagents write into the lead's current task, so their work lands in the same report.
- **One folder per session.** Each OMP session gets its own task folder, even when several run in the same repo at once. Folder names carry a random part, and the lead-to-subagent link lives only inside one OMP process, never in a shared file.
- **Bounded storage.** Reports live outside your checkout. Only the newest 30 task folders per repo are kept, and a folder written to in the last 24 hours is never removed.

### Install

```sh
# from GitHub (latest main)
omp plugin install 'github:jstumfoll2/llm-graphs'

# or pin a commit or a release tag, once one is pushed (see the repo's Tags page)
omp plugin install 'github:jstumfoll2/llm-graphs#<commit-or-tag>'

# or from a local clone
omp plugin link ./llm-graphs
```

Restart OMP after installing.

### Use

| Command | What it does |
| --- | --- |
| `/ask <text>` | Queue a new ask; it joins the plan after the current step |
| `/plan` | Show the whole step list, with evidence, block reasons and queued asks |
| `/plan file` | Print where `plan.md` (the same list, kept current) lives |
| `/plan reopen <id> <note>` | Reopen a blocked step |
| `/report` | Build the report (`REPORT.md` unless `OMP_GRAPHS_REPORT_FILE` says otherwise) and show a 3-line status above the prompt |
| `/report view` | Open the report in a scrollable view |
| `/report final` | Ask the agent to write the final summary |
| `/report new <title>` | Start a new task (otherwise a task starts with your first prompt) |
| `/report path` | Print the task folder |
| `/report hide` | Clear the pinned final report |
| `/jump` | Go back to one of your directions or an earlier report, newest first |
| `/verify` | Run the repo's checks now |
| `/verify setup` | Create or edit this repo's verify and MR config |
| `/lead on` / `/lead off` | Turn lead mode on or off for this session |
| `/lessons` | List lessons; `add <rule>`, `promote <id>`, `forget <id>` |
| `/cleanup` | Show disk use and what cleanup would remove; `/cleanup now` runs it |

The report is laid out the same way every time: Summary, Needs your decision, Plan (each step with its evidence, plus held advisor notes), What changed (files and `git diff --stat`), Tests (latest result per command), Open questions, Step log, Activity.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_REPORT_DIR` | `~/.omp/llm-graphs/reports` | Where task folders go |
| `OMP_REPORT_NUDGE_AFTER` | `3` | Unreported edits or commands before a nudge |
| `OMP_REPORT_KEEP` | `30` | Task folders kept per repo (folders active in the last 24 hours are always kept) |
| `OMP_GRAPH_MAX_NUDGES` | `3` | Nudges with no progress before it warns you instead |
| `OMP_GRAPH_ADVISOR_PER_STEP` | `1` | Advisor notes the agent sees per step |
| `OMP_GRAPH_KEEP_TODO` | unset | Set to `1` to allow OMP's own todo tool alongside the step list |
| `OMP_GRAPHS_CONFIG_DIR` | `~/.omp/llm-graphs/repos` | Where per-repo verify and MR configs live (must be outside the checkout) |
| `OMP_GRAPHS_TRUST_REPO_CONFIG` | unset | `1` also reads `.llm-graphs.json` from the repo top. Off because the agent can write that file |
| `OMP_GRAPH_LEAD` | unset | `1` turns lead mode on, `0` forces it off |
| `OMP_GRAPHS_MEMORY_DIR` | `~/.omp/llm-graphs/memory` | Where lessons live |
| `OMP_GRAPHS_PROMOTE_AFTER` | `2` | Other tasks a tip must help in before it becomes a rule |
| `OMP_GRAPHS_SESSION_CAP_GB` | `20` | Size cap for OMP's session files; `0` turns session cleanup off |
| `OMP_GRAPHS_SESSION_KEEP_DAYS` | `3` | Files written within this many days are never removed |
| `OMP_REPORT_CAP_GB` | `5` | Size cap for task folders |
| `OMP_GRAPHS_SESSIONS_DIR` | from OMP | Sessions folder to clean, if not in OMP's usual layout |
| `OMP_GRAPHS_REPORT_FILE` | `{task_dir}/REPORT.md` | Where the report is written. A path template: `{task_dir}`, `{task}`, `{repo}`, `{date}`, `{fm_task}`, `{fm_home}`, `{fm_state}`, `{env:NAME}`. Relative paths are under the task folder. If a placeholder has no value, the default is used |
| `OMP_GRAPHS_DISABLE` | `lead,verify,lessons` under Firstmate, else empty | Parts to turn off: any of `lead`, `verify` (also `open_mr` and `watch_pipeline`), `lessons`, `cleanup`. Set it, even to empty, to override the default |
| `OMP_GRAPHS_FIRSTMATE` | auto | `0` turns the Firstmate integration off even when Firstmate launched this omp |
| `OMP_GRAPHS_FM_DONE` | unset | `1` writes a `done:` status line when `report_summary` closes a task with every step done |
| `OMP_GRAPHS_FOLD_LINES` | `30` | Finished replies longer than this are folded on screen (needs `extensionRenderers.assistantText`); `0` turns it off |
| `OMP_GRAPHS_INBOX_POLL_SEC` | `5` | How often an idle worker checks Firstmate's steering inbox |
| `OMP_GRAPHS_FM_ROOT` | `FM_ROOT`, else the Firstmate home | Where to find `bin/fm-busy-event.sh` |

### Task folder

```
~/.omp/llm-graphs/reports/<repo>/<date-time>-<random>-<title>/
  task.json      title, start time, git HEAD and files already modified at start
  plan.json      step list, queued asks, advisor notes
  verify.jsonl   one line per verify run; verify/*.log holds the output (5 MB cap each)
  mr.json        merge request link
  pipeline.json  latest pipeline result
  ledger.jsonl   one line per edit, write or command
  steps.jsonl    one line per report_step
  plan.md        the whole step list in plain text, rewritten on every change
  timeline.md    your directions and every final report, in order
  summary.json   final summary
  REPORT.md      built by /report (unless OMP_GRAPHS_REPORT_FILE points elsewhere)
```

Files already modified before the task started are listed separately, since work happens in place in an existing checkout.

## The omp window

One final report, held on screen, with the questions for you spelled out.

- **One report, not three.** `report_summary` saves a draft. The card appears only when the agent has really finished: if an advisor note or a nudge sends it back to work first, the fix goes into the same report. A later `report_summary` replaces the card; the agent is told not to post corrections or summaries in chat.
- **Pinned above the prompt.** The card shows the outcome, `NEEDS YOU` with each question, and the full paths of `REPORT.md` and `timeline.md`, each alone on a line so ctrl+click in a VS Code terminal opens it (a path wider than the terminal wraps and can't be clicked whole). It stays until the next report or `/report hide`. One short `■ Final report …` line also goes in the transcript, so scrolling back finds it.
- **Explicit questions.** `report_summary` takes `questions`: one decision each, ending in `?`, with options and a recommendation. Indirect asks ("Let me know if you'd like…"), two questions in one, or a recommendation that isn't one of the options are refused with the reason, so the agent rewrites them. They are shown as `Q1. … Options: (a) … (b) … Recommended: …` and you can answer `Q1 a`.
- **Jump back.** `/jump` lists your directions and every report, newest first; pick one to read it in full. `timeline.md` in the task folder holds the same, in order, for VS Code. Firstmate's own notices are not listed as your directions.
- **Less noise (optional).** With omp's `extensionRenderers` settings on, finished replies longer than 30 lines (`OMP_GRAPHS_FOLD_LINES`, `0` to turn off) are drawn as their first 4 lines plus a pointer to `/jump`, and advisor cards are drawn as one row you can expand. Display only: the model and the session keep everything. In `~/.omp/agent/config.yml`:

```yaml
extensionRenderers:
  assistantText: true        # fold long replies
  transcriptPresenters: true # advisor cards as one row
display:
  advisorCollapsedLines: 1   # omp's own setting: shorter advisor cards everywhere
```

The one-line notices Firstmate's watcher adds to the first mate's session are user messages, which no omp extension can fold. To turn them into one line that updates in place, apply [`firstmate/omp-wake-widget.patch`](firstmate/README.md) to your Firstmate checkout.

## Firstmate workers

When Firstmate launches omp for a task it sets `FM_TASK_ID` and `FM_TASK_INBOX`. With those present the plugin switches to worker mode:

- **Steering inbox read by code.** Messages in `state/<id>.inbox/` reach the model at the next step boundary, or start a turn if it's idle, and are acknowledged by moving them to `handled/`. Firstmate's doorbell line is swallowed instead of costing a turn. Messages are checked after every tool call and every 5 seconds while idle.
- **Status lines written by code.** When no step can go on (nothing active, something blocked), a `blocked [at=…]: no step can continue. step N (…): <reason>` line is appended to `state/<id>.status`, and the model is told to finish with `report_summary` and stop. With `OMP_GRAPHS_FM_DONE=1`, closing a task with every step done appends `done [at=…]: <first sentence of the summary> Report: <path>`.
- **Stall evidence.** Each tool call (at most every 30 s) runs Firstmate's own `fm-busy-event.sh progress` with the task's current `busy-gen`, so a long busy step isn't treated as a wedged worker.
- **Worker state file.** `state/<id>.llmg.json` holds the active step, done/blocked/total counts, queued asks, the last tool and when it ran, how many inbox messages were handled, and where `plan.md` and the report are.
- **Parts Firstmate owns are off:** lead mode (the first mate leads), verify/`open_mr`/`watch_pipeline` (the project's delivery path validates and publishes), and lessons (`/stow` keeps memory). The step list, change ledger, report, nudges and cleanup stay. Override with `OMP_GRAPHS_DISABLE`.
- **Report wherever you want it.** Set `OMP_GRAPHS_REPORT_FILE`, for example `{fm_home}/data/{fm_task}/llmg-report.md` to sit next to Firstmate's own task data without overwriting `report.md`.

[docs/firstmate.md](docs/firstmate.md) lists what to change or remove on the Firstmate side.

## Layout

```
extensions/report/index.ts   entry point: hooks, report tools, /report
extensions/graph/plan.ts     step list rules (pure functions)
extensions/graph/register.ts step tools, /ask, /plan, advisor gate, nudges
extensions/verify/config.ts  per-repo config lookup
extensions/verify/state.ts   verify, MR and pipeline records (pure helpers)
extensions/verify/register.ts verify, open_mr, watch_pipeline, /verify
extensions/lead/register.ts  lead mode: tool refusals, /lead, lead prompt
extensions/memory/lessons.ts lessons rules (pure functions)
extensions/memory/register.ts lesson tools, /lessons
extensions/cleanup/sizes.ts  disk use and cleanup plan (pure planning)
extensions/cleanup/register.ts daily background cleanup, /cleanup
extensions/firstmate/fm.ts   Firstmate's inbox, status, busy-event and state files (pure helpers)
extensions/firstmate/register.ts worker mode: inbox delivery, status lines, progress, state file
extensions/parts.ts          which parts are on (OMP_GRAPHS_DISABLE, Firstmate defaults)
firstmate/                   a patch for Firstmate itself (one updating wake line), with its own README
extensions/screen/view.ts    final report card, question rules, folding, timeline (pure)
extensions/screen/register.ts pinned card, /jump, folding and advisor rows
agents/*.md                  the three workers lead mode hands steps to
extensions/report/store.ts   task folder reads and writes, cleanup
extensions/report/render.ts  builds REPORT.md (pure function)
test/*.test.ts               unit tests (bun test)
test/e2e/run.sh              real OMP + this plugin + a scripted mock model
```

## Tests

```sh
bun test test/                     # unit tests
OMP=$(which omp) test/e2e/run.sh                  # end to end: report
SCENARIO=graph OMP=$(which omp) test/e2e/run.sh   # end to end: step list
SCENARIO=ship OMP=$(which omp) test/e2e/run.sh    # end to end: verify, MR, pipeline (fake glab)
SCENARIO=lead OMP=$(which omp) test/e2e/run.sh    # end to end: lead hands a step to a real worker, lessons
SCENARIO=firstmate OMP=$(which omp) test/e2e/run.sh  # end to end: worker under a fake Firstmate home
FIRSTMATE=/path/to/firstmate test/e2e/fm-wake-widget.sh  # the Firstmate wake patch, real omp + tmux
```

Tested with OMP 18.18.8 and 18.20.0. In print mode (`omp -p`), use `--no-pty`: a PTY-backed bash call keeps OMP from exiting at the end of the run.

## Background

The research behind the design (agent loops vs structured graphs, papers and tools reviewed) is in [docs/research.md](docs/research.md).
