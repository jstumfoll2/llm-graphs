/**
 * Lead mode: the agent you talk to plans, hands steps to workers, checks
 * their evidence and reports. It doesn't edit files or run commands itself
 * (git and glab excepted, so it can commit and open the MR). Workers are
 * OMP subagents defined in this package's agents/ folder; each one starts
 * with a fresh, short context and only its assignment.
 *
 * On when OMP_GRAPH_LEAD=1, when the repo config has "lead": true, or after
 * /lead on. /lead off turns it off for this session.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const ENTRY_TYPE = "llmg-lead"; // session entry that remembers /lead on|off

/** Tools the lead may not call itself in lead mode. */
export const WORKER_ONLY = new Set(["edit", "write", "ast_edit", "bash", "eval"]);

export const WORKERS = {
	"llmg-investigate": "find and explain: read code, logs and build output, run read-only commands, answer a question",
	"llmg-test": "write or update tests for a behavior, run them, and report what they show",
	"llmg-fix": "make one change, build and run the focused tests, and report the diff",
} as const;

/**
 * A bash command the lead may still run itself: a single git or glab call,
 * with no chaining, pipes, redirects or substitution.
 */
export function leadMayRun(command: string): boolean {
	const c = command.trim();
	if (!/^(git|glab)\s/.test(c)) return false;
	return !/[;&|`$<>\n]/.test(c);
}

export function blockReason(tool: string): string {
	const list = Object.entries(WORKERS)
		.map(([name, job]) => `${name} (${job})`)
		.join("; ");
	return `Lead mode: you don't ${tool === "bash" ? "run commands" : "edit files"} yourself${tool === "bash" ? " (single git or glab calls are fine)" : ""}. Hand this to a worker with the task tool: ${list}. Give it the step, the files, what you know, and how to tell it is done.`;
}

export const LEAD_RULES = `## Lead mode (llm-graphs)
You are the lead. You plan, hand out steps, check results, and talk to the user. You don't edit files or run commands yourself; single git and glab calls are the exception.
- For each step, call the task tool with one worker: ${Object.entries(WORKERS)
	.map(([name, job]) => `${name} to ${job}`)
	.join("; ")}.
- Write each assignment so it stands alone: the step, the files that matter, what you already know, and how to tell it is done. The worker starts with an empty context and cannot see this conversation.
- Keep assignments small: one step, or one substep. Split a big step first with add_steps under=<id>.
- When a worker returns, read its evidence. If files changed, call verify. Then call step_done with the evidence, or send a follow-up assignment.
- A worker runs while you wait, then its reply comes back as the task result. Two independent investigations can go in one task call as a batch.`;

export function registerLead(
	pi: ExtensionAPI,
	deps: {
		/** Whether the repo config turns lead mode on. */
		repoDefault: () => boolean;
	},
): { on(): boolean; promptBlock(): string | undefined } {
	let override: boolean | undefined; // set by /lead on|off, restored from the session

	function on(): boolean {
		if (override !== undefined) return override;
		if (process.env.OMP_GRAPH_LEAD === "1") return true;
		if (process.env.OMP_GRAPH_LEAD === "0") return false;
		return deps.repoDefault();
	}

	function show(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus("llmg-lead", on() ? "lead mode" : "");
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type?: string; customType?: string; data?: { on?: boolean } };
			if (e.type === "custom" && e.customType === ENTRY_TYPE && typeof e.data?.on === "boolean") override = e.data.on;
		}
		show(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !on() || !WORKER_ONLY.has(event.toolName)) return undefined;
		if (event.toolName === "bash") {
			const cmd = (event.input as { command?: string }).command ?? "";
			if (leadMayRun(cmd)) return undefined;
		}
		return { block: true, reason: blockReason(event.toolName) };
	});

	pi.registerCommand("lead", {
		description: "Lead mode: /lead on, /lead off, or /lead to see whether it is on",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			if (a === "on" || a === "off") {
				override = a === "on";
				pi.appendEntry(ENTRY_TYPE, { on: override });
			}
			show(ctx);
			const msg = on()
				? "Lead mode is on: the agent hands steps to workers and doesn't edit or run commands itself."
				: "Lead mode is off: the agent does the work itself.";
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	return {
		on,
		promptBlock: () => (on() ? LEAD_RULES : undefined),
	};
}
