#!/usr/bin/env bash
# End-to-end check: real OMP + this plugin + a scripted mock model.
# Needs: omp on PATH (or OMP=/path/to/omp), node, git.
# SCENARIO=report (default), graph, ship (verify + fake glab), lead (workers + lessons),
# or firstmate (a worker launched by Firstmate: inbox, status lines, progress, state file).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
OMP="${OMP:-omp}"
SCENARIO="${SCENARIO:-report}"
[ "$SCENARIO" = graph ] && export SCRIPT="$HERE/graph-script.json"
[ "$SCENARIO" = ship ] && export SCRIPT="$HERE/ship-script.json"
[ "$SCENARIO" = lead ] && export SCRIPT="$HERE/lead-script.json"
[ "$SCENARIO" = firstmate ] && export SCRIPT="$HERE/firstmate-script.json"
WORK="$(mktemp -d)"
trap 'kill $MOCK 2>/dev/null || true; [ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT

export HOME="$WORK/home" OMP_REPORT_DIR="$WORK/reports" OMP_REPORT_NUDGE_AFTER=1 PORT=18080
mkdir -p "$HOME/.omp/agent"
cat > "$HOME/.omp/agent/models.yml" <<EOF
providers:
  mock:
    baseUrl: http://127.0.0.1:$PORT/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: mock
        name: Mock
        contextWindow: 32000
        maxTokens: 4000
EOF
printf 'modelRoles:\n  default: mock/mock\n' > "$HOME/.omp/agent/config.yml"

node "$HERE/mock-llm.mjs" 2> "$WORK/mock.log" &
MOCK=$!
sleep 1

mkdir -p "$WORK/repo" && cd "$WORK/repo"
git init -q && git config user.email t@t && git config user.name t
echo "gain = 1.0" > gain.txt && git add . && git commit -qm init -q
if [ "$SCENARIO" = ship ]; then
	git branch -M main
	git init -q --bare "$WORK/remote.git" && git remote add origin "$WORK/remote.git" && git push -q origin main
	export PATH="$HERE/bin:$PATH" FAKE_GLAB_LOG="$WORK/glab.log" OMP_GRAPHS_CONFIG_DIR="$WORK/cfg"
	mkdir -p "$WORK/cfg"
	cat > "$WORK/cfg/repo.json" <<'CFG'
{ "verify": [ { "name": "gain check", "cmd": "grep -q 'gain = 1.25' gain.txt" } ],
  "mr": { "target_branch": "main", "draft": true },
  "pipeline": { "poll_sec": 1, "max_wait_min": 1 } }
CFG
fi
EXT="$PLUGIN/extensions/report/index.ts"
if [ "$SCENARIO" = lead ]; then
	export OMP_GRAPH_LEAD=1
	EXT="$PLUGIN" # the package folder, so OMP also finds agents/
	# a tip from an older task that already helped once; helping here makes it a rule
	mkdir -p "$HOME/.omp/llm-graphs/memory"
	cat > "$HOME/.omp/llm-graphs/memory/repo.json" <<'MEM'
{ "nextId": 2, "lessons": [ { "id": 1, "text": "Changing gain.txt needs no rebuild, it is read at run time.", "status": "candidate", "source": "agent",
  "addedAt": "2026-11-01T00:00:00Z", "addedIn": "old-1", "helped": [ { "task": "old-2", "ts": "2026-11-02T00:00:00Z", "how": "Skipped a rebuild." } ] } ] }
MEM
fi
if [ "$SCENARIO" = firstmate ]; then
	# a fake Firstmate home: state/ with a waiting steering message, and a busy-event script that logs its calls
	FMH="$WORK/fm"
	mkdir -p "$FMH/state/t1.inbox" "$FMH/bin"
	printf 'schema=fm-task-inbox.v1\nat=2026-11-13T00:00:00Z\nbody-terminator=1\n--\nAlso keep the old gain in a comment.\n' > "$FMH/state/t1.inbox/001.msg"
	echo gen-abc > "$FMH/state/t1.busy-gen"
	printf '#!/bin/sh\necho "$@" >> "%s/busy.log"\n' "$WORK" > "$FMH/bin/fm-busy-event.sh"
	chmod +x "$FMH/bin/fm-busy-event.sh"
	export FM_TASK_ID=t1 FM_TASK_INBOX="$FMH/state/t1.inbox" OMP_GRAPHS_FM_DONE=1 OMP_GRAPHS_INBOX_POLL_SEC=1
	export OMP_GRAPHS_REPORT_FILE='{fm_home}/data/{fm_task}/llmg-report.md'
fi

"$OMP" -p --no-session --no-pty --yolo --model mock/mock --extension "$EXT" \
	"Raise the pitch gain to 1.25" < /dev/null > "$WORK/out.txt" 2> "$WORK/err.txt" || { cat "$WORK/err.txt"; exit 1; }

kill $MOCK; wait $MOCK 2>/dev/null || true
REPORT="$(find "$OMP_REPORT_DIR" -name REPORT.md | head -1)"
TASK="$(dirname "$REPORT")"
if [ "$SCENARIO" = firstmate ]; then
	REPORT="$WORK/fm/data/t1/llmg-report.md"
	TASK="$(dirname "$(find "$OMP_REPORT_DIR" -name plan.json | head -1)")"
fi
fail() { echo "FAIL: $1 (work dir $WORK)"; echo "--- omp stdout"; cat "$WORK/out.txt"; echo "--- omp stderr"; tail -20 "$WORK/err.txt"; echo "--- mock"; cat "$WORK/mock.log"; exit 1; }

[ -n "$REPORT" ] || fail "no REPORT.md written"
grep -q '"tool":"write"' "$TASK/ledger.jsonl" || fail "write not in ledger"
[ "$SCENARIO" = ship ] || [ "$SCENARIO" = lead ] || [ "$SCENARIO" = firstmate ] || grep -q 'since your last report_step' "$WORK/mock.log" || fail "no report nudge reached the model"
grep -q '## Needs your decision' "$REPORT" || fail "report missing decision section"
grep -q 'gain.txt' "$REPORT" || fail "changed file missing"
if [ "$SCENARIO" = ship ]; then
	grep -q 'Files changed since the last passing verify' "$WORK/mock.log" || fail "step_done was not gated on verify"
	grep -q 'Verify FAILED' "$WORK/mock.log" || fail "first verify should fail"
	grep -q 'Verify passed' "$WORK/mock.log" || fail "second verify should pass"
	grep -q 'mr create --source-branch feature/pitch-gain --target-branch main' "$WORK/glab.log" || fail "glab mr create not called right"
	grep -q -- '--draft' "$WORK/glab.log" || fail "draft flag missing"
	git -C "$WORK/remote.git" rev-parse -q --verify feature/pitch-gain >/dev/null || fail "branch not pushed"
	grep -q 'merge_requests/7' "$REPORT" || fail "MR link missing from report"
	grep -q 'Pipeline: success' "$REPORT" || fail "pipeline result missing from report"
	grep -q 'Checks (run by the plugin' "$REPORT" || fail "verify result missing from report"
	grep -q '2 of 2 steps done' "$REPORT" || fail "plan not complete"
elif [ "$SCENARIO" = graph ]; then
	grep -q 'is still open' "$WORK/mock.log" || fail "no step nudge reached the model"
	grep -q '"status": "done"' "$TASK/plan.json" || fail "plan.json has no finished step"
	! grep -q '"status": "active"' "$TASK/plan.json" || fail "a step is still active"
	grep -q '## Plan' "$REPORT" || fail "report missing plan section"
	grep -q '4 of 4 steps done' "$REPORT" || fail "plan not complete in report"
	grep -q '↳ (part of 1) Write the new value' "$REPORT" || fail "substeps not shown under their step"
	grep -q 'reopened 1x: The license server is back up now.' "$REPORT" || fail "reopen not recorded"
elif [ "$SCENARIO" = lead ]; then
	grep -q "Lead mode: you don" "$WORK/mock.log" || fail "the lead's own write was not refused"
	grep -q 'gain = 1.25' gain.txt || fail "the worker's change is missing"
	! grep -q '9.99' gain.txt || fail "the lead's write went through"
	grep -q '"tool":"write","path":"gain.txt"' "$TASK/ledger.jsonl" || fail "worker edit not in the lead's ledger"
	grep -q '## Lessons' "$REPORT" || fail "report missing lessons"
	grep -q 'Became standing rules in this task' "$REPORT" || fail "lesson 1 was not promoted"
	grep -q 'pitch gain lives only in gain.txt' "$HOME/.omp/llm-graphs/memory/repo.json" || fail "new lesson not saved"
	grep -q '2 of 2 steps done' "$REPORT" || fail "plan not complete"
elif [ "$SCENARIO" = firstmate ]; then
	S="$WORK/fm/state"
	[ -f "$REPORT" ] || fail "report not written to the configured place"
	grep -q 'Message from Firstmate (instruction inbox #1)' "$WORK/mock.log" || fail "steering message not delivered"
	grep -q 'Also keep the old gain in a comment.' "$WORK/mock.log" || fail "steering message body missing"
	[ -f "$S/t1.inbox/handled/001.msg" ] || fail "steering message not acknowledged"
	grep -q '^blocked \[at=[0-9]*\]: no step can continue. step 2 (Run the hardware-in-the-loop tests): The HWIL rig' "$S/t1.status" || fail "no blocked line"
	! grep -q '^done ' "$S/t1.status" || fail "done line written while a step is blocked"
	grep -q 'Firstmate has been told' "$WORK/mock.log" || fail "model not told about the blocked line"
	grep -q 'progress .*/fm/state t1 --gen gen-abc' "$WORK/busy.log" || fail "no progress event"
	grep -q '"schema": "llmg-worker.v1"' "$S/t1.llmg.json" || fail "no worker state file"
	grep -q '"blocked": 1' "$S/t1.llmg.json" || fail "worker state not current"
	grep -q 'llmg-report.md' "$S/t1.llmg.json" || fail "state file missing the report path"
	grep -q 'blocked: The HWIL rig' "$TASK/plan.md" || fail "plan.md missing or incomplete"
	grep -q '"step_done"' "$WORK/mock.log" || fail "tool list not logged"
	! grep -q '"verify"' "$WORK/mock.log" || fail "verify tool offered inside Firstmate"
	! grep -q '"lesson_add"' "$WORK/mock.log" || fail "lesson tools offered inside Firstmate"
else
	grep -q 'Raised the pitch gain' "$TASK/steps.jsonl" || fail "step not recorded"
	grep -q 'Confirm 1.25' "$REPORT" || fail "needs_you item missing"
fi
echo "--- REPORT.md"; cat "$REPORT"
echo "PASS"
