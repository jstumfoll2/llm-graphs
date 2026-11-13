/**
 * The omp window: one final report, pinned above the prompt.
 *
 *  - report_summary saves a draft. The card is shown only when the agent has
 *    really finished (agent_end with nothing queued), so an advisor review
 *    that sends the agent back to work is folded into the report instead of
 *    producing a second one. A later report_summary replaces the card.
 *  - The card holds the outcome, the questions for you, and the full paths of
 *    the report and the timeline, each on its own line so a terminal click
 *    (ctrl+click in VS Code) opens them.
 *  - Advisor cards in the transcript are drawn as one row, and long finished
 *    replies are folded to their first lines (display only; both need omp's
 *    extensionRenderers settings, see README).
 *  - /jump lists your directions and every report, newest first, and shows
 *    the one you pick in full. timeline.md in the task folder holds the same.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Card, cardLines, fold, isOperational, type Question, reportBody, timelineEntry } from "./view";

const FOLD_LINES = Number(process.env.OMP_GRAPHS_FOLD_LINES ?? 30);
const WIDGET = "llmg-final";

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
	 * really done (nothing queued), the draft is shown. An advisor review that sends
	 * it back to work comes before that, so it is folded into the same report.
	 */
	agentEnd(continuing: boolean, ctx: ExtensionContext): void;
	/** Clear the pinned card. */
	hide(ctx: ExtensionContext): void;
	/** Path of timeline.md for a task folder. */
	timelineFile(dir: string): string;
}

export const SCREEN_RULES = `## Talking to the user (llm-graphs)
- While you work, keep chat replies to one or two plain sentences. Never write a summary, status report or list of corrections in chat.
- When the task is done or blocked, call report_summary once with the complete final report. It is shown to the user pinned above the prompt; your chat reply after it is one line.
- If an advisor note or a check sends you back to work after report_summary, fix it, then call report_summary again with the complete corrected report. It replaces the earlier one. Do not describe the correction in chat.
- Anything you need from the user goes in report_summary "questions": one decision per question, ending in "?", with the options and your recommendation. Ask for the decision itself ("Merge MR !42 now?"), not around it ("Let me know if you'd like...").`;

export function registerScreen(pi: ExtensionAPI, deps: { dir: () => string | undefined }): ScreenHooks {
	let ui: ExtensionContext | undefined;
	let draft: (Card & { dir: string }) | undefined;
	let shown: (Card & { at: number }) | undefined;
	let version = 0;
	const entries: Entry[] = [];

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

	function publish(ctx: ExtensionContext): void {
		if (!draft) return;
		const d = draft;
		draft = undefined;
		shown = { ...d, pending: undefined, at: Date.now() };
		ui = ctx;
		append(d.dir, { kind: "report", ts: new Date().toISOString(), label: `Final report${d.version > 1 ? ` v${d.version}` : ""}: ${d.title}`, body: reportBody(d) });
		paint();
		// One short, findable line in the transcript; the card itself stays pinned. Sent once the
		// session is idle: sent earlier it would be queued as a follow-up and start another turn.
		const line = `Final report${d.version > 1 ? ` v${d.version}` : ""}: ${d.title}. ${d.questions.length ? `${d.questions.length} question(s) for you. ` : ""}${d.reportFile}`;
		let tries = 0;
		const send = () => {
			if (shown?.version !== d.version) return; // replaced meanwhile
			if (!ctx.isIdle() && tries++ < 100) return void setTimeout(send, 100);
			if (ctx.isIdle()) pi.sendMessage({ customType: "llmg-final", content: line, display: true }, { triggerTurn: false });
		};
		setTimeout(send, 50);
	}

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent?.kind !== "sub") ui = ctx;
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

	// An advisor note after the card went up: say a revision is coming, rather than a second report.
	pi.on("context", async event => {
		if (!shown) return undefined;
		const late = event.messages.some(m => {
			const msg = m as { role?: string; customType?: string; timestamp?: number };
			return msg.role === "custom" && msg.customType === "advisor" && (msg.timestamp ?? 0) > shown!.at;
		});
		if (late && !shown.pending) {
			shown.pending = "An advisor raised a point after this report. The agent is checking it; a revised report will replace this one.";
			paint();
		}
		return undefined;
	});

	// The transcript line: one row, not a boxed card.
	pi.registerMessageRenderer("llmg-final", (message, _opts, theme) => {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return linesComponent([`■ ${text}`], theme, "accent");
	});

	// Advisor cards: one row in the transcript (expand to read). Needs extensionRenderers.transcriptPresenters.
	try {
		pi.registerTranscriptPresenter?.(block => {
			if (block.type !== "message") return undefined;
			const m = block.message as { customType?: string };
			if (m.customType !== "advisor") return undefined;
			return { compact: { label: "Advisor note (the final report covers it; expand to read)" } };
		});
	} catch {}

	// Long finished replies: first lines only. Needs extensionRenderers.assistantText.
	try {
		pi.registerAssistantTextRenderer?.(c => (c.streaming ? undefined : fold(c.text, FOLD_LINES)));
	} catch {}

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
			if (!continuing) publish(ctx);
		},
		draft(d) {
			version++;
			draft = { version, title: d.title, overview: d.overview, questions: d.questions, reportFile: d.reportFile, timelineFile: timelineFile(d.dir), dir: d.dir };
			flush(d.dir); // directions that arrived before the task folder existed
			return "It will be shown pinned above the prompt when you finish this turn. Reply in chat with one line only.";
		},
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
