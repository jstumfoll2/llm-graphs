/**
 * Firstmate integration for a worker session. On only when Firstmate launched
 * this omp (FM_TASK_ID and FM_TASK_INBOX are set), unless OMP_GRAPHS_FIRSTMATE=0.
 *
 *  - Steering inbox: new messages are delivered to the model by code at the
 *    next step boundary (or start a turn when idle) and acknowledged by moving
 *    them to handled/. Firstmate's doorbell line is swallowed, so the model
 *    never spends a turn listing and moving files.
 *  - Progress: each tool call refreshes Firstmate's progress marker through
 *    its own fm-busy-event.sh, so a long, busy step isn't taken for a wedge.
 *  - Worker state: state/<id>.llmg.json says which step is active, how many
 *    are done or blocked, when the last tool ran, and where the plan and report are.
 *  - Status lines: a "blocked:" line when the step list can't go on, and with
 *    OMP_GRAPHS_FM_DONE=1 a "done:" line when report_summary closes the task.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { active, type Plan } from "../graph/plan";
import {
	ackMessage,
	appendStatus,
	busyEventScript,
	busyGen,
	type FmTask,
	fmTask,
	type InboxMessage,
	isDoorbell,
	pendingMessages,
	writeState,
} from "./fm";

const POLL_MS = Math.max(1, Number(process.env.OMP_GRAPHS_INBOX_POLL_SEC ?? 5)) * 1000;
const PROGRESS_MS = 30_000; // at most one progress refresh per 30 s
const DONE_LINE = process.env.OMP_GRAPHS_FM_DONE === "1";

export interface FirstmateHooks {
	task(): FmTask | undefined;
	/** Call after the plan changes. */
	changed(): void;
	/** The step list can't go on: tell Firstmate. Returns text for the model, or undefined when not under Firstmate. */
	stuck(plan: Plan): string | undefined;
	/** report_summary closed the task. Returns text for the model, or undefined. */
	finished(overview: string, reportFile: string, plan: Plan | undefined): string | undefined;
}

export function messageText(m: InboxMessage): string {
	return `Message from Firstmate (instruction inbox #${m.seq}). It is already acknowledged: do not list or move inbox files.\n\n${m.body}`;
}

export function registerFirstmate(
	pi: ExtensionAPI,
	deps: { plan: () => Plan | undefined; planFile: () => string | undefined; reportFile: () => string | undefined },
): FirstmateHooks {
	const t = fmTask();
	if (!t) return { task: () => undefined, changed() {}, stuck: () => undefined, finished: () => undefined };

	const inFlight = new Set<string>();
	let handled = 0;
	let lastTool: { at: string; name: string } | undefined;
	let lastProgress = 0;

	function publish(): void {
		const p = deps.plan();
		const cur = p ? active(p) : undefined;
		try {
			writeState(t!, {
				schema: "llmg-worker.v1",
				task: t!.id,
				updatedAt: new Date().toISOString(),
				lastToolAt: lastTool?.at,
				lastTool: lastTool?.name,
				step: cur ? { id: cur.id, title: cur.title } : undefined,
				steps: {
					done: p?.steps.filter(s => s.status === "done").length ?? 0,
					blocked: p?.steps.filter(s => s.status === "blocked").length ?? 0,
					total: p?.steps.length ?? 0,
				},
				queuedAsks: p?.inbox.length ?? 0,
				planFile: deps.planFile(),
				reportFile: deps.reportFile(),
				inboxHandled: handled,
			});
		} catch {} // state/ gone (task torn down): nothing to tell
	}

	async function deliver(): Promise<number> {
		let n = 0;
		for (const m of pendingMessages(t!.inbox)) {
			if (inFlight.has(m.file)) continue;
			inFlight.add(m.file);
			try {
				await pi.sendUserMessage(messageText(m), { deliverAs: "aside" });
				ackMessage(m);
				handled++;
				n++;
			} catch {
				// not admitted (aborted, cost cap): leave it unacknowledged so Firstmate rings again
			} finally {
				inFlight.delete(m.file);
			}
		}
		if (n) publish();
		return n;
	}

	function progress(): void {
		const now = Date.now();
		if (now - lastProgress < PROGRESS_MS) return;
		const script = busyEventScript(t!);
		const gen = busyGen(t!);
		if (!script || !gen) return;
		lastProgress = now;
		execFile(script, ["progress", t!.stateDir, t!.id, "--gen", gen], () => {});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		publish();
		const tick = () => void deliver();
		const c = ctx as ExtensionContext & { setInterval?: (cb: () => void, ms: number) => unknown };
		if (typeof c.setInterval === "function") c.setInterval(tick, POLL_MS);
		else (setInterval(tick, POLL_MS) as unknown as { unref?: () => void }).unref?.();
	});

	// The doorbell asks the model to list and move files; code already does that.
	pi.on("input", async event => {
		if (!isDoorbell(event.text)) return undefined;
		await deliver();
		return { handled: true };
	});

	pi.on("tool_result", async (event, ctx) => {
		lastTool = { at: new Date().toISOString(), name: event.toolName };
		progress();
		publish();
		if (ctx.agent?.kind !== "sub") void deliver(); // between tool calls is a step boundary; the timer covers idle time
	});

	return {
		task: () => t,
		changed: publish,
		stuck(p) {
			const blocked = p.steps.filter(s => s.status === "blocked");
			const why = blocked.map(s => `step ${s.id} (${s.title}): ${s.reason ?? "no reason given"}`).join("; ");
			appendStatus(t, "blocked", `no step can continue. ${why}`);
			publish();
			return "Firstmate has been told: a blocked line is in your status file. After report_summary, end your turn; the answer arrives as a message.";
		},
		finished(overview, reportFile, p) {
			publish();
			const open = p?.steps.filter(s => s.status !== "done").length ?? 0; // blocked counts: that is not done
			if (!DONE_LINE || open) return undefined;
			const first = overview.split(/(?<=[.!?])\s/)[0]!.slice(0, 200);
			appendStatus(t, "done", `${first} Report: ${reportFile}`);
			return "Firstmate has been told: a done line is in your status file.";
		},
	};
}
