#!/usr/bin/env bash
# End-to-end check: real OMP + this plugin + a scripted mock model.
# Needs: omp on PATH (or OMP=/path/to/omp), node, git.
# SCENARIO=report (default) or SCENARIO=graph.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
OMP="${OMP:-omp}"
SCENARIO="${SCENARIO:-report}"
[ "$SCENARIO" = graph ] && export SCRIPT="$HERE/graph-script.json"
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
echo "gain = 1.0" > gain.txt && git add . && git commit -qm init

"$OMP" -p --no-session --yolo --model mock/mock --extension "$PLUGIN/extensions/report/index.ts" \
	"Raise the pitch gain to 1.25" > "$WORK/out.txt" 2> "$WORK/err.txt" || { cat "$WORK/err.txt"; exit 1; }

kill $MOCK; wait $MOCK 2>/dev/null || true
REPORT="$(find "$OMP_REPORT_DIR" -name REPORT.md | head -1)"
TASK="$(dirname "$REPORT")"
fail() { echo "FAIL: $1 (work dir $WORK)"; echo "--- omp stdout"; cat "$WORK/out.txt"; echo "--- omp stderr"; tail -20 "$WORK/err.txt"; echo "--- mock"; cat "$WORK/mock.log"; exit 1; }

[ -n "$REPORT" ] || fail "no REPORT.md written"
grep -q '"tool":"write"' "$TASK/ledger.jsonl" || fail "write not in ledger"
grep -q 'since your last report_step' "$WORK/mock.log" || fail "no report nudge reached the model"
grep -q '## Needs your decision' "$REPORT" || fail "report missing decision section"
grep -q 'gain.txt' "$REPORT" || fail "changed file missing"
if [ "$SCENARIO" = graph ]; then
	grep -q 'is still open' "$WORK/mock.log" || fail "no step nudge reached the model"
	grep -q '"status": "done"' "$TASK/plan.json" || fail "plan.json has no finished step"
	! grep -q '"status": "active"' "$TASK/plan.json" || fail "a step is still active"
	grep -q '## Plan' "$REPORT" || fail "report missing plan section"
	grep -q '2 of 2 steps done' "$REPORT" || fail "plan not complete in report"
else
	grep -q 'Raised the pitch gain' "$TASK/steps.jsonl" || fail "step not recorded"
	grep -q 'Confirm 1.25' "$REPORT" || fail "needs_you item missing"
fi
echo "--- REPORT.md"; cat "$REPORT"
echo "PASS"
