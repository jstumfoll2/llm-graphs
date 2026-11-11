# llm-graphs

OMP plugins that make long agent runs easy to follow. The goal is a lead agent you talk to in OMP that hands out work, keeps track of it in files, and tells you plainly what it did.

This first piece is the **report plugin**. The step graph (todo list kept by code, nudges when the agent goes quiet, a cap on advisor rework) comes next.

## Report plugin

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
omp plugin install 'github:jstumfoll2/llm-graphs#v0.1.0'

# or from a local clone
omp plugin link ./llm-graphs
```

Restart OMP after installing.

### Use

| Command | What it does |
| --- | --- |
| `/report` | Build `REPORT.md` and show a 3-line status above the prompt |
| `/report view` | Open the report in a scrollable view |
| `/report final` | Ask the agent to write the final summary |
| `/report new <title>` | Start a new task (otherwise a task starts with your first prompt) |
| `/report path` | Print the task folder |

The report is laid out the same way every time: Summary, Needs your decision, What changed (files and `git diff --stat`), Tests (latest result per command), Open questions, Steps, Activity.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_REPORT_DIR` | `~/.omp/llm-graphs/reports` | Where task folders go |
| `OMP_REPORT_NUDGE_AFTER` | `3` | Unreported edits or commands before a nudge |
| `OMP_REPORT_KEEP` | `30` | Task folders kept per repo |

### Task folder

```
~/.omp/llm-graphs/reports/<repo>/<task-id>/
  task.json      title, start time, git HEAD and files already modified at start
  ledger.jsonl   one line per edit, write or command
  steps.jsonl    one line per report_step
  summary.json   final summary
  REPORT.md      built by /report
```

Files already modified before the task started are listed separately, since work happens in place in an existing checkout.

## Layout

```
extensions/report/index.ts   hooks, tools and the /report command
extensions/report/store.ts   task folder reads and writes, cleanup
extensions/report/render.ts  builds REPORT.md (pure function)
test/report.test.ts          unit tests (bun test)
test/e2e/run.sh              real OMP + this plugin + a scripted mock model
```

## Tests

```sh
bun test test/                     # unit tests
OMP=$(which omp) test/e2e/run.sh   # end to end, needs node and git
```

Tested with OMP 18.18.8.

## Background

The research behind the design (agent loops vs structured graphs, papers and tools reviewed) is in [docs/research.md](docs/research.md).
