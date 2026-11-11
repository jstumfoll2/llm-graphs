/**
 * Builds REPORT.md from the task folder. Pure function: data in, markdown out.
 * The layout is fixed so every report reads the same way: summary and
 * decisions first, then what changed, then tests, then the step log.
 */
import type { Plan } from "../graph/plan";
import type { PipelineRecord, VerifyRun } from "../verify/state";
import type { LedgerEntry, StepEntry, Summary, TaskInfo, TestRun } from "./store";

export interface GitView {
	diffStat?: string; // `git diff --stat <baseHead>` output
	changedFiles: string[]; // files changed since the task started
	lastVerify?: VerifyRun; // latest run of the repo's checks, by code
	mrUrl?: string;
	pipeline?: PipelineRecord;
}

function when(iso: string): string {
	return iso.replace("T", " ").slice(0, 16);
}

function duration(fromIso: string, toIso: string): string {
	const mins = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
	if (mins < 60) return `${mins} min`;
	return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function bullets(items: string[]): string {
	return items.map(i => `- ${i}`).join("\n");
}

/** Latest result per test command, in first-seen order. */
export function latestTests(steps: StepEntry[]): TestRun[] {
	const byCmd = new Map<string, TestRun>();
	for (const s of steps) for (const t of s.tests) byCmd.set(t.command, t);
	return [...byCmd.values()];
}

function dedupe(items: string[]): string[] {
	return [...new Set(items.map(i => i.trim()).filter(Boolean))];
}

export function renderReport(
	info: TaskInfo,
	steps: StepEntry[],
	ledger: LedgerEntry[],
	summary: Summary | undefined,
	git: GitView,
	now = new Date().toISOString(),
	plan?: Plan,
): string {
	const out: string[] = [];
	const last = steps.at(-1)?.ts ?? ledger.at(-1)?.ts ?? info.startedAt;

	out.push(`# ${info.title}`);
	out.push("");
	out.push(
		`Started ${when(info.startedAt)} · last activity ${when(last)} · ${duration(info.startedAt, last)} · ${steps.length} step notes · report built ${when(now)}`,
	);
	out.push(`Repo: ${info.repo} (${info.cwd})`);
	out.push("");

	out.push("## Summary");
	out.push("");
	if (summary) {
		out.push(summary.overview.trim());
		if (summary.mrLink && summary.mrLink !== git.mrUrl) out.push("", `Merge request: ${summary.mrLink}`);
	} else if (steps.length) {
		out.push("No final summary yet. Run `/report final` to have the agent write one.");
		out.push("");
		out.push(`Latest step: **${steps.at(-1)!.title}**. ${steps.at(-1)!.done}`);
	} else {
		out.push("No steps reported yet.");
	}
	out.push("");

	const status: string[] = [];
	if (git.lastVerify) {
		status.push(
			`Checks (run by the plugin, ${when(git.lastVerify.ts)}): ${git.lastVerify.ok ? "passed" : "FAILED"}: ${git.lastVerify.results.map(r => `${r.name} ${r.ok ? "ok" : r.timedOut ? "timed out" : `exit ${r.code}`}`).join(", ")}`,
		);
	}
	if (git.mrUrl) status.push(`Merge request: ${git.mrUrl}`);
	if (git.pipeline) status.push(`Pipeline: ${git.pipeline.status}${git.pipeline.url ? ` (${git.pipeline.url})` : ""}${git.pipeline.failedJobs.length ? `, failed jobs: ${git.pipeline.failedJobs.map(j => j.name).join(", ")}` : ""}`);
	if (status.length) {
		out.push(bullets(status));
		out.push("");
	}

	const needsYou = dedupe([...(summary?.needsYou ?? []), ...steps.flatMap(s => s.needsYou)]);
	out.push("## Needs your decision");
	out.push("");
	out.push(needsYou.length ? bullets(needsYou) : "Nothing.");
	out.push("");

	if (plan?.steps.length) {
		const done = plan.steps.filter(p => p.status === "done").length;
		out.push("## Plan");
		out.push("");
		out.push(`${done} of ${plan.steps.length} steps done.${plan.inbox.length ? ` ${plan.inbox.length} queued ask(s) not yet added.` : ""}`);
		out.push("");
		out.push("| # | Step | Status | Evidence or reason |");
		out.push("| --- | --- | --- | --- |");
		for (const p of plan.steps) {
			const note = (p.evidence ?? p.reason ?? "").replace(/\|/g, "/").replace(/\s+/g, " ");
			const title = p.source === "inbox" ? `${p.title} (your ask)` : p.title;
			out.push(`| ${p.id} | ${title} | ${p.status} | ${note} |`);
		}
		const held = plan.advisor.filter(a => !a.allowed);
		if (held.length) {
			out.push("", "Advisor notes held back during a step (review these):");
			out.push(bullets(held.map(a => `Step ${a.step}: ${a.text.replace(/\s+/g, " ").slice(0, 400)}`)));
		}
		out.push("");
	}

	out.push("## What changed");
	out.push("");
	if (git.changedFiles.length) {
		out.push(bullets(git.changedFiles.map(f => `\`${f}\``)));
		if (git.diffStat?.trim()) out.push("", "```", git.diffStat.trimEnd(), "```");
	} else {
		out.push("No file changes since the task started.");
	}
	if (info.dirtyAtStart.length) {
		out.push("", `Already modified before this task started (not counted above): ${info.dirtyAtStart.map(f => `\`${f}\``).join(", ")}`);
	}
	out.push("");

	const tests = latestTests(steps);
	out.push("## Tests");
	out.push("");
	if (tests.length) {
		out.push("| Command | Latest result | Note |");
		out.push("| --- | --- | --- |");
		for (const t of tests) out.push(`| \`${t.command}\` | ${t.result.replace("_", " ")} | ${t.note ?? ""} |`);
	} else {
		out.push("No test runs reported.");
	}
	out.push("");

	const questions = dedupe(steps.flatMap(s => s.openQuestions));
	if (questions.length) {
		out.push("## Open questions");
		out.push("");
		out.push(bullets(questions));
		out.push("");
	}

	out.push("## Step log");
	out.push("");
	for (const s of steps) {
		out.push(`### ${s.n}. ${s.title}`);
		out.push("");
		out.push(`_${when(s.ts)}_`);
		out.push("");
		out.push(s.done.trim());
		if (s.decisions.length) {
			out.push("", "Decisions:", bullets(s.decisions.map(d => `${d.what}. Why: ${d.why}`)));
		}
		if (s.files.length) out.push("", `Files: ${s.files.map(f => `\`${f}\``).join(", ")}`);
		if (s.openQuestions.length) out.push("", "Open questions:", bullets(s.openQuestions));
		out.push("");
	}
	if (!steps.length) out.push("None yet.", "");

	const edits = ledger.filter(e => e.tool === "edit" || e.tool === "write").length;
	const cmds = ledger.filter(e => e.tool === "bash");
	const failed = cmds.filter(e => e.error).length;
	out.push("## Activity");
	out.push("");
	out.push(`${edits} file edits, ${cmds.length} commands (${failed} failed). Full log: ledger.jsonl in this folder.`);
	out.push("");

	return out.join("\n");
}

/** A few lines for the widget above the editor. */
export function renderBrief(info: TaskInfo, steps: StepEntry[], changed: number): string[] {
	const last = steps.at(-1);
	const tests = latestTests(steps);
	const failing = tests.filter(t => t.result === "fail").length;
	const lines = [`Task: ${info.title}`, `${steps.length} steps · ${changed} files changed · tests: ${tests.length ? `${tests.length - failing} pass, ${failing} fail` : "none run"}`];
	if (last) lines.push(`Last: ${last.title}`);
	return lines;
}
