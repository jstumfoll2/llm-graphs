# OMP settings worth changing

OMP 18.20 has 622 settings. The `/settings` panel shows about 460 of them, and about 160 have no description anywhere. This page covers the ones that matter for a Firstmate fleet on one local model, over SSH, on large checkouts. Everything here was read from the OMP 18.20.2 source (`src/**/settings.ts`, `src/advisor/`, `src/prompts/system/`), so check names against your version with `omp config get <key>` before relying on one.

## How settings are applied

Each layer overrides the one above it:

| Layer | Where | Use it for |
| --- | --- | --- |
| Built-in default | inside omp | |
| Global | `~/.omp/agent/config.yml` | Your own defaults, for the first mate and every worker |
| Project | `<repo>/.omp/settings.json` (also reads `.claude/settings.json`) | One repo's needs, for example a longer build timeout |
| `--config <file>` overlay | Firstmate passes `.omp/fm-worker-overlay.yml` to every worker | Worker-only settings, without touching your own |
| Environment variable | only some settings have one (listed below) | A one-off run |

Commands:

```sh
omp config list                  # every setting with its effective value
omp config list --scope global   # only what config.yml sets
omp config get advisor.enabled
omp config set advisor.continueSeverity blocker   # writes config.yml
omp config reset advisor.continueSeverity
omp config path                  # where config.yml lives
```

In `config.yml` the dotted names become nested keys: `advisor.continueSeverity: blocker` is written as

```yaml
advisor:
  continueSeverity: blocker
```

omp doesn't reject an unknown key in `config.yml`, so a typo just has no effect. After editing, check with `omp config get`.

## The advisor

The advisor is a second model (the `advisor` model role) that reviews the agent's work and injects notes. It is off by default (`advisor.enabled: false`). If you see advisor cards, you or a setup step turned it on.

The 2 to 3 rounds of re-summarizing come from one setting: `advisor.continueSeverity` defaults to `concern`, so any "concern" note that lands after the agent gives its final answer wakes it up for another turn. The agent answers the note, the advisor reviews the new answer, and so on.

| Setting | Default | What it does | Recommended |
| --- | --- | --- | --- |
| `advisor.enabled` | `false` | Turns the advisor on | Your choice |
| `advisor.continueSeverity` | `concern` | Lowest note severity (`nit`, `concern`, `blocker`) that wakes the agent after its final answer. Lower ones wait for your next message | `blocker` |
| `advisor.maxNotesPerUpdate` | `4` | Most non-blocker notes per review (1 to 32) | `1` |
| `advisor.reviewMode` | `turn` | `turn` reviews every tool round; `agent-end` reviews only the final answer | `turn` for the first mate, `agent-end` if workers keep the advisor |
| `advisor.reviewInterval` | `1` | Review every Nth round | `1`, or `3` on a busy local model |
| `advisor.immuneTurns` | `3` | After an interrupting note, how many turns later notes wait as asides | `3` |
| `advisor.syncBacklog` | `off` | Pause the agent until the advisor catches up (`off`, `1`, `3`, `5`, `strict`) | `off` |
| `advisor.evictStaleResults` | `true` | Drop old read and grep output from the advisor's context | `true` |
| `display.advisorCollapsedLines` | `0` | Lines a collapsed advisor card shows (0 = whole preview) | `3` |
| `tier.advisor` | `none` | Service tier for the advisor model | leave |

Subagents (OMP's `task` tool) never get an advisor unless an agent's frontmatter says `advisor: on` or `task.agentAdvisor` maps the agent name to `"on"` or a model. Firstmate workers are full omp sessions, not subagents, so they do get one when `advisor.enabled` is on in your `config.yml`.

Per-advisor settings can also come from a `WATCHDOG.yml` (in `~/.omp/agent/`, or `.omp/` in a repo), which lists advisors with `name`, `model`, `reviewMode`, `reviewInterval`, `maxNotesPerUpdate`, `scope` (`main`, `subagent` or `all`) and `instructions`. When that file exists, its cadence settings win over `advisor.reviewMode` and `advisor.reviewInterval`.

[`firstmate/worker-integration.patch`](../firstmate/worker-integration.patch) sets `continueSeverity: blocker` and `maxNotesPerUpdate: 1` for workers only. For the first mate, add the same two lines to your own `config.yml`. The plugin's own advisor cap (one note per step) stays as a second limit; the two don't conflict.

## Reply style

OMP puts a personality block into every system prompt. The default one is:

> Evidence-first terse engineer: every sentence fact, decision, or risk.
> Fragments when clearer; no ceremony, hedging, summaries, filler, marketing.
> Concrete: exact files, symbols, APIs, state fields, edge cases, verification.

That is a direct cause of the dense, fragment-heavy replies with file names and state fields, and it pulls against Firstmate's section 9 (talk in outcomes, no internal terms). The rest of OMP's system prompt is written in the same telegraphic style, and models copy the style of their prompt.

| Setting | Values | Recommended |
| --- | --- | --- |
| `personality` | `default`, `friendly`, `pragmatic`, `none` | `pragmatic` for the first mate ("concise, respectful, task-focused, actionable guidance first, avoid verbose explanation of own work"). Workers never talk to you, so `default` is fine there |
| `textVerbosity` | `low`, `medium`, `high` | Only affects OpenAI Responses models; leave |
| `tui.reactions` | `true` | `false`: stops the agent spending a turn on emoji reactions |

You can also add your own lines to the system prompt with `omp --append-system-prompt <file>`, or replace it with a `SYSTEM.md` in `~/.omp/agent/` or the repo's `.omp/`. Replacing it is not recommended; OMP's tool rules live there.

## One local model shared by a fleet

| Setting | Default | Why | Recommended |
| --- | --- | --- | --- |
| `providers.maxInFlightRequests` | `{}` (unlimited) | Most requests per provider at once, shared across every omp process with the same config folder. Without it, five workers queue on the GPU and some time out | `{ "<your provider id>": 2 }`, sized to what your server batches well |
| `task.maxConcurrency` | `32` | Subagents one session may run at once | `2` |
| `provider.appendOnlyContext` | `auto` | Keeps the prompt prefix stable so a prefix cache hits. `auto` turns it on only for known providers | `on` if your server is vLLM or SGLang with prefix caching |
| `providers.streamIdleTimeoutSeconds` | `-1` | Seconds a stream may be silent before omp gives up | `300`: a queued request on a busy local server can be silent a long time |
| `providers.streamFirstEventTimeoutSeconds` | `-1` | Same, for the first token | `600` |
| `providers.cacheWarming` | `idle` | Re-sends the last request before a cache expires | `off`: it only helps hosted providers, and costs a slot |
| `recap.enabled` | `true` | Asks the model for a recap after 4 idle minutes | `false` in workers (nobody reads it); your choice for the first mate |
| `title.generator` | `fork` | `fork` asks the main model to name the session; `tiny` uses a small local ONNX model | `tiny`, if it runs on your server |
| `features.unexpectedStopDetection` | `mechanical` | `smart` adds a small-model call per text-only stop | `mechanical` |
| `composer.predictions` | `false` | Predicts your next message with the main model | keep `false` |
| `skillful` | `true` | Lists every skill in the system prompt | `false` if you have many skills and a small context |
| `compaction.thresholdPercent` | `-1` | When to compact | `70` for a 32k to 64k local context |

## Hour-long builds

| Setting | Default | Why | Recommended |
| --- | --- | --- | --- |
| `bash.autoBackground.enabled` | `true` | Moves a long command to the background and delivers the result later | `true` |
| `bash.autoBackground.thresholdMs` | `60000` | How long before a command is backgrounded | leave; the plugin's `fm-busy-event` progress calls keep Firstmate from seeing a backgrounded build as a stall |
| `tools.maxTimeout` | `0` (no cap) | Longest timeout the agent may set on a tool | `7200` |
| `task.maxRuntimeMs` | `0` | Hard limit per subagent | `0`, or 2 h if subagents hang |
| `task.softRequestBudget` | `200` | Requests before a subagent is told to wrap up | `80` on a slow model |

## Working in place on a shared checkout

| Setting | Default | Recommended | Why |
| --- | --- | --- | --- |
| `bash.gitGuard` | `false` | `true` | Refuses `git stash`, `reset --hard` and `checkout`/`restore` that would throw away work in the main checkout. You work in place, so this protects uncommitted work from a confused agent |
| `edit.blockAutoGenerated` | `true` | `true` | Refuses edits to generated files |
| `tools.restrictedFolders` | `[]` | your choice | Folders where every action needs approval |
| `worktree.onStart` | `off` | `off` | Keeps omp from making a worktree of a tens-of-GB checkout |

## Work network and privacy

Several settings send data to omp.sh or check for updates. On a work network you probably want them off.

| Setting | Default | Recommended | What it does |
| --- | --- | --- | --- |
| `dev.autoqa` | `true` | `false` | Tool error reports to `qa.omp.sh` (asks for consent the first time) |
| `telemetry.otlpExportEnabled` | `true` | `false` | Exports traces to any `OTEL_*` endpoint set in the environment |
| `startup.checkUpdate` | `true` | `false` | Update check on every start |
| `update.auto` | `false` | `false` | Installs updates in the background |
| `marketplace.autoUpdate` | `notify` | `off` | Plugin update check on start |
| `collab.autoStart` | `off` | `off` | Hosts every session through `my.omp.sh` |
| `web_search.enabled`, `fetch.enabled` | `true` | `false` if there's no internet | Web search and URL reading tools |
| `secrets.enabled` | `false` | `true` | Redacts configured secrets and credential-shaped text before it reaches the model |

## Less noise on screen

| Setting | Default | Recommended | What it does |
| --- | --- | --- | --- |
| `startup.quiet` | `false` | `false` | `true` skips omp's splash screen along with the startup notices. Earlier versions of this page recommended `true`; if your splash is gone, run `omp config set startup.quiet false` |
| `hideThinkingBlock` | `false` | `false` | `true` (also toggled by Ctrl+T) hides thinking, but a "Thinking" line still appears while the model thinks and vanishes when it stops, so the screen shakes on every call until it fills. With `false` each thought folds to one "Thought for 3s" row that stays |
| `startup.changelogMode` | `summary` | `hidden` | Release notes after an update |
| `tools.xdevNotices` | `true` | `false` | The "xd:// mounted" line each time tools change |
| `tui.renderSvg`, `tui.autoGraph` | `true`, `auto` | `false`, `off` over SSH | Invites the agent to draw charts your terminal can't show |
| `display.hideToolActivity` | `false` | `false` for workers you watch, `true` for the first mate if you only read its replies | Hides tool calls and results |
| `extensionRenderers.transcriptPresenters` | `false` | `true` | Lets the plugin hide its own tool calls and advisor notes |
| `extensionRenderers.assistantText` | `false` | `true` | Lets the plugin hide the agent's text after a nudge, advisor note or final report, and fold long replies |

## Overlaps with this plugin

| Setting | Default | Recommended | Why |
| --- | --- | --- | --- |
| `todo.enabled` | `true` | `false` when the step list is on | The plugin already refuses `todo` calls. Turning the tool off also drops its schema from every request |
| `todo.reminders`, `todo.midRunNudges` | on | off with the above | The plugin's stall nudge does this job |
| `gc.*` and `omp gc` | archive on | see below | OMP's own storage cleanup |

`omp gc` (dry run unless `--apply`) gzips sessions idle more than `gc.coldArchiveAfterDays` (30), always keeping the newest 20 overall and 10 per folder, and sweeps unreferenced blobs. It never deletes a session. `omp gc --strip --apply` removes provider replay data from sessions idle 30 days, which is most of their size. `gc.autoCompress` only works on APFS and NTFS, so not on a Linux server. The plugin's cleanup is the only part that enforces a size cap by deleting. Run both: `omp gc --apply --strip` weekly from cron to shrink, and the plugin's cap as the ceiling.

## Settings with no description

These have no text in the settings panel. What they do, from the code:

| Setting | Default | Meaning |
| --- | --- | --- |
| `gc.retainNewestGlobal`, `gc.retainNewestPerCwd` | `20`, `10` | Sessions `omp gc` never archives |
| `gc.stale`, `gc.staleRetainDays` | `false`, `30` | Opt-in pruning of old debug reports and collab copies |
| `gc.strip`, `gc.stripAfterDays` | `false`, `30` | Opt-in removal of replay data from idle sessions |
| `task.agentAdvisor` | `{}` | Agent name to `"on"`, `"off"` or a model, to give one subagent type an advisor |
| `task.agentModelOverrides` | `{}` | Agent name to model, for example a cheaper model for `llmg-investigate` |
| `memories.enabled` | `false` | OMP's own cross-session memory; leave off, Firstmate's `/stow` owns memory |
| `retry.maxRetries`, `retry.baseDelayMs` | `10`, `500` | API error retries |
| `thinkingBudgets.*` | 1024 to 32768 | Token budget per thinking level |
| `session.warnCost`, `session.maxCost` | unset | Cost limits; not useful for a local model |
| `models.offline` | `false` | Skips online model catalog lookups |

## A starting `config.yml`

Copy what fits into `~/.omp/agent/config.yml`. Replace `local` with the provider id from your `models.yml`.

```yaml
personality: pragmatic
advisor:
  continueSeverity: blocker
  maxNotesPerUpdate: 1
display:
  advisorCollapsedLines: 3
providers:
  maxInFlightRequests: { local: 2 }
  streamIdleTimeoutSeconds: 300
  streamFirstEventTimeoutSeconds: 600
  cacheWarming: off
task:
  maxConcurrency: 2
tools:
  maxTimeout: 7200
  xdevNotices: false
bash:
  gitGuard: true
todo:
  enabled: false
  reminders: false
tui:
  reactions: false
startup:
  checkUpdate: false
  changelogMode: hidden
dev:
  autoqa: false
telemetry:
  otlpExportEnabled: false
marketplace:
  autoUpdate: off
extensionRenderers:
  transcriptPresenters: true
  assistantText: true
```

Then run `omp config list --scope global` to confirm each key took.
