# llm-graphs

OMP plugins that make long agent runs easy to follow. The goal is a lead agent you talk to in OMP that hands out work, keeps track of it in files, and tells you plainly what it did.

It has six parts that install together: the **step list** keeps the agent on track, **verify and MR** move testing and GitLab into code, **lead mode** makes the agent hand work to workers, **lessons** carry what it learned to the next task, **cleanup** keeps disk use bounded, and the **report** tells you what it did.

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
- **Always in view.** The plan shows above the prompt and in the system prompt at every turn. `/plan` opens the full list.

## Verify and merge request

Your build and tests are run by the plugin, not typed by the model, and the model can't skip them.

- **`verify` tool.** Runs the repo's configured checks in order (for example build, then unit tests), stopping at the first failure. Full output goes to the task folder; the model sees only the last 60 lines of the failing check. Progress lines appear every 30 seconds, so an hour-long build doesn't look stalled.
- **Gate.** If files were edited since the last passing verify, `step_done` is refused until verify passes. Investigation-only steps aren't affected.
- **Retry cap.** After 3 failed verifies on one step (configurable), verify refuses and tells the agent to mark the step blocked.
- **`open_mr` tool.** Refuses unless verify passed, the branch isn't the target branch, and the task's files are committed. Then it pushes and runs `glab mr create` with a description built from the task records (summary, files, checks run, steps done). If an MR already exists for the branch, it finds it.
- **`watch_pipeline` tool.** Polls `glab ci get` until the pipeline finishes, then returns each failed job's last 40 lines (full logs saved). The agent fixes, verifies, commits, pushes and watches again.
- **`/verify`** runs the checks yourself; **`/verify setup`** opens this repo's config in an editor.

### Repo config

`~/.omp/llm-graphs/repos/<repo>.json` (or a `.llm-graphs.json` in the repo top if you want to share it):

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

## Lead mode

The agent you talk to plans, hands each step to a worker, checks the worker's evidence, and reports. It doesn't edit files or run commands itself, so it stays on the plan instead of disappearing into one step for an hour.

- **Workers.** Three OMP subagents ship in `agents/`: `llmg-investigate` (find and explain, read-only), `llmg-test` (write and run tests, doesn't touch the code under test), `llmg-fix` (make one change and run the focused tests, doesn't commit). Each starts with a fresh context holding only its assignment, and the lead waits for its reply.
- **Enforced.** In lead mode the lead's `edit`, `write`, `ast_edit`, `bash` and `eval` calls are refused with a pointer to the workers. Single `git` or `glab` calls (no pipes or chaining) are still allowed, so the lead can commit and open the MR. Workers' edits land in the lead's ledger and report, and the verify gate still applies.
- **Turning it on.** `/lead on` or `/lead off` for this session, `OMP_GRAPH_LEAD=1` everywhere, or `"lead": true` in the repo config. Off by default.

## Lessons

What the agent learns in one task ("the build needs `module load gcc/12`") carries to the next task in the same repo, but only becomes a rule once it has proven useful.

- **`lesson_add` tool.** Saves one sentence as a tip. Duplicates are caught.
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
| `/plan` | Show the full step list |
| `/plan reopen <id> <note>` | Reopen a blocked step |
| `/report` | Build `REPORT.md` and show a 3-line status above the prompt |
| `/report view` | Open the report in a scrollable view |
| `/report final` | Ask the agent to write the final summary |
| `/report new <title>` | Start a new task (otherwise a task starts with your first prompt) |
| `/report path` | Print the task folder |
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
| `OMP_GRAPHS_CONFIG_DIR` | `~/.omp/llm-graphs/repos` | Where per-repo verify and MR configs live |
| `OMP_GRAPH_LEAD` | unset | `1` turns lead mode on, `0` forces it off |
| `OMP_GRAPHS_MEMORY_DIR` | `~/.omp/llm-graphs/memory` | Where lessons live |
| `OMP_GRAPHS_PROMOTE_AFTER` | `2` | Other tasks a tip must help in before it becomes a rule |
| `OMP_GRAPHS_SESSION_CAP_GB` | `20` | Size cap for OMP's session files; `0` turns session cleanup off |
| `OMP_GRAPHS_SESSION_KEEP_DAYS` | `3` | Files written within this many days are never removed |
| `OMP_REPORT_CAP_GB` | `5` | Size cap for task folders |
| `OMP_GRAPHS_SESSIONS_DIR` | from OMP | Sessions folder to clean, if not in OMP's usual layout |

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
  summary.json   final summary
  REPORT.md      built by /report
```

Files already modified before the task started are listed separately, since work happens in place in an existing checkout.

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
```

Tested with OMP 18.18.8. In print mode (`omp -p`), use `--no-pty`: a PTY-backed bash call keeps OMP from exiting at the end of the run.

## Background

The research behind the design (agent loops vs structured graphs, papers and tools reviewed) is in [docs/research.md](docs/research.md).
