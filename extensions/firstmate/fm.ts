/**
 * Firstmate's worker-side files, read and written by code instead of by the
 * model. Pure helpers plus small file operations, no OMP imports, so it is easy
 * to test. The formats are Firstmate's (kunchenguid/firstmate):
 *
 *   state/<id>.inbox/NNN.msg      steering message (bin/fm-task-inbox-lib.sh)
 *   state/<id>.inbox/handled/     moving a message here is the acknowledgement
 *   state/<id>.status             one "<verb> [at=<epoch>]: <text>" line per event
 *   state/<id>.busy-gen           current incarnation token for busy events
 *   bin/fm-busy-event.sh progress refreshes state/<id>.progress (wedge evidence)
 *
 * Firstmate sets FM_TASK_ID and FM_TASK_INBOX (absolute state/<id>.inbox) on
 * every worker it launches; that is how this side finds the rest.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface FmTask {
	id: string;
	inbox: string; // state/<id>.inbox
	stateDir: string; // state/
	home: string; // parent of state/, the Firstmate home in the usual layout
}

/**
 * The Firstmate task this worker runs, or undefined when it isn't one.
 * OMP_GRAPHS_FIRSTMATE=0 turns the integration off, =1 requires it.
 */
export function fmTask(env: NodeJS.ProcessEnv = process.env): FmTask | undefined {
	const mode = env.OMP_GRAPHS_FIRSTMATE?.trim();
	if (mode === "0") return undefined;
	const id = env.FM_TASK_ID?.trim();
	const inbox = env.FM_TASK_INBOX?.trim();
	if (!id || !inbox || !path.isAbsolute(inbox)) return undefined;
	const stateDir = path.dirname(inbox);
	return { id, inbox, stateDir, home: path.dirname(stateDir) };
}

export interface InboxMessage {
	file: string; // absolute path of NNN.msg
	seq: number;
	at?: string;
	body: string;
}

/** Parse one record: header lines, a "--" line, then the exact body. */
export function parseRecord(raw: string): { at?: string; body: string } | undefined {
	const lines = raw.split("\n");
	const sep = lines.indexOf("--");
	if (sep < 0) return undefined;
	const head = lines.slice(0, sep);
	if (!head.some(l => l.startsWith("schema=fm-task-inbox."))) return undefined;
	const at = head.find(l => l.startsWith("at="))?.slice(3);
	let body = lines.slice(sep + 1).join("\n");
	// body-terminator=1: the writer added exactly one final newline that isn't part of the message
	if (head.includes("body-terminator=1") && body.endsWith("\n")) body = body.slice(0, -1);
	return { at, body };
}

/** Unhandled messages, oldest first. Unreadable or malformed records are left for Firstmate. */
export function pendingMessages(inbox: string): InboxMessage[] {
	let names: string[];
	try {
		names = fs.readdirSync(inbox);
	} catch {
		return [];
	}
	const out: InboxMessage[] = [];
	for (const name of names) {
		const m = name.match(/^(\d+)\.msg$/);
		if (!m) continue;
		const file = path.join(inbox, name);
		try {
			const rec = parseRecord(fs.readFileSync(file, "utf8"));
			if (rec) out.push({ file, seq: Number(m[1]), ...rec });
		} catch {}
	}
	return out.sort((a, b) => a.seq - b.seq);
}

/** Acknowledge: move into handled/, which is exactly what Firstmate watches for. */
export function ackMessage(msg: InboxMessage): void {
	const handled = path.join(path.dirname(msg.file), "handled");
	fs.mkdirSync(handled, { recursive: true });
	fs.renameSync(msg.file, path.join(handled, path.basename(msg.file)));
}

/** The constant line Firstmate types into the worker to say a message is waiting. */
export function isDoorbell(text: string): boolean {
	return text.trim().startsWith(": Firstmate instruction waiting:");
}

export function statusLine(verb: string, text: string, now = Date.now()): string {
	return `${verb} [at=${Math.floor(now / 1000)}]: ${text.replace(/\s+/g, " ").trim()}\n`;
}

export function appendStatus(t: FmTask, verb: string, text: string): string {
	const line = statusLine(verb, text);
	fs.appendFileSync(path.join(t.stateDir, `${t.id}.status`), line);
	return line;
}

/** fm-busy-event.sh, from OMP_GRAPHS_FM_ROOT or FM_ROOT, else <home>/bin. */
export function busyEventScript(t: FmTask, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const roots = [env.OMP_GRAPHS_FM_ROOT, env.FM_ROOT, t.home].filter((r): r is string => !!r?.trim());
	for (const r of roots) {
		const p = path.join(r.trim(), "bin", "fm-busy-event.sh");
		if (fs.existsSync(p)) return p;
	}
	return undefined;
}

export function busyGen(t: FmTask): string | undefined {
	try {
		return fs.readFileSync(path.join(t.stateDir, `${t.id}.busy-gen`), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** What this worker is doing, for Firstmate's supervision and for you. */
export interface WorkerState {
	schema: "llmg-worker.v1";
	task: string;
	updatedAt: string;
	lastToolAt?: string;
	lastTool?: string;
	step?: { id: number; title: string };
	steps: { done: number; blocked: number; total: number };
	queuedAsks: number;
	planFile?: string;
	reportFile?: string;
	inboxHandled: number;
}

export function stateFile(t: FmTask): string {
	return path.join(t.stateDir, `${t.id}.llmg.json`);
}

export function writeState(t: FmTask, s: WorkerState): void {
	const file = stateFile(t);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
	fs.renameSync(tmp, file);
}
