/**
 * Task folder on disk. Everything the report needs lives here, so nothing
 * depends on the model remembering it and a restart loses nothing.
 *
 *   <root>/<repo>/<task-id>/
 *     task.json      title, start time, git baseline
 *     ledger.jsonl   one line per edit, write or command (written by a hook)
 *     steps.jsonl    one line per report_step call (written by the model)
 *     summary.json   final overview (written by report_summary)
 *     REPORT.md      built by /report from the files above
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TaskInfo {
	id: string;
	title: string;
	repo: string;
	cwd: string;
	startedAt: string;
	baseHead?: string; // git HEAD when the task started
	dirtyAtStart: string[]; // files already modified before the task started
}

/**
 * How a tool's path argument is stored in the ledger:
 *   - undefined for OMP's internal URIs (xd:/write, proc:/<id>/kill, agent:/<id>),
 *     which are not files, so they never show up as changed files;
 *   - repo-relative for files in the checkout;
 *   - absolute for files outside it, so they read as what they are instead of ../../../x.
 */
export function ledgerPath(raw: string, cwd: string, repoTop: string): string | undefined {
	if (isUri(raw)) return undefined;
	const abs = path.resolve(cwd, raw);
	const rel = path.relative(repoTop || cwd, abs);
	if (rel === "") return ".";
	return rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
}

/** An OMP internal URI such as xd:/write. A scheme of 2+ chars, so C:\ still counts as a path. */
export function isUri(p: string): boolean {
	return /^[a-z][a-z0-9+.-]+:/i.test(p);
}

/** Outside the checkout. Also catches ../ paths that older versions wrote to the ledger. */
export function outsideRepo(p: string): boolean {
	return path.isAbsolute(p) || p === ".." || p.startsWith("../") || p.startsWith("..\\");
}

/** A ledger path that is a file in the checkout, so it belongs in "What changed". */
export function repoFile(p: string | undefined): p is string {
	return !!p && !isUri(p) && !outsideRepo(p);
}

export interface LedgerEntry {
	ts: string;
	tool: string;
	path?: string;
	command?: string;
	error: boolean;
}

export interface Decision {
	what: string;
	why: string;
}

export interface TestRun {
	command: string;
	result: "pass" | "fail" | "not_run";
	note?: string;
}

export interface StepEntry {
	n: number;
	ts: string;
	title: string;
	done: string;
	decisions: Decision[];
	tests: TestRun[];
	openQuestions: string[];
	needsYou: string[];
	files: string[];
}

export interface Summary {
	ts: string;
	overview: string;
	needsYou: string[];
	mrLink?: string;
}

export function reportRoot(): string {
	const fromEnv = process.env.OMP_REPORT_DIR?.trim();
	if (fromEnv) return fromEnv.startsWith("~/") ? path.join(os.homedir(), fromEnv.slice(2)) : fromEnv;
	return path.join(os.homedir(), ".omp", "llm-graphs", "reports");
}

/**
 * Where /report and report_summary write the report. OMP_GRAPHS_REPORT_FILE is
 * a path template, so the report can go wherever your other tools expect it:
 *   {task_dir}  this task's folder            {task}   its id
 *   {repo}      repo folder name              {date}   YYYY-MM-DD
 *   {fm_task}   Firstmate task id             {fm_home} Firstmate home (parent of state/)
 *   {fm_state}  Firstmate state folder        {env:NAME} any environment variable
 * Default: {task_dir}/REPORT.md. A placeholder with no value (say {fm_task}
 * outside Firstmate) falls back to the default, so a report is never lost.
 */
export function reportFile(vars: Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env): string {
	const fallback = path.join(vars.task_dir ?? ".", "REPORT.md");
	const tpl = env.OMP_GRAPHS_REPORT_FILE?.trim();
	if (!tpl) return fallback;
	let missing = false;
	const out = tpl.replace(/\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, isEnv: string | undefined, name: string) => {
		const v = isEnv ? env[name] : vars[name];
		if (!v) missing = true;
		return v ?? "";
	});
	if (missing) return fallback;
	const abs = out.startsWith("~/") ? path.join(os.homedir(), out.slice(2)) : out;
	return path.isAbsolute(abs) ? abs : path.join(vars.task_dir ?? ".", abs);
}

export function slug(text: string, max = 40): string {
	const s = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return s || "task";
}

export function newTaskId(title: string, now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	// a short random part, so two sessions starting the same task in the same second still get separate folders
	const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
	return `${stamp}-${rand}-${slug(title)}`;
}

export class TaskStore {
	readonly dir: string;

	constructor(root: string, repo: string, id: string) {
		this.dir = path.join(root, slug(repo, 60), id);
	}

	private file(name: string): string {
		return path.join(this.dir, name);
	}

	exists(): boolean {
		return fs.existsSync(this.file("task.json"));
	}

	create(info: TaskInfo): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(this.file("task.json"), `${JSON.stringify(info, null, 2)}\n`);
	}

	info(): TaskInfo {
		return JSON.parse(fs.readFileSync(this.file("task.json"), "utf8")) as TaskInfo;
	}

	private append(name: string, value: unknown): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.appendFileSync(this.file(name), `${JSON.stringify(value)}\n`);
	}

	private readLines<T>(name: string): T[] {
		const p = this.file(name);
		if (!fs.existsSync(p)) return [];
		const out: T[] = [];
		for (const line of fs.readFileSync(p, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as T);
			} catch {
				// a half-written last line after a crash is skipped, not fatal
			}
		}
		return out;
	}

	addLedger(entry: LedgerEntry): void {
		this.append("ledger.jsonl", entry);
	}

	ledger(): LedgerEntry[] {
		return this.readLines<LedgerEntry>("ledger.jsonl");
	}

	addStep(step: StepEntry): void {
		this.append("steps.jsonl", step);
	}

	steps(): StepEntry[] {
		return this.readLines<StepEntry>("steps.jsonl");
	}

	setSummary(summary: Summary): void {
		fs.writeFileSync(this.file("summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	}

	summary(): Summary | undefined {
		const p = this.file("summary.json");
		return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Summary) : undefined;
	}

	/** Writes the report to `target` (default: REPORT.md in the task folder). */
	writeReport(markdown: string, target = this.file("REPORT.md")): string {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, markdown);
		return target;
	}
}

/** Newest modification time of the files directly in a task folder. */
function lastWrite(dir: string): number {
	let t = 0;
	for (const f of fs.readdirSync(dir)) {
		try {
			t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs);
		} catch {
			// removed while we looked
		}
	}
	return t;
}

/**
 * Keep only the newest `keep` task folders per repo. The runner, not the
 * model, owns cleanup, so disk use stays bounded. A folder written to in the
 * last `busyHours` is never removed, so a long task in another session that
 * shares the repo is not deleted out from under it.
 */
export function pruneTasks(root: string, repo: string, keep: number, busyHours = 24, now = Date.now()): string[] {
	const repoDir = path.join(root, slug(repo, 60));
	if (!fs.existsSync(repoDir) || keep < 1) return [];
	const dirs = fs
		.readdirSync(repoDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort(); // ids start with a timestamp, so name order is age order
	const removed: string[] = [];
	for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
		const dir = path.join(repoDir, name);
		if (now - lastWrite(dir) < busyHours * 3600_000) continue;
		fs.rmSync(dir, { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}
