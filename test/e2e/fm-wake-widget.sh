#!/usr/bin/env bash
# End-to-end check for firstmate/omp-wake-widget.patch: a real omp primary with
# Firstmate's watcher extension (patched), a fake watcher arm that closes three
# times, and a mock model. Passes when all three wakes reach the model and the
# screen shows one updating widget line instead of three wake messages.
#
#   FIRSTMATE=/path/to/firstmate test/e2e/fm-wake-widget.sh
#
# Needs: omp on PATH (or OMP=...), node, tmux, git. Nothing in the Firstmate
# checkout is changed; the files are copied into a temp lab.
# MODE=user runs the same thing with FM_OMP_WAKE_DISPLAY=user (the old look).
# PATCHED=0 skips the patch (useful to see the stock behavior).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$(cd "$HERE/../.." && pwd)/firstmate/omp-wake-widget.patch"
FIRSTMATE="${FIRSTMATE:?set FIRSTMATE to a Firstmate checkout}"
OMP="${OMP:-omp}"
MODE="${MODE:-widget}"
PORT="${PORT:-18092}"
LAB="$(mktemp -d)"
SESSION="fm-wake-$$"
cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	kill "${MOCK:-}" 2>/dev/null || true
	pkill -f "$LAB/repo/bin/fm-watch-arm.sh" 2>/dev/null || true
	[ -n "${KEEP:-}" ] && echo "lab kept: $LAB" || rm -rf "$LAB"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; echo "--- screen ---"; cat "$LAB/screen.txt" 2>/dev/null; echo "--- wakes seen by the model ---"; cat "$LAB/wakes.json" 2>/dev/null; exit 1; }

REPO="$LAB/repo" FMH="$LAB/fmhome"
mkdir -p "$REPO/.omp/extensions" "$REPO/.pi/extensions/lib" "$REPO/bin" "$FMH/state" "$LAB/home/.omp/agent"
cp "$FIRSTMATE/.omp/extensions/fm-primary-omp-watch.ts" "$REPO/.omp/extensions/"
cp "$FIRSTMATE/.pi/extensions/lib/fm-operational-input.ts" "$REPO/.pi/extensions/lib/"
cp "$FIRSTMATE/bin/fm-operational-input.sh" "$REPO/bin/" && chmod +x "$REPO/bin/fm-operational-input.sh"
if [ "${PATCHED:-1}" = 1 ] && ! grep -q firstmate-watcher-wake "$REPO/.omp/extensions/fm-primary-omp-watch.ts"; then
	(cd "$REPO" && git init -q && git apply "$PATCH") || fail "patch did not apply to this Firstmate checkout"
fi

# Fake watcher arm: the first three cycles each close with one signal, the
# fourth stays up, so exactly three wakes are delivered.
cat > "$REPO/bin/fm-watch-arm.sh" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "$FM_HOME/state/.arm-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FM_HOME/state/.arm-count"
printf 'watcher: started pid=%s (beacon 0s)\n' "$$"
if [ "$n" -le 3 ]; then sleep 2; printf 'signal: test wake %s of 3\n' "$n"; exit 0; fi
sleep 300
SH
chmod +x "$REPO/bin/fm-watch-arm.sh"

cat > "$LAB/home/.omp/agent/models.yml" <<Y
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
Y
printf 'modelRoles:\n  default: mock/mock\n  smol: mock/mock\n' > "$LAB/home/.omp/agent/config.yml"

PORT=$PORT WAKE_LOG="$LAB/wakes.json" node "$HERE/fm-wake-mock.mjs" &
MOCK=$!
sleep 1

DISPLAY_ENV=""; [ "$MODE" = user ] && DISPLAY_ENV="FM_OMP_WAKE_DISPLAY=user"
# The lock names the omp process itself (exec keeps the pid), as fm-lock.sh would.
tmux new-session -d -s "$SESSION" -x 140 -y 50 -c "$REPO" \
	"echo \$\$ > '$FMH/state/.lock'; exec env HOME='$LAB/home' OMP_SKIP_SETUP=1 FM_HOME='$FMH' FM_ROOT_OVERRIDE='$REPO' $DISPLAY_ENV '$(command -v "$OMP")' --no-session --yolo"
sleep 6
tmux send-keys -t "$SESSION" "arm the watcher" Enter

for _ in $(seq 1 40); do
	sleep 1
	[ "$(grep -c '"wake"' "$LAB/wakes.json" 2>/dev/null || echo 0)" -ge 3 ] && break
done
sleep 3
tmux capture-pane -pt "$SESSION" -S -200 > "$LAB/screen.txt"

n=$(grep -c '"wake"' "$LAB/wakes.json" 2>/dev/null || echo 0)
[ "$n" -ge 3 ] || fail "the model saw $n of 3 wakes"
bubbles=$(grep -c "FIRSTMATE WATCHER WAKE" "$LAB/screen.txt" || true)
if [ "$MODE" = user ]; then
	[ "$bubbles" -ge 3 ] || fail "user mode should show each wake as a message, saw $bubbles"
	echo "PASS (user mode): 3 wakes reached the model and $bubbles wake messages are on screen"
else
	[ "$bubbles" -eq 0 ] || fail "widget mode left $bubbles wake messages on screen"
	grep -q "Firstmate watcher: 3 wakes this session" "$LAB/screen.txt" || fail "the widget does not show 3 wakes"
	grep -q "signal: test wake 3 of 3" "$LAB/screen.txt" || fail "the widget does not show the latest wake"
	grep -q "signal: test wake 1 of 3" "$LAB/screen.txt" && fail "an older wake is still on screen"
	echo "PASS (widget mode): 3 wakes reached the model; the screen shows one widget with the latest wake and no wake messages"
fi
# Every wake was consumed, so quitting must not leave one to replay next session.
tmux send-keys -t "$SESSION" "/exit" Enter
sleep 4
HANDOFF="$FMH/state/extensions/omp-primary-watch/session-replacement-actionable.json"
if [ -s "$HANDOFF" ] && grep -q "test wake" "$HANDOFF"; then fail "a consumed wake was left for replay: $(cat "$HANDOFF")"; fi
echo "PASS: no consumed wake left for replay"
[ "$MODE" = user ] || sed -n '/Firstmate watcher:/,+2p' "$LAB/screen.txt" | head -3
