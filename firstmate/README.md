# Firstmate patch: one updating wake line instead of a wall of messages

`omp-wake-widget.patch` changes Firstmate's omp watcher (`.omp/extensions/fm-primary-omp-watch.ts`) so that watcher wakes stop piling up in the first mate's window.

**Before:** every wake (`FIRSTMATE WATCHER WAKE: signal: ...`) is added to the transcript as a new user message. Over a long day these fill the screen and push the first mate's real questions out of view.

**After:** the transcript gets no new message for a wake. One widget above the prompt is redrawn in place each time:

```
 Firstmate watcher: 14 wakes this session, last at 15:21:27
   signal: crewmate fix-gain done
```

The model still receives every wake, with the same text, and still takes its turn for it. omp sends a hidden custom message to the provider as user content, so the first mate sees what it saw before. What changes is only how the wake is displayed. `/fm-wakes` shows the last 10 wakes in full if you want to read one.

The patch is written against upstream `kunchenguid/firstmate` at commit `427056c` (November 2026) and tested with omp 18.20.0. It is not part of this plugin. llm-graphs doesn't need it, and it doesn't need llm-graphs.

## Apply it

On the machine where your Firstmate home lives:

```sh
cd /path/to/firstmate                       # your fork's checkout
git apply --check /path/to/llm-graphs/firstmate/omp-wake-widget.patch
git apply /path/to/llm-graphs/firstmate/omp-wake-widget.patch
```

Then restart the first mate's omp session. omp loads `.omp/extensions/*.ts` when a session starts, so a running session keeps the old watcher until restart.

If `--check` fails, your fork has changed that file. Make the four edits by hand instead (see "What the patch changes" below). Each is small.

To undo it: `git apply -R` with the same patch, or `git checkout .omp/extensions/fm-primary-omp-watch.ts`.

## Switch back without removing it

Start omp with `FM_OMP_WAKE_DISPLAY=user` to get the old behavior back, with one user message per wake. Any other value, or leaving it unset, uses the widget. If your launch filters the environment, add `FM_OMP_WAKE_DISPLAY` to the allowlist.

## Check it before you rely on it

From the llm-graphs checkout:

```sh
FIRSTMATE=/path/to/firstmate test/e2e/fm-wake-widget.sh             # widget mode
FIRSTMATE=/path/to/firstmate MODE=user test/e2e/fm-wake-widget.sh   # old look, for comparison
```

The test copies the watcher out of your checkout into a temporary folder and applies the patch there, unless it is already applied. Your checkout is not changed. It then starts a real omp under tmux with a mock model and a fake watcher arm that closes three times, and passes when:

- all three wakes reached the model,
- no wake message is on screen, and the widget shows "3 wakes" with only the latest one,
- after `/exit`, no wake is left in the replacement handoff file (`state/extensions/omp-primary-watch/session-replacement-actionable.json`), so the watcher counted every wake as consumed and won't replay one next session.

It needs `omp`, `node`, `tmux` and `git`, and uses no real model or tokens. I also ran it with the consumption fix removed to make sure it fails in that case, and it did: all three wakes were left for replay.

## What the patch changes

All four edits are in `.omp/extensions/fm-primary-omp-watch.ts`:

1. **Type.** It adds an optional `sendMessage` to the local `ExtensionAPI` type.
2. **Delivery (`sendWake`).** In widget mode it calls `pi.sendMessage({ customType: "firstmate-watcher-wake", content, display: false }, { deliverAs: "followUp", triggerTurn: true })` in place of `pi.sendUserMessage(content, { deliverAs: "followUp" })`, then redraws the widget. The content is unchanged, including the `FIRSTMATE_OP` marker. If omp has no `sendMessage` (as in Firstmate's own test fakes), the old call is used.
3. **Consumption (`message_start`).** It also accepts a `custom` message with that `customType` as consumption of a wake. This matters: an idle omp starts the turn for a custom message without a `before_agent_start` prompt, so `message_start` is the only place the watcher sees it. Without this edit every wake looks unconsumed and is replayed after `/new` or a restart.
4. **Widget and command.** It remembers the session UI from `session_start`, `before_agent_start` and `message_start`, keeps the last 20 wakes in memory, draws the widget (a header plus the first 3 lines of the latest wake), and registers `/fm-wakes`.

Watcher failures (`watcher: FAILED ...`) go through the same path, so they also show in the widget rather than as a message. The model gets them as before.

## Limits

- This covers watcher wakes only. Other operational input still goes the way it did. Most of it is already hidden: the session-start digest is a hidden custom message, and the turn-end guard continuation is attached context. Messages you type, and anything Firstmate types into the pane, remain normal user messages.
- The widget's wake history lives in memory, so it starts empty in each new session.
- Firstmate's own suite (`tests/fm-omp-harness.test.sh`) uses fakes without `sendMessage`, so it still exercises the old path and should pass unchanged. I couldn't run that suite here, so run it in your fork after applying the patch.
