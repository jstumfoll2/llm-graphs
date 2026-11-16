/**
 * The omp window: the work, one final report pinned above the prompt, and
 * nothing in between.
 *
 *  - report_summary saves a draft. The card is shown only when the agent has
 *    really finished (agent_end with nothing queued). A later report_summary
 *    replaces the card in place: no "v2", no second transcript line.
 *  - The card holds the outcome, the questions for you, and the full paths of
 *    the report and the timeline, each on its own line so a terminal click
 *    (ctrl+click in VS Code) opens them. One short line in the transcript links
 *    the report, once per direction from you.
 *  - Questions are answered in omp's own question dialog (one tab per
 *    question, the recommendation preselected). It opens by itself when the
 *    agent finishes, and again after any later turn while they are still
 *    open; /answer opens it any time. Lines that Firstmate (or any script)
 *    types into the pane while it is open are kept out of it and handed on
 *    (see typing.ts), so they can never answer for you.
 *  - Behind the scenes: the plugin's nudges are hidden, its own bookkeeping
 *    tool calls (report_step, step_done, ...) and advisor notes are not drawn,
 *    and what the agent writes after a nudge, an advisor note or its final
 *    report is not drawn either, until you write again. All of it still reaches
 *    the model, the session and the report. Needs omp's extensionRenderers
 *    settings (see README); OMP_GRAPHS_QUIET=0 shows everything again.
 *  - /jump lists your directions and every report, newest first, and shows
 *    the one you pick in full. timeline.md in the task folder holds the same.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TypingGuard } from "./typing";
import { answersText, type Card, cardLines, type DialogAnswer, dialogQuestions, fold, isOperational, type Question, reportBody, timelineEntry } from "./view";

const FOLD_LINES = Number(process.env.OMP_GRAPHS_FOLD_LINES ?? 30);
const WIDGET = "llmg-final";
const QUIET = process.env.OMP_GRAPHS_QUIET !== "0";
/** Tool calls that only keep the plugin's books; their effect shows in the plan widget and the report. */
export const BOOKKEEPING_TOOLS = new Set(["report_step", "report_summary", "plan_steps", "add_steps", "step_done", "step_blocked", "step_reopen", "lesson_add", "lesson_helped"]);

/** When the question dialog opens: "auto" when the agent finishes, "command" only with /answer, "off" never. */
export function askMode(env: NodeJS.ProcessEnv = process.env): "auto" | "command" | "off" {
	const v = env.OMP_GRAPHS_ASK?.trim().toLowerCase();
	if (v === "auto" || v === "command" || v === "off") return v;
	if (v === "0") return "off";
	// Also inside Firstmate: what it types into the pane is kept out of the dialog (typing.ts).
	return "auto";
}

/** The same questions, in the same order: answering one card answers the other. */
export function sameQuestions(a: Question[], b: Question[]): boolean {
	return a.length === b.length && a.every((q, i) => q.ask.trim() === b[i]!.ask.trim());
}

/** Half-open time ranges in which the agent's text is not drawn. */
export class QuietSpans {
	private spans: { from: number; to?: number }[] = [];
	start(now = Date.now()): void {
		const last = this.spans.at(-1);
		if (last && last.to === undefined) return;
		this.spans.push({ from: now });
		if (this.spans.length > 200) this.spans.splice(0, this.spans.length - 200);
	}
	end(now = Date.now()): void {
		const last = this.spans.at(-1);
		if (last && last.to === undefined) last.to = now;
	}
	open(): boolean {
		return this.spans.at(-1)?.to === undefined && this.spans.length > 0;
	}
	covers(ts: number): boolean {
		return this.spans.some(s => ts >= s.from && (s.to === undefined || ts < s.to));
	}
}

interface Entry {
	kind: "direction" | "report";
	ts: string;
	label: string;
	body: string;
}

export interface ScreenHooks {
	/** report_summary was called: keep it as the draft until the agent is done. */
	draft(d: { title: string; overview: string; questions: Question[]; reportFile: string; dir: string }): string;
	/**
	 * Call from the plugin's agent_end handler (main agent only). When the agent is
	 * really done (nothing queued), the draft is shown.
	 */
	agentEnd(continuing: boolean, ctx: ExtensionContext): void;
	/** The plugin sent the agent a hidden nudge: what it writes next is not drawn. */
	nudged(): void;
	/** A final report was drafted since your last message. */
	summarized(): boolean;
	/** Clear the pinned card. */
	hide(ctx: ExtensionContext): void;
	/** Path of timeline.md for a task folder. */
	timelineFile(dir: string): string;
}

export const SCREEN_RULES = `## Talking to the user (llm-graphs)
- While you work, keep chat replies to one or two plain sentences. Never write a summary, status report or list of corrections in chat.
- When the task is done or blocked, call report_summary once with the complete final report. It is shown to the user pinned above the prompt; do not repeat it in chat.
- If an advisor note or a check sends you back to work after report_summary, fix it, then call report_summary again with the complete corrected report. It replaces the earlier one. Do not describe the correction in chat.
- Anything you need from the user goes in report_summary "questions": one decision per question, ending in "?", with the options and your recommendation. The user answers them in a question dialog. Ask for the decision itself ("Merge MR !42 now?"), not around it ("Let me know if you'd like..."). Do not use the ask tool for these.`;

export function registerScreen(
	pi: ExtensionAPI,
	deps: {
		dir: () => string | undefined;
		firstmateWorker: () => boolean;
		/** A Firstmate notice typed while the dialog was open: true if it was handed on. */
		notice?: (text: string, ctx: ExtensionContext) => boolean;
	},
): ScreenHooks {
	let ui: ExtensionContext | undefined;
	let draft: (Card & { dir: string }) | undefined;
	let shown: (Card & { at: number }) | undefined;
	let linked = false; // the transcript already has a report line since your last message
	let summarizedSinceInput = false;
	let asking = false;
	/** The card's questions should open in the dialog as soon as the agent is idle. */
	let askPending = false;
	const quiet = new QuietSpans();
	const entries: Entry[] = [];
	const mode = () => (deps.firstmateWorker() ? "off" : askMode());

	const timelineFile = (dir: string) => path.join(dir, "timeline.md");

	function append(dir: string, e: Entry): void {
		entries.push(e);
		try {
			fs.appendFileSync(timelineFile(dir), timelineEntry(e.kind, e.ts, e.body));
		} catch {}
	}

	function paint(): void {
		if (!ui?.hasUI) return;
		if (!shown) return ui.ui.setWidget(WIDGET, undefined);
		const lines = cardLines(shown);
		// A component, not a string list: string widgets are cut at 10 lines, and the paths must stay whole.
		ui.ui.setWidget(WIDGET, (_tui, theme) => linesComponent(lines, theme), { placement: "aboveEditor" });
	}

	function answerHint(): string | undefined {
		const m = mode();
		if (m === "off") return "Answer by writing back, e.g. \"Q1 yes\".";
		if (m === "auto") return "Esc keeps them here; /answer opens them again.";
		return "/answer opens these one at a time.";
	}

	/** Your next message, or the dialog's answers: the agent is working for you again. */
	function userSpoke(): void {
		quiet.end();
		linked = false;
		summarizedSinceInput = false;
		askPending = false; // you wrote back instead: the agent's next report asks again if it still needs to
	}

	/** A line typed into the pane while the dialog was open: on to the agent, as if typed at the prompt. */
	function typedLine(text: string, ctx: ExtensionContext): void {
		if (deps.notice?.(text, ctx)) return;
		void pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	/** While the dialog is open, typed-in lines (Firstmate's notices) go around it, not into it. */
	function guardTyping(ctx: ExtensionContext): () => void {
		const listen = (ctx.ui as { onTerminalInput?: (h: (d: string) => { consume?: boolean } | undefined) => () => void }).onTerminalInput;
		if (typeof listen !== "function") return () => {};
		const guard = new TypingGuard();
		const timer = setInterval(() => {
			const line = guard.tick();
			if (line) typedLine(line, ctx);
		}, 250);
		let off: () => void = () => {};
		try {
			off = listen.call(ctx.ui, data => {
				const r = guard.feed(data);
				if (r.line) typedLine(r.line, ctx);
				return r.consume ? { consume: true } : undefined;
			});
		} catch {}
		return () => {
			clearInterval(timer);
			off();
			// A line still being typed when the dialog closed: what came before its Enter is handed on.
			const rest = guard.tick(Number.POSITIVE_INFINITY);
			if (rest) typedLine(rest, ctx);
		};
	}

	async function ask(ctx: ExtensionContext): Promise<void> {
		const card = shown;
		if (!card?.questions.length || asking) return;
		const dialog = (ctx.ui as { askDialog?: (q: unknown[], o?: unknown) => Promise<unknown> }).askDialog;
		if (!ctx.hasUI || typeof dialog !== "function") {
			ctx.hasUI && ctx.ui.notify("This omp has no question dialog; answer by writing back.", "warning");
			return;
		}
		asking = true;
		askPending = false;
		const unguard = guardTyping(ctx);
		try {
			const r = (await dialog.call(ctx.ui, dialogQuestions(card.questions))) as { kind?: string; results?: DialogAnswer[] } | undefined;
			if (r?.kind !== "submit" || !r.results) return; // cancelled, or "chat about it": the card keeps the questions
			const text = answersText(card.questions, r.results);
			userSpoke();
			// A report that came in meanwhile with the same questions is answered too; one with new ones keeps them.
			const now = shown;
			if (now && (now === card || sameQuestions(now.questions, card.questions))) {
				shown = { ...now, questions: [], answerHint: undefined };
				paint();
			}
			await pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		} catch {
			// display only: the questions stay on the card
		} finally {
			unguard();
			asking = false;
		}
	}

	function whenIdle(ctx: ExtensionContext, fn: () => void, tries = 0): void {
		if (ctx.isIdle()) return fn();
		if (tries < 100) setTimeout(() => whenIdle(ctx, fn, tries + 1), 100);
	}

	/** Open the dialog once the agent is idle; if another turn started first, its end tries again. */
	function askWhenIdle(ctx: ExtensionContext): void {
		const card = shown;
		setTimeout(
			() =>
				whenIdle(ctx, () => {
					if (askPending && shown === card && card?.questions.length) void ask(ctx);
				}),
			50,
		);
	}

	function publish(ctx: ExtensionContext): void {
		if (!draft) return;
		const d = draft;
		draft = undefined;
		const card = { ...d, answerHint: d.questions.length ? answerHint() : undefined, dialog: mode() !== "off", at: Date.now() };
		shown = card;
		askPending = card.questions.length > 0 && mode() === "auto";
		ui = ctx;
		append(d.dir, { kind: "report", ts: new Date().toISOString(), label: `Final report: ${d.title}`, body: reportBody(d) });
		paint();
		// One short, findable line in the transcript per direction from you; a revised report is
		// the same file and only redraws the card. Sent once the session is idle: sent earlier it
		// would be queued as a follow-up and start another turn.
		const needLine = !linked;
		linked = true;
		if (needLine)
			setTimeout(
				() =>
					whenIdle(ctx, () => {
						if (shown !== card) return;
						const line = `Final report: ${d.title}. ${d.questions.length ? `${d.questions.length} question(s) for you. ` : ""}${d.reportFile}`;
						pi.sendMessage({ customType: "llmg-final", content: line, display: true }, { triggerTurn: false });
					}),
				50,
			);
		if (askPending) askWhenIdle(ctx);
	}

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent?.kind !== "sub") ui = ctx;
	});

	// You wrote something: the agent's replies are drawn again.
	pi.on("input", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension") return undefined;
		const text = (event.text ?? "").trim();
		if (!text || isOperational(text)) return undefined;
		userSpoke();
		return undefined;
	});

	// Your directions, for /jump and the timeline. Firstmate's own notices and slash commands are not.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return undefined;
		ui = ctx;
		const text = (event.prompt ?? "").trim();
		if (!text || text.startsWith("/") || isOperational(text)) return undefined;
		pending.push({ ts: new Date().toISOString(), text });
		return undefined;
	});
	const pending: { ts: string; text: string }[] = []; // directions waiting for a task folder

	function flush(dir: string | undefined): void {
		if (!dir) return;
		for (const p of pending.splice(0)) append(dir, { kind: "direction", ts: p.ts, label: p.text.split("\n")[0]!.slice(0, 100), body: p.text });
	}

	// An advisor note: what the agent writes in answer to it is not drawn. After the final
	// report, the agent's fix arrives as a new report_summary that replaces the card.
	pi.on("message_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const m = event.message as { role?: string; customType?: string };
		if (m.role === "custom" && m.customType === "advisor") quiet.start();
	});

	// The transcript line: one row, not a boxed card.
	pi.registerMessageRenderer("llmg-final", (message, _opts, theme) => {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return linesComponent([`■ ${text}`], theme, "accent");
	});

	// Bookkeeping tool calls and advisor notes: not drawn. Needs extensionRenderers.transcriptPresenters.
	try {
		pi.registerTranscriptPresenter?.(block => {
			if (!QUIET) return undefined;
			if (block.type === "toolCall") return BOOKKEEPING_TOOLS.has(block.toolName) ? "hidden" : undefined;
			if (block.type !== "message") return undefined;
			const m = block.message as { customType?: string };
			return m.customType === "advisor" ? "hidden" : undefined;
		});
	} catch {}

	// The agent's text behind the scenes is not drawn; long finished replies show their first
	// lines only. Needs extensionRenderers.assistantText.
	try {
		pi.registerAssistantTextRenderer?.(c => {
			if (QUIET && quiet.covers(c.message.timestamp ?? 0)) return "";
			return c.streaming ? undefined : fold(c.text, FOLD_LINES);
		});
	} catch {}

	pi.registerCommand("answer", {
		description: "Answer the final report's questions in the question dialog",
		handler: async (_args, ctx) => {
			if (!shown?.questions.length) return ctx.hasUI ? ctx.ui.notify("No open questions.", "info") : console.log("No open questions.");
			await ask(ctx);
		},
	});

	pi.registerCommand("jump", {
		description: "Go back to one of your directions or an earlier report, newest first",
		handler: async (_args, ctx) => {
			if (!entries.length) return ctx.hasUI ? ctx.ui.notify("Nothing to jump to yet.", "info") : console.log("Nothing to jump to yet.");
			const list = [...entries].reverse();
			const seen = new Map<string, number>();
			const labels = list.map(e => {
				const base = `${e.kind === "direction" ? "You" : "Report"} · ${e.ts.slice(11, 16)} · ${e.label}`.slice(0, 120);
				const n = (seen.get(base) ?? 0) + 1;
				seen.set(base, n);
				return n > 1 ? `${base} (${n})` : base;
			});
			if (!ctx.hasUI) return console.log(labels.join("\n"));
			const pick = await ctx.ui.select("Jump to (newest first)", labels);
			const e = pick === undefined ? undefined : list[labels.indexOf(pick)];
			if (!e) return;
			await ctx.ui.editor(`${e.kind === "direction" ? "Your direction" : "Report"} from ${e.ts.slice(0, 16).replace("T", " ")} (Esc to close)`, e.body);
		},
	});

	return {
		agentEnd(continuing, ctx) {
			flush(deps.dir());
			if (continuing) return;
			if (draft) publish(ctx);
			// The dialog did not get to open (another turn, e.g. a Firstmate notice, started first).
			else if (askPending && !asking) askWhenIdle(ctx);
		},
		draft(d) {
			draft = { title: d.title, overview: d.overview, questions: d.questions, reportFile: d.reportFile, timelineFile: timelineFile(d.dir), dir: d.dir };
			summarizedSinceInput = true;
			quiet.start(); // the report speaks for the agent now
			flush(d.dir); // directions that arrived before the task folder existed
			return "It will be shown pinned above the prompt when you finish this turn. Do not repeat it in chat.";
		},
		nudged() {
			quiet.start();
		},
		summarized: () => summarizedSinceInput,
		hide(ctx) {
			shown = undefined;
			ui = ctx;
			paint();
		},
		timelineFile,
	};
}

type Theme = { fg?: (color: string, text: string) => string };

/** A plain widget: each line wrapped to the width, never cut. */
function linesComponent(lines: string[], theme: unknown, color?: string): { render(width: number): string[]; invalidate(): void } {
	const t = theme as Theme;
	const paintLine = (l: string) => {
		const c = color ?? (l.startsWith("━━") ? "accent" : l.startsWith("NEEDS YOU") || /^Q\d+\./.test(l) ? "warning" : l.startsWith("…") ? "muted" : undefined);
		return c && t.fg ? t.fg(c, l) : l;
	};
	let cache: { width: number; rows: string[] } | undefined;
	return {
		render(width: number) {
			if (cache?.width === width) return cache.rows;
			const w = Math.max(10, width - 2);
			const rows: string[] = [];
			for (const l of lines) for (const piece of wrap(l, w)) rows.push(` ${paintLine(piece)}`);
			cache = { width, rows };
			return rows;
		},
		invalidate() {
			cache = undefined;
		},
	};
}

/** Word wrap; a single token longer than the width (a long path) is split, never dropped. */
export function wrap(line: string, width: number): string[] {
	if (line.length <= width) return [line];
	const out: string[] = [];
	let cur = "";
	for (const word of line.split(" ")) {
		if (word.length > width) {
			if (cur) out.push(cur), (cur = "");
			for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
			continue;
		}
		if (!cur) cur = word;
		else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
		else out.push(cur), (cur = word);
	}
	if (cur) out.push(cur);
	return out.length ? out : [""];
}
