/**
 * Storage cleanup. Keeps OMP's own session files and this plugin's task
 * folders under a size cap, oldest first. Runs in the background at most
 * once a day when a lead session starts; /cleanup shows what it would do and
 * /cleanup now runs it.
 *
 * Never removed: anything written to in the last few days, the session that
 * is running, pinned sessions, and the current task folder. OMP's shared
 * blob store is only measured, never touched, since sessions point into it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { gb, planCleanup, removeUnits, sessionUnits, sizeOf, taskUnits, type CleanupPlan, type Unit } from "./sizes";

const DAY = 24 * 3600_000;
const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function cleanupSettings() {
	return {
		sessionCap: num(process.env.OMP_GRAPHS_SESSION_CAP_GB, 20) * 1e9, // 0 turns session cleanup off
		reportCap: num(process.env.OMP_REPORT_CAP_GB, 5) * 1e9,
		keepMs: num(process.env.OMP_GRAPHS_SESSION_KEEP_DAYS, 3) * DAY,
	};
}

function stampFile(): string {
	return path.join(os.homedir(), ".omp", "llm-graphs", "cleanup.json");
}

/**
 * The sessions root is the folder above this session's folder. Only trusted
 * when it is named "sessions" (OMP's layout) or set by OMP_GRAPHS_SESSIONS_DIR,
 * so a custom layout is never swept by accident.
 */
export function sessionsRoot(ctx: ExtensionContext): string | undefined {
	const env = process.env.OMP_GRAPHS_SESSIONS_DIR?.trim();
	if (env) return env;
	let dir: string | undefined;
	try {
		dir = ctx.sessionManager.getSessionDir();
	} catch {
		return undefined;
	}
	if (!dir) return undefined;
	const root = path.dirname(dir);
	return path.basename(root) === "sessions" ? root : undefined;
}

function pinnedIds(root: string): Set<string> {
	for (const p of [path.join(path.dirname(root), "session-pins.json"), path.join(os.homedir(), ".omp", "session-pins.json")]) {
		try {
			const ids = JSON.parse(fs.readFileSync(p, "utf8"));
			if (Array.isArray(ids)) return new Set(ids.filter(i => typeof i === "string"));
		} catch {
			// no pins file there
		}
	}
	return new Set();
}

export interface CleanupView {
	sessions?: CleanupPlan & { root: string };
	reports: CleanupPlan & { root: string };
	blobs?: number;
}

export function registerCleanup(
	pi: ExtensionAPI,
	deps: { reportRoot: string; currentTaskDir: () => string | undefined },
): void {
	let running = false;

	function plan(ctx: ExtensionContext): CleanupView {
		const s = cleanupSettings();
		const now = Date.now();
		const root = sessionsRoot(ctx);
		let current: string | undefined;
		try {
			current = ctx.sessionManager.getSessionFile();
		} catch {
			current = undefined;
		}
		const view: CleanupView = {
			reports: {
				root: deps.reportRoot,
				...planCleanup(taskUnits(deps.reportRoot), s.reportCap, Math.max(s.keepMs, DAY), now, u => u.key === deps.currentTaskDir()),
			},
		};
		if (root) {
			const pins = pinnedIds(root);
			const protect = (u: Unit) => u.key === current || [...pins].some(id => path.basename(u.key).includes(id));
			view.sessions = { root, ...planCleanup(sessionUnits(root), s.sessionCap, s.keepMs, now, protect) };
			view.blobs = sizeOf(path.join(path.dirname(root), "blobs"));
		}
		return view;
	}

	function describe(v: CleanupView, done: boolean): string[] {
		const s = cleanupSettings();
		const verb = done ? "removed" : "would remove";
		const lines: string[] = [];
		if (v.sessions) {
			lines.push(
				`OMP sessions: ${gb(v.sessions.total)} in ${v.sessions.root} (cap ${s.sessionCap ? gb(s.sessionCap) : "off"}). ${v.sessions.remove.length ? `${verb} ${v.sessions.remove.length} oldest (${gb(v.sessions.total - v.sessions.after)}).` : "Nothing to remove."}${v.sessions.stuck ? " Still over the cap: the rest is recent or pinned." : ""}`,
			);
		} else {
			lines.push("OMP sessions: folder not found or not in OMP's usual layout, so left alone. Set OMP_GRAPHS_SESSIONS_DIR to clean it.");
		}
		if (v.blobs !== undefined) lines.push(`OMP blob store: ${gb(v.blobs)} (shared by sessions, not touched).`);
		lines.push(
			`Task reports: ${gb(v.reports.total)} in ${v.reports.root} (cap ${s.reportCap ? gb(s.reportCap) : "off"}). ${v.reports.remove.length ? `${verb} ${v.reports.remove.length} oldest (${gb(v.reports.total - v.reports.after)}).` : "Nothing to remove."}`,
		);
		return lines;
	}

	function run(ctx: ExtensionContext): { view: CleanupView; removed: number } {
		const view = plan(ctx);
		let removed = 0;
		if (view.sessions) removed += removeUnits(view.sessions.remove);
		removed += removeUnits(view.reports.remove);
		try {
			fs.mkdirSync(path.dirname(stampFile()), { recursive: true });
			fs.writeFileSync(stampFile(), `${JSON.stringify({ lastRun: new Date().toISOString(), removed }, null, 2)}\n`);
		} catch {
			// stamp is only a hint
		}
		return { view, removed };
	}

	function dueToday(): boolean {
		try {
			const last = Date.parse(JSON.parse(fs.readFileSync(stampFile(), "utf8")).lastRun);
			return !(Date.now() - last < DAY);
		} catch {
			return true;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || running || !dueToday()) return;
		running = true;
		// in the background: a big sessions folder can take a while to measure
		setTimeout(() => {
			try {
				const { view, removed } = run(ctx);
				if (removed && ctx.hasUI) ctx.ui.notify(`Cleanup: ${describe(view, true).filter(l => l.includes("removed")).join(" ")}`, "info");
			} catch {
				// never break a session over cleanup
			} finally {
				running = false;
			}
		}, 2000);
	});

	pi.registerCommand("cleanup", {
		description: "Show disk use of OMP sessions and task reports, and what cleanup would remove. /cleanup now runs it.",
		handler: async (args, ctx) => {
			const now = (args ?? "").trim() === "now";
			const lines = now ? describe(run(ctx).view, true) : [...describe(plan(ctx), false), "", "Run /cleanup now to do it. Caps: OMP_GRAPHS_SESSION_CAP_GB, OMP_REPORT_CAP_GB; recent files kept: OMP_GRAPHS_SESSION_KEEP_DAYS."];
			if (ctx.hasUI) await ctx.ui.editor("Storage (Esc to close)", lines.join("\n"));
			else console.log(lines.join("\n"));
		},
	});
}
