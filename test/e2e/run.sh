#!/usr/bin/env bash
# End-to-end check: real OMP + this plugin + a scripted mock model.
# Needs: omp on PATH (or OMP=/path/to/omp), node, git.
# SCENARIO=report (default), graph, or ship (verify + fake glab).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
OMP="${OMP:-omp}"
SCENARIO="${SCENARIO:-report}"
[ "$SCENARIO" = graph ] && export SCRIPT="$HERE/graph-script.json"
[ "$SCENARIO" = ship ] && export SCRIPT="$HERE/ship-script.json"
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

"$OMP" -p --no-session --no-pty --yolo --model mock/mock --extension "$PLUGIN/extensions/report/index.ts" \
	"Raise the pitch gain to 1.25" > "$WORK/out.txt" 2> "$WORK/err.txt" || { cat "$WORK/err.txt"; exit 1; }

kill $MOCK; wait $MOCK 2>/dev/null || true
REPORT="$(find "$OMP_REPORT_DIR" -name REPORT.md | head -1)"
TASK="$(dirname "$REPORT")"
fail() { echo "FAIL: $1 (work dir $WORK)"; echo "--- omp stdout"; cat "$WORK/out.txt"; echo "--- omp stderr"; tail -20 "$WORK/err.txt"; echo "--- mock"; cat "$WORK/mock.log"; exit 1; }

[ -n "$REPORT" ] || fail "no REPORT.md written"
grep -q '"tool":"write"' "$TASK/ledger.jsonl" || fail "write not in ledger"
[ "$SCENARIO" = ship ] || grep -q 'since your last report_step' "$WORK/mock.log" || fail "no report nudge reached the model"
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
else
	grep -q 'Raised the pitch gain' "$TASK/steps.jsonl" || fail "step not recorded"
	grep -q 'Confirm 1.25' "$REPORT" || fail "needs_you item missing"
fi
echo "--- REPORT.md"; cat "$REPORT"
echo "PASS"
