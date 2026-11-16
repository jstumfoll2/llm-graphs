/**
 * Firstmate's typed notices, in the first mate's own omp window.
 *
 * Firstmate's daemon and scripts type operational inputs into the pane
 * (an envelope starting with U+2063 "FIRSTMATE_OP:", or "[fm-from-firstmate]").
 * omp draws each one as a user message, so a long session fills with one-line
 * notices. Here each one is handed to the model unchanged, as a hidden message,
 * and the footer shows only the latest ("Firstmate: away-supervisor 06:12").
 * /fm-notices lists the recent ones in full.
 *
 * Only typed input is seen here: omp does not run the input hook for messages
 * another extension sends. Off in a Firstmate worker (its doorbell is handled
 * in register.ts) and with OMP_GRAPHS_FM_NOTICES=show.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const MARK = "⁣FIRSTMATE_OP:";
const STATUS = "llmg-fm";
const KEEP = 20;

/** The notice kind ("away-supervisor", "watcher", ...) of a Firstmate operational input, or undefined if it is not one. */
export function noticeKind(text: string): string | undefined {
	const t = text.trimStart();
	if (t.startsWith(MARK)) {
		const m = t.slice(MARK.length).match(/^\s*v\d+\s+([a-z0-9-]+):/);
		return m?.[1] ?? "notice";
	}
	if (t.startsWith("[fm-from-firstmate]")) return "message";
	return undefined;
}

export function noticesOn(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMP_GRAPHS_FM_NOTICES?.trim().toLowerCase() !== "show";
}

export interface FirstmateNotices {
	/** Hand on a Firstmate notice typed into the pane; false if the text is not one (or notices are shown as typed). */
	deliver(text: string, ctx: ExtensionContext): boolean;
}

export function registerFirstmateNotices(pi: ExtensionAPI): FirstmateNotices {
	if (!noticesOn()) return { deliver: () => false };
	const recent: { at: Date; kind: string; text: string }[] = [];
	const clock = (d: Date) => d.toTimeString().slice(0, 5);

	function deliver(text: string, ctx: ExtensionContext): boolean {
		const kind = noticeKind(text);
		if (!kind) return false;
		const at = new Date();
		recent.push({ at, kind, text });
		if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
		// The model receives the same text (omp sends custom messages to the provider as user content).
		pi.sendMessage(
			{ customType: "firstmate-notice", content: text, display: false, details: { kind } },
			ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" },
		);
		show(ctx, `Firstmate: ${kind} ${clock(at)}`);
		return true;
	}

	pi.on("input", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension") return undefined;
		return deliver(event.text ?? "", ctx) ? { handled: true } : undefined;
	});

	pi.registerCommand("fm-notices", {
		description: "Show the recent Firstmate notices in full (they are not drawn in the transcript)",
		handler: async (_args, ctx) => {
			const text = recent.length
				? recent.slice(-10).map(n => `[${clock(n.at)}] ${n.kind}\n${n.text.replace(/^\s*⁣/, "")}`).join("\n\n")
				: "No Firstmate notices yet this session.";
			if (ctx.hasUI) await ctx.ui.editor("Firstmate notices, newest last (Esc to close)", text);
			else console.log(text);
		},
	});
	return { deliver };
}

function show(ctx: ExtensionContext, line: string): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS, line);
	} catch {}
}
