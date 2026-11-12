/**
 * Verify loop and GitLab steps, run by code rather than the model:
 *  - verify: runs the repo's build and test commands, logs output to the task
 *    folder, and returns only the tail of a failure. Retries are capped per step.
 *  - gate: a step that edited files can't be marked done until verify passes.
 *  - open_mr: pushes the branch and opens the merge request with glab.
 *  - watch_pipeline: polls the pipeline and returns failed job log tails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskStore } from "../report/store";
import { CONFIG_TEMPLATE, configPaths, loadConfig, type RepoConfig } from "./config";
import {
	type CheckResult,
	capLog,
	FINISHED,
	type FailedJob,
	failuresForStep,
	mrDescription,
	needsVerify,
	parseMrUrl,
	parsePipeline,
	tailFile,
	tailLines,
	VerifyState,
	type VerifyRun,
} from "./state";

const FAIL_TAIL_LINES = 60; // lines of a failing log the model sees

export interface VerifyDeps {
	getStore: () => TaskStore | undefined;
	repo: () => { name: string; top: string };
	activeStep: () => number | undefined;
	stepsDone: () => string[];
	changedFiles: (ctx: ExtensionContext) => Promise<string[]>;
	ensureTask: (ctx: ExtensionContext, title: string) => Promise<TaskStore>;
}

export interface VerifyHooks {
	/** Error text if the active step can't finish yet, else undefined. */
	gate(): string | undefined;
	/** Records for the report. */
	view(): { lastVerify?: VerifyRun; mrUrl?: string; pipeline?: ReturnType<VerifyState["pipeline"]> };
	/** Prompt lines describing the configured checks. */
	promptBlock(): string;
}

function text(t: string, isError = false) {
	return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function registerVerify(pi: ExtensionAPI, deps: VerifyDeps): VerifyHooks {
	const z = pi.zod;

	function config(): { config?: RepoConfig; error?: string } {
		const { name, top } = deps.repo();
		return name ? loadConfig(name, top) : {};
	}

	function state(): VerifyState | undefined {
		const store = deps.getStore();
		return store ? new VerifyState(store.dir) : undefined;
	}

	async function run(cmd: string, args: string[], timeoutMs: number) {
		try {
			return await pi.exec(cmd, args, { cwd: deps.repo().top, timeout: timeoutMs });
		} catch (e) {
			return { stdout: "", stderr: String(e), code: -1, killed: false };
		}
	}

	async function git(args: string[], timeoutMs = 60_000) {
		return run("git", args, timeoutMs);
	}

	// ---------- verify ----------

	async function runVerify(
		ctx: ExtensionContext,
		only: string[] | undefined,
		onUpdate?: (msg: string) => void,
	): Promise<{ run?: VerifyRun; message: string; isError: boolean }> {
		const { config: cfg, error } = config();
		if (error) return { message: error, isError: true };
		if (!cfg?.verify.length) {
			return {
				message: `No verify checks configured for this repo. Ask the user to run /verify setup. Looked in: ${configPaths(deps.repo().name, deps.repo().top).join(", ")}`,
				isError: true,
			};
		}
		const st = state()!;
		const step = deps.activeStep();
		const failed = failuresForStep(st.runs(), step);
		if (failed >= cfg.max_attempts) {
			return {
				message: `Verify has failed ${failed} times on this step, the limit is ${cfg.max_attempts}. Stop retrying: call step_blocked with a one-sentence reason, and put what you tried in report_step.`,
				isError: true,
			};
		}
		const checks = only?.length ? cfg.verify.filter(c => only.includes(c.name)) : cfg.verify;
		const n = st.runs().length + 1;
		const results: CheckResult[] = [];
		for (const c of checks) {
			const log = st.logPath(n, c.name);
			const script = `${log}.sh`;
			fs.writeFileSync(script, `cd ${shq(deps.repo().top)}\n${c.cmd}\n`);
			const started = Date.now();
			onUpdate?.(`Running ${c.name}: ${c.cmd}`);
			const ticker = setInterval(() => {
				const last = tailFile(log, 1).slice(0, 200);
				onUpdate?.(`${c.name} running ${Math.round((Date.now() - started) / 1000)}s${last ? `: ${last}` : ""}`);
			}, 30_000);
			const timeoutMs = (c.timeout_min ?? 30) * 60_000;
			const r = await run("bash", ["-c", `bash ${shq(script)} > ${shq(log)} 2>&1`], timeoutMs);
			clearInterval(ticker);
			fs.rmSync(script, { force: true });
			capLog(log);
			results.push({
				name: c.name,
				cmd: c.cmd,
				ok: r.code === 0,
				code: r.code,
				timedOut: r.killed,
				secs: Math.round((Date.now() - started) / 1000),
				log,
			});
			if (r.code !== 0) break; // later checks depend on earlier ones (build before tests)
		}
		const verifyRun: VerifyRun = { ts: new Date().toISOString(), step, ok: results.every(r => r.ok), results };
		st.addRun(verifyRun);
		if (verifyRun.ok) {
			return { run: verifyRun, message: `Verify passed: ${results.map(r => `${r.name} (${r.secs}s)`).join(", ")}.`, isError: false };
		}
		const bad = results.find(r => !r.ok)!;
		const left = cfg.max_attempts - failures(st, step);
		return {
			run: verifyRun,
			message: [
				`Verify FAILED at "${bad.name}" (${bad.timedOut ? "timed out" : `exit ${bad.code}`}, ${bad.secs}s). ${left} attempt(s) left on this step.`,
				`Last ${FAIL_TAIL_LINES} lines of ${bad.log}:`,
				"```",
				tailFile(bad.log, FAIL_TAIL_LINES),
				"```",
				"Fix the cause, then call verify again. Read the full log if the tail is not enough.",
			].join("\n"),
			isError: true,
		};
	}

	function failures(st: VerifyState, step: number | undefined): number {
		return failuresForStep(st.runs(), step);
	}

	pi.registerTool({
		name: "verify",
		label: "Verify",
		loadMode: "essential",
		approval: "exec",
		description:
			"Run the repo's configured build and test checks after a change. The plugin runs them, saves the full logs, and returns the result. Call it after every change; a step with edits can't be finished until verify passes.",
		parameters: z.object({
			checks: z.array(z.string()).optional().describe("Names of checks to run; omit to run all in order"),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			await deps.ensureTask(ctx, "Verify");
			void signal;
			const r = await runVerify(ctx, params.checks, msg => onUpdate?.(text(msg)));
			return text(r.message, r.isError);
		},
	});

	// ---------- merge request ----------

	pi.registerTool({
		name: "open_mr",
		label: "Open merge request",
		loadMode: "essential",
		approval: "exec",
		description:
			"Push the current branch and open a GitLab merge request with glab. Needs a passing verify, a feature branch, and the task's changes committed. The description is built from the task records.",
		parameters: z.object({
			title: z.string().describe("Merge request title, plain and specific"),
			note: z.string().optional().describe("Anything reviewers must know that the summary does not say"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const store = await deps.ensureTask(ctx, params.title);
			const { config: cfg, error } = config();
			if (error) return text(error, true);
			if (!cfg?.mr) return text("Merge requests are not configured for this repo (no \"mr.target_branch\"). Tell the user the change is ready and stop here.", true);
			const st = state()!;
			if (cfg.verify.length && needsVerify(store.ledger(), st.runs())) {
				return text("Files changed since the last passing verify. Call verify first.", true);
			}
			const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
			if (!branch || branch === "HEAD" || branch === cfg.mr.target_branch) {
				return text(`You are on "${branch || "detached HEAD"}". Create a feature branch first (git switch -c <name>), commit, then call open_mr.`, true);
			}
			const changed = await deps.changedFiles(ctx);
			const dirtyAtStart = new Set(store.info().dirtyAtStart);
			const porcelain = (await git(["status", "--porcelain"])).stdout
				.split("\n")
				.filter(l => l.length > 3)
				.map(l => l.slice(3));
			const uncommitted = porcelain.filter(f => changed.includes(f) && !dirtyAtStart.has(f));
			if (uncommitted.length) return text(`Commit these files first: ${uncommitted.join(", ")}`, true);

			const push = await git(["push", "-u", "origin", "HEAD"], 10 * 60_000);
			if (push.code !== 0) return text(`git push failed:\n${tailLines(`${push.stdout}\n${push.stderr}`, 30)}`, true);

			const runs = st.runs();
			const body = mrDescription({
				overview: store.summary()?.overview,
				changedFiles: changed,
				lastVerify: [...runs].reverse().find(r => r.ok),
				stepsDone: deps.stepsDone(),
				extra: params.note,
			});
			const bodyFile = path.join(store.dir, "mr-description.md");
			fs.writeFileSync(bodyFile, body);
			const args = ["mr", "create", "--source-branch", branch, "--target-branch", cfg.mr.target_branch, "--title", params.title, "--description", body, "--yes"];
			if (cfg.mr.draft) args.push("--draft");
			if (cfg.mr.remove_source_branch) args.push("--remove-source-branch");
			if (cfg.mr.reviewers?.length) args.push("--reviewer", cfg.mr.reviewers.join(","));
			if (cfg.mr.labels?.length) args.push("--label", cfg.mr.labels.join(","));
			let r = await run("glab", args, 120_000);
			let url = parseMrUrl(`${r.stdout}\n${r.stderr}`);
			if (!url) {
				// already open for this branch? look it up instead of failing
				const view = await run("glab", ["mr", "view", branch, "-F", "json"], 60_000);
				try {
					url = (JSON.parse(view.stdout) as { web_url?: string }).web_url;
				} catch {
					url = undefined;
				}
				if (!url) return text(`glab mr create failed:\n${tailLines(`${r.stdout}\n${r.stderr}`, 30)}`, true);
				r = view;
			}
			st.setMr({ ts: new Date().toISOString(), url, branch, target: cfg.mr.target_branch });
			return text(`Merge request: ${url}\nNext: call watch_pipeline to wait for the pipeline.`);
		},
	});

	// ---------- pipeline ----------

	async function pipelineOnce(branch: string) {
		const r = await run("glab", ["ci", "get", "-b", branch, "-F", "json"], 60_000);
		return parsePipeline(r.stdout);
	}

	pi.registerTool({
		name: "watch_pipeline",
		label: "Watch pipeline",
		loadMode: "essential",
		approval: "read",
		description:
			"Wait for the GitLab pipeline on the current branch to finish. Returns the result and the end of each failed job's log. Fix failures, verify, commit, push, and watch again.",
		parameters: z.object({}),
		async execute(_id, _params, signal, onUpdate, ctx) {
			const store = await deps.ensureTask(ctx, "Pipeline");
			const { config: cfg, error } = config();
			if (error) return text(error, true);
			const pollMs = (cfg?.pipeline.poll_sec ?? 60) * 1000;
			const deadline = Date.now() + (cfg?.pipeline.max_wait_min ?? 120) * 60_000;
			const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
			const st = new VerifyState(store.dir);
			let p = await pipelineOnce(branch);
			while ((!p || !FINISHED.has(p.status)) && Date.now() < deadline && !signal?.aborted) {
				onUpdate?.(text(`Pipeline on ${branch}: ${p?.status ?? "not found yet"}`));
				await new Promise(res => setTimeout(res, pollMs));
				p = await pipelineOnce(branch);
			}
			if (!p) return text(`No pipeline found for branch ${branch}. Check that it was pushed and that CI runs on it.`, true);
			const status = FINISHED.has(p.status) ? p.status : "timeout";
			const failedJobs: FailedJob[] = [];
			for (const j of p.jobs.filter(j => j.status === "failed")) {
				const trace = await run("glab", ["ci", "trace", String(j.id), "-b", branch], 120_000);
				const full = `${trace.stdout}\n${trace.stderr}`;
				const logFile = path.join(store.dir, "verify", `pipeline-job-${j.id}.log`);
				fs.mkdirSync(path.dirname(logFile), { recursive: true });
				fs.writeFileSync(logFile, full);
				capLog(logFile);
				failedJobs.push({ id: j.id, name: j.name, stage: j.stage, tail: tailLines(full, 40) });
			}
			st.setPipeline({ ts: new Date().toISOString(), branch, status, url: p.url, failedJobs });
			if (status === "success") return text(`Pipeline passed${p.url ? `: ${p.url}` : ""}.`);
			if (status === "timeout") return text(`Pipeline still ${p.status} after the wait limit. Report this with report_step and tell the user.`, true);
			const parts = [`Pipeline ${status}${p.url ? `: ${p.url}` : ""}.`];
			for (const j of failedJobs) parts.push(`\nJob "${j.name}" (${j.stage ?? "?"}) failed. Last lines:\n\`\`\`\n${j.tail}\n\`\`\``);
			parts.push("\nFix the cause, run verify, commit, push, then call watch_pipeline again.");
			return text(parts.join("\n"), true);
		},
	});

	// ---------- command ----------

	pi.registerCommand("verify", {
		description: "/verify runs the checks now; /verify setup creates or edits this repo's config",
		handler: async (args, ctx) => {
			const notify = (m: string, t: "info" | "warning" = "info") => (ctx.hasUI ? ctx.ui.notify(m, t) : console.log(m));
			if ((args ?? "").trim() === "setup") {
				const file = configPaths(deps.repo().name, deps.repo().top)[0]!;
				const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : CONFIG_TEMPLATE;
				if (!ctx.hasUI) return notify(`Config file: ${file}`);
				const edited = await ctx.ui.editor(`Verify config for ${deps.repo().name} (saved to ${file})`, current);
				if (edited === undefined) return;
				try {
					JSON.parse(edited);
				} catch (e) {
					return notify(`Not saved, invalid JSON: ${(e as Error).message}`, "warning");
				}
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, edited.endsWith("\n") ? edited : `${edited}\n`);
				return notify(`Saved ${file}`);
			}
			await deps.ensureTask(ctx, "Verify");
			const r = await runVerify(ctx, undefined, m => ctx.hasUI && ctx.ui.setWorkingMessage(m));
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
			notify(r.message.split("\n")[0]!, r.isError ? "warning" : "info");
		},
	});

	return {
		gate() {
			const store = deps.getStore();
			const { config: cfg } = config();
			if (!store || !cfg?.verify.length) return undefined;
			if (!needsVerify(store.ledger(), new VerifyState(store.dir).runs())) return undefined;
			return "Files changed since the last passing verify. Call verify, fix any failures, then call step_done again.";
		},
		view() {
			const st = state();
			if (!st) return {};
			return { lastVerify: st.runs().at(-1), mrUrl: st.mr()?.url, pipeline: st.pipeline() };
		},
		promptBlock() {
			const { config: cfg } = config();
			if (!cfg?.verify.length) return "";
			const lines = [
				"## Verify and merge request (llm-graphs)",
				`- After each change, call verify. It runs: ${cfg.verify.map(c => `${c.name} (\`${c.cmd}\`)`).join(", ")}. Do not run these yourself.`,
				`- A step with edits can't be finished until verify passes. After ${cfg.max_attempts} failed verifies on one step, call step_blocked.`,
			];
			if (cfg.mr) {
				lines.push(
					`- When the work is done and verified: create a feature branch, commit, call open_mr (target ${cfg.mr.target_branch}), then watch_pipeline. Fix pipeline failures the same way.`,
				);
			}
			return lines.join("\n");
		},
	};
}
