/**
 * llm-graphs report extension for OMP.
 *
 * What it does:
 *  - Logs every edit, write and shell command to the task's ledger (a hook,
 *    so it never depends on the model remembering).
 *  - Gives the model a `report_step` tool with a fixed shape: what was done,
 *    decisions and why, tests, open questions, things that need you.
 *  - Nudges the agent once if it stops after real work without reporting.
 *  - `/report` builds one REPORT.md per task from those files.
 *
 * Subagents working in the same checkout write into the lead's current task,
 * so delegated work shows up in the same report.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { renderBrief, renderReport } from "./render";
import { newTaskId, pruneTasks, reportRoot, type StepEntry, slug, TaskStore } from "./store";

const ENTRY_TYPE = "llmg-task"; // session entry that remembers the current task id
const LOGGED_TOOLS = new Set(["edit", "write", "bash", "ast_edit"]);
const OWN_TOOLS = new Set(["report_step", "report_summary"]);

const NUDGE_AFTER = Number(process.env.OMP_REPORT_NUDGE_AFTER ?? 3); // unreported edits/commands before a nudge
const KEEP_TASKS = Number(process.env.OMP_REPORT_KEEP ?? 30); // task folders kept per repo

const RULES = `## Reporting (llm-graphs)
- After each meaningful step (a finding, a change, a test run, a dead end), call report_step. Do not save it all for the end.
- Write for a busy engineer: plain words, full sentences, no filler or invented terms. Name files, functions and numbers.
- Keep chat replies to a few sentences; the report holds the detail.
- When the whole task is done or blocked, call report_summary.`;

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export default function reportExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const root = reportRoot();

	let store: TaskStore | undefined;
	let repo = "";
	let repoTop = "";
	let actionsSinceStep = 0;
	let nudged = false;
	let pathsSinceStep = new Set<string>();
	let statusAtLastStep = new Set<string>();

	// ---------- git helpers (all read-only) ----------

	async function git(ctx: ExtensionContext, args: string[]): Promise<string | undefined> {
		try {
			const r = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 60_000 });
			return r.code === 0 ? r.stdout : undefined;
		} catch {
			return undefined;
		}
	}

	/** Paths from `git status --porcelain`, relative to the repo top. */
	async function statusPaths(ctx: ExtensionContext): Promise<Set<string>> {
		const out = await git(ctx, ["status", "--porcelain"]);
		const set = new Set<string>();
		for (const line of out?.split("\n") ?? []) {
			if (line.length < 4) continue;
			const p = line.slice(3);
			set.add(p.includes(" -> ") ? p.split(" -> ")[1]! : p);
		}
		return set;
	}

	function relPath(p: string, ctx: ExtensionContext): string {
		const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd, p);
		return path.relative(repoTop || ctx.cwd, abs) || p;
	}

	async function detectRepo(ctx: ExtensionContext): Promise<void> {
		if (repo) return;
		repoTop = (await git(ctx, ["rev-parse", "--show-toplevel"]))?.trim() || ctx.cwd;
		repo = path.basename(repoTop);
	}

	function pointerFile(): string {
		return path.join(root, slug(repo, 60), "CURRENT");
	}

	// ---------- task lifecycle ----------

	async function startTask(ctx: ExtensionContext, title: string): Promise<TaskStore> {
		await detectRepo(ctx);
		const cleanTitle = title.split("\n")[0]!.trim().slice(0, 80) || "Untitled task";
		const id = newTaskId(cleanTitle);
		const s = new TaskStore(root, repo, id);
		const dirty = await statusPaths(ctx);
		s.create({
			id,
			title: cleanTitle,
			repo,
			cwd: repoTop,
			startedAt: new Date().toISOString(),
			baseHead: (await git(ctx, ["rev-parse", "HEAD"]))?.trim(),
			dirtyAtStart: [...dirty],
		});
		fs.writeFileSync(pointerFile(), `${id}\n`);
		pi.appendEntry(ENTRY_TYPE, { id, repo });
		pruneTasks(root, repo, KEEP_TASKS);
		store = s;
		actionsSinceStep = 0;
		nudged = false;
		pathsSinceStep = new Set();
		statusAtLastStep = dirty;
		updateStatus(ctx);
		return s;
	}

	/** Restore the task this session was working on, or the lead's task for a subagent. */
	async function restoreTask(ctx: ExtensionContext): Promise<void> {
		await detectRepo(ctx);
		let id: string | undefined;
		if (ctx.agent?.kind === "sub") {
			try {
				id = fs.readFileSync(pointerFile(), "utf8").trim();
			} catch {
				id = undefined;
			}
		} else {
			for (const entry of ctx.sessionManager.getBranch()) {
				const e = entry as { type?: string; customType?: string; data?: { id?: string } };
				if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data?.id) id = e.data.id;
			}
		}
		if (!id) return;
		const s = new TaskStore(root, repo, id);
		if (!s.exists()) return;
		store = s;
		statusAtLastStep = await statusPaths(ctx);
		if (ctx.agent?.kind !== "sub") fs.writeFileSync(pointerFile(), `${id}\n`);
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !store) return;
		const steps = store.steps().length;
		ctx.ui.setStatus("llmg-report", `report: ${steps} step${steps === 1 ? "" : "s"}`);
	}

	async function changedSinceStart(ctx: ExtensionContext, s: TaskStore): Promise<string[]> {
		const info = s.info();
		const files = new Set<string>();
		if (info.baseHead) {
			for (const f of (await git(ctx, ["diff", "--name-only", info.baseHead]))?.split("\n") ?? []) if (f) files.add(f);
		}
		for (const f of await statusPaths(ctx)) files.add(f);
		for (const f of info.dirtyAtStart) files.delete(f);
		for (const e of s.ledger()) if (e.path) files.add(e.path); // edits to already-dirty files still count
		return [...files].sort();
	}

	async function buildReport(ctx: ExtensionContext, s: TaskStore): Promise<{ file: string; brief: string[] }> {
		const info = s.info();
		const changedFiles = await changedSinceStart(ctx, s);
		const diffStat = info.baseHead ? await git(ctx, ["diff", "--stat", info.baseHead]) : undefined;
		const steps = s.steps();
		const md = renderReport(info, steps, s.ledger(), s.summary(), { changedFiles, diffStat });
		return { file: s.writeReport(md), brief: renderBrief(info, steps, changedFiles.length) };
	}

	// ---------- hooks ----------

	pi.on("session_start", async (_event, ctx) => {
		await restoreTask(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store && ctx.agent?.kind !== "sub") await startTask(ctx, event.prompt);
		return { systemPrompt: [...event.systemPrompt, RULES] };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!store || OWN_TOOLS.has(event.toolName) || !LOGGED_TOOLS.has(event.toolName)) return;
		const input = event.input as { path?: string; file_path?: string; command?: string };
		const rawPath = input.path ?? input.file_path;
		const p = rawPath ? relPath(rawPath, ctx) : undefined;
		store.addLedger({
			ts: new Date().toISOString(),
			tool: event.toolName,
			path: p,
			command: input.command?.slice(0, 300),
			error: event.isError,
		});
		if (p) pathsSinceStep.add(p);
		actionsSinceStep++;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!store || event.willContinue || ctx.agent?.kind === "sub") return;
		if (actionsSinceStep < NUDGE_AFTER || nudged) return;
		nudged = true; // one nudge per gap, so it can never loop
		pi.sendMessage(
			{
				customType: "llmg-nudge",
				content: `You made ${actionsSinceStep} edits or commands since your last report_step. Call report_step for that work now, then stop or continue as planned.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	// ---------- tools ----------

	pi.registerTool({
		name: "report_step",
		label: "Report step",
		loadMode: "essential",
		approval: "read",
		description:
			"Record one finished step of the task in the task report. Call it after each meaningful step: a finding, a change, a test run, or a dead end. Use plain words and full sentences.",
		parameters: z.object({
			title: z.string().describe("Short name of the step, under 80 characters, e.g. 'Found why the gain table is off by one'"),
			done: z
				.string()
				.describe("What you did and what you found, 2 to 5 plain sentences. Name files, functions and numbers."),
			decisions: z
				.array(z.object({ what: z.string(), why: z.string() }))
				.optional()
				.describe("Choices you made in this step and why"),
			tests: z
				.array(
					z.object({
						command: z.string(),
						result: z.enum(["pass", "fail", "not_run"]),
						note: z.string().optional(),
					}),
				)
				.optional()
				.describe("Tests or builds you ran in this step"),
			open_questions: z.array(z.string()).optional().describe("Things still unknown"),
			needs_you: z.array(z.string()).optional().describe("Decisions only the user can make"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!store) await startTask(ctx, params.title);
			const words = wordCount(params.done);
			if (words < 12 || words > 160) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Not recorded: 'done' has ${words} words. Write 2 to 5 plain sentences (12 to 160 words) saying what you did and what you found, then call report_step again.`,
						},
					],
				};
			}
			const now = await statusPaths(ctx);
			const files = new Set(pathsSinceStep);
			for (const f of now) if (!statusAtLastStep.has(f)) files.add(f);
			const step: StepEntry = {
				n: store!.steps().length + 1,
				ts: new Date().toISOString(),
				title: params.title.trim().slice(0, 80),
				done: params.done.trim(),
				decisions: params.decisions ?? [],
				tests: params.tests ?? [],
				openQuestions: params.open_questions ?? [],
				needsYou: params.needs_you ?? [],
				files: [...files].sort(),
			};
			store!.addStep(step);
			actionsSinceStep = 0;
			nudged = false;
			pathsSinceStep = new Set();
			statusAtLastStep = now;
			updateStatus(ctx);
			return { content: [{ type: "text", text: `Recorded step ${step.n}.` }], details: { step: step.n } };
		},
	});

	pi.registerTool({
		name: "report_summary",
		label: "Report summary",
		loadMode: "essential",
		approval: "read",
		description:
			"Write the final summary for the task report when the task is done or blocked. Plain words: what changed, how it was tested, and what the user must decide.",
		parameters: z.object({
			overview: z.string().describe("3 to 8 plain sentences: the outcome, what changed, how it was tested"),
			needs_you: z.array(z.string()).optional().describe("Decisions or approvals only the user can give"),
			mr_link: z.string().optional().describe("Merge request URL, if one was opened"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!store) await startTask(ctx, "Untitled task");
			const words = wordCount(params.overview);
			if (words < 20 || words > 250) {
				return {
					isError: true,
					content: [
						{ type: "text", text: `Not recorded: overview has ${words} words. Write 3 to 8 plain sentences (20 to 250 words).` },
					],
				};
			}
			store!.setSummary({
				ts: new Date().toISOString(),
				overview: params.overview.trim(),
				needsYou: params.needs_you ?? [],
				mrLink: params.mr_link,
			});
			const { file } = await buildReport(ctx, store!);
			return { content: [{ type: "text", text: `Summary saved. Report: ${file}` }] };
		},
	});

	// ---------- command ----------

	pi.registerCommand("report", {
		description: "Task report: /report | /report view | /report final | /report new <title> | /report path",
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = (args ?? "").trim().split(/\s+/);
			const notify = (msg: string, type: "info" | "warning" = "info") =>
				ctx.hasUI ? ctx.ui.notify(msg, type) : console.log(msg);

			if (sub === "new") {
				const s = await startTask(ctx, rest.join(" ") || "Untitled task");
				notify(`Started task: ${s.info().title}`);
				return;
			}
			if (!store) {
				notify("No task yet. It starts with your first prompt, or use /report new <title>.", "warning");
				return;
			}
			if (sub === "path") {
				notify(store.dir);
				return;
			}
			if (sub === "final") {
				await pi.sendUserMessage(
					"Write the final task summary now with report_summary: the outcome, what changed, how it was tested, and anything I must decide. If any finished step has not been reported yet, call report_step for it first.",
				);
				return;
			}
			const { file, brief } = await buildReport(ctx, store);
			if (sub === "view" && ctx.hasUI) {
				await ctx.ui.editor(`Report (read only, Esc to close): ${file}`, fs.readFileSync(file, "utf8"));
				return;
			}
			if (ctx.hasUI) ctx.ui.setWidget("llmg-report", [...brief, `Report: ${file}`]);
			notify(`Report written: ${file}`);
		},
	});
}
