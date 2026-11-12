/**
 * Verify, MR and pipeline records in the task folder, plus the pure rules
 * that decide when a verify is needed. No OMP imports here, so it is easy to test.
 *
 *   verify.jsonl     one line per verify run
 *   verify/*.log     full output of each check (tail kept, size capped)
 *   mr.json          merge request link
 *   pipeline.json    latest pipeline result
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEntry } from "../report/store";

export interface CheckResult {
	name: string;
	cmd: string;
	ok: boolean;
	code: number;
	timedOut: boolean;
	secs: number;
	log: string; // path to the full log
}

export interface VerifyRun {
	ts: string;
	step?: number; // active plan step when it ran
	ok: boolean;
	results: CheckResult[];
}

export interface MrRecord {
	ts: string;
	url: string;
	branch: string;
	target: string;
}

export interface FailedJob {
	id: number;
	name: string;
	stage?: string;
	tail: string;
}

export interface PipelineRecord {
	ts: string;
	branch: string;
	status: string; // success, failed, canceled, running, timeout, ...
	url?: string;
	failedJobs: FailedJob[];
}

function readJsonLines<T>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	const out: T[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// torn last line after a crash
		}
	}
	return out;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export class VerifyState {
	constructor(readonly dir: string) {}

	runs(): VerifyRun[] {
		return readJsonLines<VerifyRun>(path.join(this.dir, "verify.jsonl"));
	}

	addRun(run: VerifyRun): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.appendFileSync(path.join(this.dir, "verify.jsonl"), `${JSON.stringify(run)}\n`);
	}

	logPath(n: number, name: string): string {
		const d = path.join(this.dir, "verify");
		fs.mkdirSync(d, { recursive: true });
		return path.join(d, `${String(n).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`);
	}

	mr(): MrRecord | undefined {
		return readJson<MrRecord>(path.join(this.dir, "mr.json"));
	}

	setMr(mr: MrRecord): void {
		fs.writeFileSync(path.join(this.dir, "mr.json"), `${JSON.stringify(mr, null, 2)}\n`);
	}

	pipeline(): PipelineRecord | undefined {
		return readJson<PipelineRecord>(path.join(this.dir, "pipeline.json"));
	}

	setPipeline(p: PipelineRecord): void {
		fs.writeFileSync(path.join(this.dir, "pipeline.json"), `${JSON.stringify(p, null, 2)}\n`);
	}
}

/** Failed verify runs during this plan step. */
export function failuresForStep(runs: VerifyRun[], step: number | undefined): number {
	return runs.filter(r => !r.ok && r.step === step).length;
}

/**
 * A verify is needed when files were edited after the last passing run
 * (or ever, if none passed). Investigation-only steps need none.
 */
export function needsVerify(ledger: LedgerEntry[], runs: VerifyRun[]): boolean {
	const lastPass = [...runs].reverse().find(r => r.ok)?.ts ?? "";
	return ledger.some(e => (e.tool === "edit" || e.tool === "write" || e.tool === "ast_edit") && !e.error && e.ts > lastPass);
}

/** Keep only the last `maxBytes` of a log so a noisy build can't fill the disk. */
export function capLog(file: string, maxBytes = 5 * 1024 * 1024): void {
	try {
		const size = fs.statSync(file).size;
		if (size <= maxBytes) return;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(maxBytes);
		fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
		fs.closeSync(fd);
		fs.writeFileSync(file, Buffer.concat([Buffer.from(`[... first ${size - maxBytes} bytes dropped ...]\n`), buf]));
	} catch {
		// missing log is not fatal
	}
}

export function tailLines(text: string, n: number): string {
	const lines = text.replace(/\s+$/, "").split("\n");
	return lines.slice(-n).join("\n");
}

export function tailFile(file: string, n: number, maxBytes = 256 * 1024): string {
	try {
		const size = fs.statSync(file).size;
		const start = Math.max(0, size - maxBytes);
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		fs.closeSync(fd);
		return tailLines(buf.toString("utf8"), n);
	} catch {
		return "";
	}
}

/** First merge request URL in glab output. */
export function parseMrUrl(text: string): string | undefined {
	return text.match(/https?:\/\/\S+?\/-\/merge_requests\/\d+/)?.[0] ?? text.match(/https?:\/\/\S+merge_requests\/\d+/)?.[0];
}

export const FINISHED = new Set(["success", "failed", "canceled", "cancelled", "skipped", "manual"]);

export interface CiJob {
	id: number;
	name: string;
	stage?: string;
	status: string;
}

/** Pull status, web URL and jobs out of `glab ci get -F json` output. */
export function parsePipeline(json: string): { status: string; url?: string; jobs: CiJob[] } | undefined {
	try {
		const p = JSON.parse(json) as { status?: string; web_url?: string; jobs?: CiJob[] };
		if (!p.status) return undefined;
		return { status: p.status, url: p.web_url, jobs: (p.jobs ?? []).map(j => ({ id: j.id, name: j.name, stage: j.stage, status: j.status })) };
	} catch {
		return undefined;
	}
}

/** Merge request description: plain and short, built from the task records. */
export function mrDescription(opts: {
	overview?: string;
	changedFiles: string[];
	lastVerify?: VerifyRun;
	stepsDone: string[];
	extra?: string;
}): string {
	const out: string[] = [];
	out.push("## Summary", "", opts.overview?.trim() || "See the steps below.", "");
	if (opts.extra?.trim()) out.push(opts.extra.trim(), "");
	out.push("## What changed", "");
	out.push(opts.changedFiles.length ? opts.changedFiles.map(f => `- \`${f}\``).join("\n") : "- (no file list)");
	out.push("", "## How it was tested", "");
	if (opts.lastVerify) {
		for (const r of opts.lastVerify.results) out.push(`- \`${r.cmd}\`: ${r.ok ? "passed" : "FAILED"} (${r.secs}s)`);
	} else {
		out.push("- No automated checks configured.");
	}
	if (opts.stepsDone.length) out.push("", "## Steps", "", ...opts.stepsDone.map((s, i) => `${i + 1}. ${s}`));
	out.push("", "_Prepared by an agent with the llm-graphs OMP plugin. Needs human review._");
	return out.join("\n");
}
