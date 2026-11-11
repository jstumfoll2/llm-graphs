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
	return `${stamp}-${slug(title)}`;
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

	writeReport(markdown: string): string {
		const p = this.file("REPORT.md");
		fs.writeFileSync(p, markdown);
		return p;
	}
}

/**
 * Keep only the newest `keep` task folders per repo. The runner, not the
 * model, owns cleanup, so disk use stays bounded.
 */
export function pruneTasks(root: string, repo: string, keep: number): string[] {
	const repoDir = path.join(root, slug(repo, 60));
	if (!fs.existsSync(repoDir) || keep < 1) return [];
	const dirs = fs
		.readdirSync(repoDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort(); // ids start with a timestamp, so name order is age order
	const removed = dirs.slice(0, Math.max(0, dirs.length - keep));
	for (const name of removed) fs.rmSync(path.join(repoDir, name), { recursive: true, force: true });
	return removed;
}
