# llm-graphs

OMP plugins that make long agent runs easy to follow. The goal is a lead agent you talk to in OMP that hands out work, keeps track of it in files, and tells you plainly what it did.

It has two parts that install together: the **step list** keeps the agent on track, and the **report** tells you what it did.

## Step list

The task's steps live in a file, not in the model's memory. Code decides what is active and what comes next.

- **`plan_steps` tool.** The agent sets the ordered step list once, at the start. It can't be rewritten later.
- **`step_done` tool.** Finishes the active step only, and only with evidence (what was run or checked and what it showed). The reply names the next step.
- **`add_steps` / `step_blocked` tools.** Extra work goes after all existing steps; nothing is removed or reordered. A step that can't be done gets a one-line reason and the agent moves on.
- **Your mid-task asks.** `/ask <text>` queues an ask. It joins the plan at the next step boundary, after the steps already there, so part 2 of your original ask can't be pushed out.
- **No going quiet.** If the agent stops with steps left, it gets a follow-up naming the open step. After 3 nudges with no progress it stops nudging and warns you. It doesn't nudge when its last message was a question for you.
- **Advisor capped.** The first advisor note during a step reaches the agent. Later ones in the same step are held back and listed in the report, which ends the advisor back-and-forth loop.
- **One list.** Calls to OMP's own `todo` tool are refused with a pointer to the step list. Subagents can't move the lead's plan.
- **Always in view.** The plan shows above the prompt and in the system prompt at every turn. `/plan` opens the full list.

## Report

The agent writes a short, fixed-shape note after each step. A hook logs every edit and command on its own. `/report` turns both into one `REPORT.md` per task, so you read one page instead of hours of logs.

- **Change ledger.** Every `edit`, `write` and `bash` call is logged to `ledger.jsonl` by a hook. Nothing relies on the model remembering what it changed.
- **`report_step` tool.** After each step the model records: what it did (2 to 5 sentences, enforced), decisions and why, tests run, open questions, and anything that needs you. Changed files are added by the plugin from the ledger and `git status`.
- **`report_summary` tool.** A 3 to 8 sentence overview when the task is done or blocked, plus the MR link.
- **Nudge.** If the agent stops after 3 or more unreported edits or commands, it gets one follow-up asking it to report. Only one per gap, so it cannot loop.
- **Subagents.** Workers in the same checkout write into the lead's current task, so their work lands in the same report.
- **Bounded storage.** Reports live outside your checkout. Only the newest 30 task folders per repo are kept.

### Install

```sh
# from GitHub (pin a tag)
omp plugin install 'github:jstumfoll2/llm-graphs#v0.2.0'

# or from a local clone
omp plugin link ./llm-graphs
```

Restart OMP after installing.

### Use

| Command | What it does |
| --- | --- |
| `/ask <text>` | Queue a new ask; it joins the plan after the current step |
| `/plan` | Show the full step list |
| `/report` | Build `REPORT.md` and show a 3-line status above the prompt |
| `/report view` | Open the report in a scrollable view |
| `/report final` | Ask the agent to write the final summary |
| `/report new <title>` | Start a new task (otherwise a task starts with your first prompt) |
| `/report path` | Print the task folder |

The report is laid out the same way every time: Summary, Needs your decision, Plan (each step with its evidence, plus held advisor notes), What changed (files and `git diff --stat`), Tests (latest result per command), Open questions, Step log, Activity.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_REPORT_DIR` | `~/.omp/llm-graphs/reports` | Where task folders go |
| `OMP_REPORT_NUDGE_AFTER` | `3` | Unreported edits or commands before a nudge |
| `OMP_REPORT_KEEP` | `30` | Task folders kept per repo |
| `OMP_GRAPH_MAX_NUDGES` | `3` | Nudges with no progress before it warns you instead |
| `OMP_GRAPH_ADVISOR_PER_STEP` | `1` | Advisor notes the agent sees per step |
| `OMP_GRAPH_KEEP_TODO` | unset | Set to `1` to allow OMP's own todo tool alongside the step list |

### Task folder

```
~/.omp/llm-graphs/reports/<repo>/<task-id>/
  task.json      title, start time, git HEAD and files already modified at start
  plan.json      step list, queued asks, advisor notes
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
```

Tested with OMP 18.18.8.

## Background

The research behind the design (agent loops vs structured graphs, papers and tools reviewed) is in [docs/research.md](docs/research.md).
