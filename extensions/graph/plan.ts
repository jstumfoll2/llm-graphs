/**
 * The task's step list (the "graph"). Pure logic plus load/save of plan.json.
 *
 * Rules, following the Structured Graph Harness idea (arXiv:2604.11378):
 *  - Steps are only ever added. Nothing is removed or reordered, so a
 *    later ask can never push out part 2 of the original one.
 *  - A step can be split into substeps, one level deep. They sit under it
 *    and run before it; the parent can't be closed while one is still open.
 *  - Exactly one step is active at a time. It finishes only with evidence.
 *  - A blocked step can be reopened once the blocker is cleared.
 *  - New asks wait in the inbox and join the plan at the next step boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type StepStatus = "pending" | "active" | "done" | "blocked";

export interface PlanStep {
	id: number;
	title: string;
	status: StepStatus;
	source: "plan" | "added" | "inbox";
	version: number; // plan version that added this step
	parent?: number; // set on a substep: the step it was split from
	evidence?: string;
	reason?: string;
	finishedAt?: string;
	reopenedAt?: string; // last time it was reopened after a block
	history?: { ts: string; event: "blocked" | "reopened"; text: string }[];
}

export interface AdvisorNote {
	ts: number; // message timestamp, used as its identity
	step: number; // step that was active when it arrived
	allowed: boolean; // false = held back from the model
	text: string;
}

export interface Plan {
	version: number;
	steps: PlanStep[];
	inbox: string[];
	advisor: AdvisorNote[];
	nudges: number; // nudges sent since the last finished step
}

export function emptyPlan(): Plan {
	return { version: 0, steps: [], inbox: [], advisor: [], nudges: 0 };
}

export function loadPlan(dir: string): Plan {
	const p = path.join(dir, "plan.json");
	if (!fs.existsSync(p)) return emptyPlan();
	try {
		return { ...emptyPlan(), ...(JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Plan>) };
	} catch {
		return emptyPlan();
	}
}

export function savePlan(dir: string, plan: Plan): void {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, "plan.json");
	fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(plan, null, 2)}\n`);
	fs.renameSync(`${p}.tmp`, p); // atomic, so a crash never leaves half a plan
}

export const MAX_TITLE = 300;
export const MAX_PER_CALL = 20;

function clean(titles: string[]): string[] {
	return titles.map(t => t.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE)).filter(Boolean);
}

function isOpen(s: PlanStep): boolean {
	return s.status === "pending" || s.status === "active";
}

export function children(plan: Plan, id: number): PlanStep[] {
	return plan.steps.filter(s => s.parent === id);
}

export function active(plan: Plan): PlanStep | undefined {
	return plan.steps.find(s => s.status === "active");
}

export function remaining(plan: Plan): PlanStep[] {
	return plan.steps.filter(s => s.status === "pending" || s.status === "active");
}

/**
 * Make the next step active if none is. Steps run in list order, except that
 * a step with open substeps waits until they are closed (substeps sit right
 * under their parent, so the parent comes up next once they are).
 */
export function advance(plan: Plan): PlanStep | undefined {
	const cur = active(plan);
	if (cur) return cur;
	const next = plan.steps.find(s => s.status === "pending" && !children(plan, s.id).some(isOpen));
	if (next) next.status = "active";
	return next;
}

function insert(plan: Plan, titles: string[], source: PlanStep["source"], parent?: number): PlanStep[] {
	plan.version++;
	let id = plan.steps.reduce((m, s) => Math.max(m, s.id), 0);
	const added: PlanStep[] = titles.map(title => ({ id: ++id, title, status: "pending" as const, source, version: plan.version, ...(parent ? { parent } : {}) }));
	if (parent === undefined) {
		plan.steps.push(...added);
	} else {
		// after the parent and any substeps it already has
		let at = plan.steps.findIndex(s => s.id === parent) + 1;
		while (at < plan.steps.length && plan.steps[at]!.parent === parent) at++;
		plan.steps.splice(at, 0, ...added);
	}
	return added;
}

/** First plan for the task. Refused once a plan exists, so it can't be rewritten. */
export function setPlan(plan: Plan, titles: string[]): { error?: string; added?: PlanStep[] } {
	const list = clean(titles);
	if (plan.steps.length) return { error: "A plan already exists. Use add_steps to append steps after the current ones." };
	if (list.length < 2 || list.length > 20) return { error: `Give 2 to 20 steps, got ${list.length}.` };
	const added = insert(plan, list, "plan");
	advance(plan);
	return { added };
}

/**
 * Add steps found along the way. Without `under` they go after every
 * existing step. With `under` they become substeps of that step: they sit
 * under it, run before it, and it can't be closed until they are. Nothing
 * existing is moved or removed either way.
 */
export function addSteps(
	plan: Plan,
	titles: string[],
	source: "added" | "inbox" = "added",
	under?: number,
): { error?: string; added: PlanStep[] } {
	const list = clean(titles);
	if (!list.length) return { error: "Give at least one step.", added: [] };
	if (list.length > MAX_PER_CALL) return { error: `Give at most ${MAX_PER_CALL} steps per call, got ${list.length}.`, added: [] };
	if (under !== undefined) {
		const parent = plan.steps.find(s => s.id === under);
		if (!parent) return { error: `There is no step ${under}.`, added: [] };
		if (parent.parent !== undefined) return { error: `Step ${under} is already a substep of ${parent.parent}. Substeps go one level deep; add them under ${parent.parent} instead.`, added: [] };
		if (!isOpen(parent)) return { error: `Step ${under} is ${parent.status}. Only an open step can be split; reopen it first if it was blocked.`, added: [] };
		if (parent.status === "active") parent.status = "pending"; // its first substep takes over
	}
	const added = insert(plan, list, source, under);
	advance(plan);
	return { added };
}

/** Move queued asks into the plan. Called only at a step boundary. */
export function drainInbox(plan: Plan): PlanStep[] {
	if (!plan.inbox.length) return [];
	const asks = plan.inbox.splice(0);
	const out: PlanStep[] = [];
	for (let i = 0; i < asks.length; i += MAX_PER_CALL) out.push(...addSteps(plan, asks.slice(i, i + MAX_PER_CALL), "inbox").added);
	return out;
}

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface FinishResult {
	error?: string;
	next?: PlanStep;
	fromInbox: PlanStep[];
}

/** Finish the active step. Needs evidence: test output, a diff summary, or what was checked. */
export function finishStep(plan: Plan, id: number, evidence: string, now = new Date().toISOString()): FinishResult {
	const cur = active(plan);
	if (!cur) return { error: "No step is active.", fromInbox: [] };
	if (cur.id !== id) return { error: `Step ${id} is not the active step. The active step is ${cur.id}: ${cur.title}.`, fromInbox: [] };
	const open = children(plan, id).filter(isOpen);
	if (open.length) return { error: `Step ${id} still has open substeps: ${open.map(s => s.id).join(", ")}. Finish or block them first.`, fromInbox: [] };
	if (wordCount(evidence) < 8) {
		return {
			error: "Evidence is too thin. Say what you checked and what it showed, for example the test command and its result, or the files changed and why.",
			fromInbox: [],
		};
	}
	cur.status = "done";
	cur.evidence = evidence.trim();
	cur.finishedAt = now;
	plan.nudges = 0;
	const fromInbox = drainInbox(plan);
	return { next: advance(plan), fromInbox };
}

/** Mark the active step blocked and move on. The reason goes to the report. */
export function blockStep(plan: Plan, id: number, reason: string, now = new Date().toISOString()): FinishResult {
	const cur = active(plan);
	if (!cur || cur.id !== id) return { error: `Step ${id} is not the active step.`, fromInbox: [] };
	if (wordCount(reason) < 4) return { error: "Give a one-sentence reason.", fromInbox: [] };
	cur.status = "blocked";
	cur.reason = reason.trim();
	cur.finishedAt = now;
	(cur.history ??= []).push({ ts: now, event: "blocked", text: cur.reason });
	plan.nudges = 0;
	const fromInbox = drainInbox(plan);
	return { next: advance(plan), fromInbox };
}

/**
 * Reopen a blocked step once its blocker is cleared. It becomes the active
 * step right away; whatever step was active goes back to waiting, untouched.
 * The block and the reopen stay in the step's history for the report.
 */
export function reopenStep(plan: Plan, id: number, note: string, now = new Date().toISOString()): { error?: string; step?: PlanStep; paused?: PlanStep } {
	const step = plan.steps.find(s => s.id === id);
	if (!step) return { error: `There is no step ${id}.` };
	if (step.status !== "blocked") return { error: `Step ${id} is ${step.status}, not blocked. Only a blocked step can be reopened.` };
	if (wordCount(note) < 4) return { error: "Say in one sentence what cleared the blocker." };
	const paused = active(plan);
	if (paused) paused.status = "pending";
	if (step.parent !== undefined) {
		// a closed parent has to wait for this substep again
		const parent = plan.steps.find(s => s.id === step.parent);
		if (parent && !isOpen(parent)) {
			(parent.history ??= []).push({ ts: now, event: "reopened", text: `substep ${id} reopened` });
			parent.status = "pending";
			parent.finishedAt = undefined;
		}
	}
	(step.history ??= []).push({ ts: now, event: "reopened", text: note.trim() });
	step.status = "active";
	step.reason = undefined;
	step.finishedAt = undefined;
	step.reopenedAt = now;
	plan.nudges = 0;
	return { step, paused };
}

/**
 * Decide which advisor notes the model sees. The first note during a step is
 * passed through; later ones in the same step are held back and listed in the
 * report, which ends the advisor/agent back-and-forth loop.
 */
export function gateAdvisor(plan: Plan, ts: number, text: string, maxPerStep: number): boolean {
	const known = plan.advisor.find(a => a.ts === ts);
	if (known) return known.allowed;
	const step = active(plan)?.id ?? 0;
	const seen = plan.advisor.filter(a => a.step === step && a.allowed).length;
	const allowed = step === 0 || seen < maxPerStep;
	plan.advisor.push({ ts, step, allowed, text: text.slice(0, 2000) });
	return allowed;
}

/** Short view of where the task is, for the system prompt and the widget. */
export function planLines(plan: Plan, maxLines = 12): string[] {
	const mark: Record<StepStatus, string> = { done: "[x]", active: "[>]", pending: "[ ]", blocked: "[!]" };
	const lines = plan.steps.map(
		s => `${s.parent !== undefined ? "    " : ""}${mark[s.status]} ${s.id}. ${s.title}${s.source === "inbox" ? " (your ask)" : ""}${s.parent !== undefined ? ` (part of ${s.parent})` : ""}`,
	);
	if (lines.length <= maxLines) return lines;
	// keep the active step in view: drop the oldest finished steps first
	const firstOpen = plan.steps.findIndex(s => s.status === "active" || s.status === "pending");
	const start = Math.max(0, Math.min(firstOpen - 2, lines.length - maxLines));
	return [`... ${start} earlier steps`, ...lines.slice(start, start + maxLines - 1)];
}
