/**
 * Step graph wiring for OMP: tools the model uses to move through the plan,
 * the /ask and /plan commands, the advisor gate, and the stall check.
 * The plan itself lives in plan.json in the task folder (see plan.ts).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskStore } from "../report/store";
import {
	active,
	addSteps,
	blockStep,
	finishStep,
	gateAdvisor,
	loadPlan,
	type Plan,
	type PlanStep,
	planLines,
	planText,
	remaining,
	reopenStep,
	savePlan,
	setPlan,
} from "./plan";

const MAX_NUDGES = Number(process.env.OMP_GRAPH_MAX_NUDGES ?? 3); // nudges without progress before telling you
const ADVISOR_PER_STEP = Number(process.env.OMP_GRAPH_ADVISOR_PER_STEP ?? 1); // advisor notes the model sees per step
const HIDE_TODO = process.env.OMP_GRAPH_KEEP_TODO !== "1"; // one list, not two

export interface GraphHooks {
	/** Text added to the system prompt: the rules plus where the task is now. */
	promptBlock(): string;
	/** Nudge text when the agent stopped with steps left, or undefined. */
	nudge(lastAssistantText: string, ctx: ExtensionContext): string | undefined;
	/** Current plan, for the report. */
	plan(): Plan | undefined;
}

const RULES = `## Step list (llm-graphs)
- For any task with more than one step, first call plan_steps with the steps in order. Include steps for writing tests, running them, and reporting.
- Work on the active step only. When it is finished, call step_done with evidence: what you ran or checked and what it showed.
- Found extra work? Call add_steps; it is added after the existing steps. Never drop a step the user asked for.
- A step too big to do in one go? Call add_steps with under=<its id> to split it into substeps. They run first, then you close the step itself with step_done.
- If a step cannot be done, call step_blocked with a one-sentence reason and move on. When the blocker is cleared (for example the user answered), call step_reopen to pick it back up.
- Do not use a separate todo list; this step list is the todo list.`;

export function registerGraph(
	pi: ExtensionAPI,
	deps: {
		getStore: () => TaskStore | undefined;
		ensureTask: (ctx: ExtensionContext, title: string) => Promise<TaskStore>;
		/** Error text when the active step may not finish yet (e.g. verify not passed). */
		gate?: () => string | undefined;
		/** Called after every saved change to the plan. */
		onChange?: () => void;
		/** No step can go on (nothing active, some blocked). Returns extra text for the model. */
		onStuck?: (plan: Plan) => string | undefined;
	},
): GraphHooks {
	const z = pi.zod;
	let cache: { dir: string; plan: Plan } | undefined;

	function plan(): Plan | undefined {
		const store = deps.getStore();
		if (!store) return undefined;
		if (cache?.dir !== store.dir) cache = { dir: store.dir, plan: loadPlan(store.dir) };
		return cache.plan;
	}

	function save(ctx?: ExtensionContext): void {
		const store = deps.getStore();
		if (store && cache?.dir === store.dir) savePlan(store.dir, cache.plan);
		deps.onChange?.();
		if (ctx) showPlan(ctx);
	}

	function showPlan(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const p = plan();
		if (!p?.steps.length) {
			ctx.ui.setWidget("llmg-plan", []);
			return;
		}
		const left = remaining(p).length;
		ctx.ui.setWidget("llmg-plan", [`Plan: ${p.steps.length - left}/${p.steps.length} done${p.inbox.length ? ` · ${p.inbox.length} ask(s) queued` : ""}`, ...planLines(p, 8)]);
		const cur = active(p);
		ctx.ui.setStatus("llmg-step", cur ? `step ${cur.id}/${p.steps.length}` : "steps done");
	}

	function describeNext(next: PlanStep | undefined, fromInbox: PlanStep[]): string {
		const parts: string[] = [];
		if (fromInbox.length) parts.push(`Added from the user's queued asks: ${fromInbox.map(s => `${s.id}. ${s.title}`).join("; ")}.`);
		const p = plan();
		const blocked = p?.steps.filter(s => s.status === "blocked").length ?? 0;
		if (next) parts.push(`Next active step: ${next.id}. ${next.title}`);
		else if (blocked && p) {
			parts.push(`No step can go on: ${blocked} blocked. Call report_summary with what needs the user.`);
			const extra = deps.onStuck?.(p);
			if (extra) parts.push(extra);
		} else parts.push("All steps are finished. Call report_summary.");
		return parts.join(" ");
	}

	// ---------- tools ----------

	pi.registerTool({
		name: "plan_steps",
		label: "Plan steps",
		loadMode: "essential",
		approval: "read",
		description: "Set the ordered step list for this task, once, before starting work. 2 to 20 short steps.",
		parameters: z.object({ steps: z.array(z.string()).describe("Steps in order, each a short imperative, e.g. 'Write a test for the gain lookup'") }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await deps.ensureTask(ctx, params.steps[0] ?? "Untitled task");
			const p = plan()!;
			const r = setPlan(p, params.steps);
			if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
			save(ctx);
			return { content: [{ type: "text", text: `Plan set with ${r.added!.length} steps. Active step: ${active(p)!.id}. ${active(p)!.title}` }] };
		},
	});

	pi.registerTool({
		name: "add_steps",
		label: "Add steps",
		loadMode: "essential",
		approval: "read",
		description:
			"Add steps you discovered, at most 20 per call. Without `under` they go after all existing steps. With `under`, they become substeps of that step: they run first, and that step can't be closed until they are. Nothing is removed or reordered.",
		parameters: z.object({
			steps: z.array(z.string()),
			why: z.string().describe("One sentence: why these steps are needed"),
			under: z.number().int().optional().describe("Id of an open top-level step to split into these substeps"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await deps.ensureTask(ctx, params.steps[0] ?? "Untitled task");
			const p = plan()!;
			const r = addSteps(p, params.steps, "added", params.under);
			if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
			save(ctx);
			const cur = active(p);
			const where = params.under !== undefined ? ` as substeps of step ${params.under}` : "";
			return { content: [{ type: "text", text: `Added steps ${r.added.map(s => s.id).join(", ")}${where}. Active step: ${cur ? `${cur.id}. ${cur.title}` : "none"}.` }] };
		},
	});

	pi.registerTool({
		name: "step_done",
		label: "Step done",
		loadMode: "essential",
		approval: "read",
		description: "Finish the active step. Evidence is required: the command you ran and its result, or what you checked and found.",
		parameters: z.object({ id: z.number().int(), evidence: z.string() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = plan();
			if (!p?.steps.length) return { isError: true, content: [{ type: "text", text: "No plan yet. Call plan_steps first." }] };
			const blocked = active(p)?.id === params.id ? deps.gate?.() : undefined;
			if (blocked) return { isError: true, content: [{ type: "text", text: blocked }] };
			const r = finishStep(p, params.id, params.evidence);
			if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
			save(ctx);
			return { content: [{ type: "text", text: `Step ${params.id} done. ${describeNext(r.next, r.fromInbox)}` }] };
		},
	});

	pi.registerTool({
		name: "step_blocked",
		label: "Step blocked",
		loadMode: "essential",
		approval: "read",
		description: "Mark the active step as blocked with a one-sentence reason, and move to the next step.",
		parameters: z.object({ id: z.number().int(), reason: z.string() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = plan();
			if (!p?.steps.length) return { isError: true, content: [{ type: "text", text: "No plan yet." }] };
			const r = blockStep(p, params.id, params.reason);
			if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
			save(ctx);
			return { content: [{ type: "text", text: `Step ${params.id} blocked. ${describeNext(r.next, r.fromInbox)}` }] };
		},
	});

	pi.registerTool({
		name: "step_reopen",
		label: "Reopen step",
		loadMode: "essential",
		approval: "read",
		description:
			"Reopen a blocked step once its blocker is cleared. It becomes the active step now; the step that was active waits and comes back after it.",
		parameters: z.object({ id: z.number().int(), note: z.string().describe("One sentence: what cleared the blocker") }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = plan();
			if (!p?.steps.length) return { isError: true, content: [{ type: "text", text: "No plan yet." }] };
			const r = reopenStep(p, params.id, params.note);
			if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
			save(ctx);
			const paused = r.paused ? ` Step ${r.paused.id} (${r.paused.title}) is paused and comes back after it.` : "";
			return { content: [{ type: "text", text: `Step ${params.id} reopened and active: ${r.step!.title}.${paused}` }] };
		},
	});

	// ---------- commands ----------

	pi.registerCommand("ask", {
		description: "Queue a new ask. It joins the plan at the next step boundary, after the existing steps.",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			if (!text) return ctx.hasUI ? ctx.ui.notify("Usage: /ask <what you want added>", "warning") : undefined;
			await deps.ensureTask(ctx, text);
			const p = plan()!;
			if (!p.steps.length) {
				// nothing running yet: it is simply the first step of a new plan
				addSteps(p, [text], "inbox");
			} else {
				p.inbox.push(text);
			}
			save(ctx);
			if (ctx.hasUI) ctx.ui.notify(p.inbox.length ? "Queued. It will be added after the current step." : "Added to the plan.", "info");
		},
	});

	pi.registerCommand("plan", {
		description: "Show the whole step list. `/plan file` prints where plan.md is; `/plan reopen <id> <what cleared it>` reopens a blocked step.",
		handler: async (args, ctx) => {
			const m = (args ?? "").trim().match(/^reopen\s+(\d+)\s*(.*)$/s);
			if (m) {
				const p = plan();
				const r = p ? reopenStep(p, Number(m[1]), m[2] || "Reopened by the user from /plan.") : { error: "No plan yet." };
				if (!r.error) save(ctx);
				const msg = r.error ?? `Step ${m[1]} reopened and active.`;
				if (ctx.hasUI) ctx.ui.notify(msg, r.error ? "warning" : "info");
				else console.log(msg);
				return;
			}
			const p = plan();
			if ((args ?? "").trim() === "file") {
				const store = deps.getStore();
				const msg = store ? `${store.dir}/plan.md (rewritten on every change; open it from any shell)` : "No task yet.";
				return ctx.hasUI ? ctx.ui.notify(msg, "info") : console.log(msg);
			}
			const text = p ? planText(p) : "No plan yet.";
			if (ctx.hasUI) {
				showPlan(ctx);
				await ctx.ui.editor("Step list, all steps (Esc to close)", text);
			} else {
				console.log(text);
			}
		},
	});

	// ---------- hooks ----------

	pi.on("session_start", async (_event, ctx) => {
		showPlan(ctx);
	});

	// One list, not two: calls to OMP's own todo tool are refused with a pointer
	// to the step list, and subagents may not move the lead's plan. (Blocking
	// calls instead of setActiveTools, which stops print mode from exiting in
	// OMP 18.18.)
	const PLAN_TOOLS = new Set(["plan_steps", "add_steps", "step_done", "step_blocked", "step_reopen"]);
	pi.on("tool_call", async (event, ctx) => {
		if (HIDE_TODO && event.toolName === "todo" && ctx.agent?.kind !== "sub" && ctx.agent?.id !== "advisor") {
			return { block: true, reason: "Use the step list instead: plan_steps, add_steps, step_done, step_blocked, step_reopen." };
		}
		if (PLAN_TOOLS.has(event.toolName) && ctx.agent?.kind === "sub") {
			return { block: true, reason: "Only the lead agent moves the step list. Finish your assignment and report back." };
		}
		return undefined;
	});

	// Advisor gate: the first advisor note per step reaches the model; later ones
	// are replaced by a one-line placeholder and kept for the report.
	pi.on("context", async event => {
		const p = plan();
		if (!p?.steps.length) return undefined;
		let changed = false;
		const messages = event.messages.map(m => {
			const msg = m as { role?: string; customType?: string; timestamp?: number; content?: unknown };
			if (msg.role !== "custom" || msg.customType !== "advisor" || typeof msg.timestamp !== "number") return m;
			const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			const before = p.advisor.length;
			const allowed = gateAdvisor(p, msg.timestamp, text, ADVISOR_PER_STEP);
			if (p.advisor.length !== before) changed = true;
			if (allowed) return m;
			return { ...msg, content: "[Advisor note held for the report. Finish the active step first.]" } as typeof m;
		});
		if (changed) save();
		return { messages };
	});

	return {
		promptBlock() {
			const p = plan();
			if (!p?.steps.length) return RULES;
			const cur = active(p);
			const queued = p.inbox.length ? `\nQueued asks (added after the current step): ${p.inbox.length}` : "";
			return `${RULES}\n\n### Current plan\n${planLines(p).join("\n")}\nActive step: ${cur ? `${cur.id}. ${cur.title}` : "none"}${queued}`;
		},
		nudge(lastText, ctx) {
			const p = plan();
			if (!p?.steps.length) return undefined;
			const cur = active(p);
			if (!cur) return undefined; // all done or blocked
			if (/\?\s*$/.test(lastText.trim())) return undefined; // it asked you something; wait for you
			if (p.nudges >= MAX_NUDGES) {
				if (p.nudges === MAX_NUDGES) {
					p.nudges++;
					save();
					if (ctx.hasUI) ctx.ui.notify(`Stalled on step ${cur.id} (${cur.title}) after ${MAX_NUDGES} nudges.`, "warning");
				}
				return undefined;
			}
			p.nudges++;
			save();
			return `Step ${cur.id} (${cur.title}) is still open and ${remaining(p).length} step(s) remain. Continue it now. If it is finished, call step_done with evidence; if you cannot finish it, call step_blocked with the reason.`;
		},
		plan,
	};
}
