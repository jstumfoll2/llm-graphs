/**
 * What the omp window shows, as pure functions: the final report card pinned
 * above the prompt, explicit questions, folded long replies, and the timeline
 * file that holds your directions and every report in order.
 */

export interface Question {
	ask: string; // one direct question, ends with "?"
	options?: string[]; // the choices, if it is a choice
	recommend?: string; // which option, or what answer, the agent recommends
	why?: string; // one sentence: why that recommendation
}

const MAX_ASK_WORDS = 40;
const HEDGES = [/\blet me know\b/i, /\bif you (want|like|prefer|would like)\b/i, /\bfeel free\b/i, /\bshould i perhaps\b/i, /\bany thoughts\b/i, /\bwould you be open\b/i];

/** Error text for questions that aren't direct enough, else undefined. */
export function checkQuestions(qs: Question[]): string | undefined {
	const problems: string[] = [];
	qs.forEach((q, i) => {
		const ask = q.ask.trim();
		const n = `Question ${i + 1}`;
		if (!ask.endsWith("?")) problems.push(`${n} must be one direct question ending in "?".`);
		const words = ask.split(/\s+/).filter(Boolean).length;
		if (words > MAX_ASK_WORDS) problems.push(`${n} has ${words} words; ask it in ${MAX_ASK_WORDS} or fewer and put background in "why".`);
		if ((ask.match(/\?/g) ?? []).length > 1) problems.push(`${n} asks more than one thing; split it into separate questions.`);
		for (const h of HEDGES) if (h.test(ask)) problems.push(`${n} is indirect ("${ask.match(h)![0]}"). Ask for the decision itself, e.g. "Merge MR !42 now?".`);
		if (q.options && q.options.length === 1) problems.push(`${n} has one option; give two or more, or leave options out.`);
		if (q.recommend && q.options?.length && !q.options.some(o => o.trim() === q.recommend!.trim())) {
			problems.push(`${n}: "recommend" must be one of its options, copied exactly.`);
		}
	});
	return problems.length ? `Not recorded. ${problems.join(" ")}` : undefined;
}

/** The questions as plain numbered lines, the same in the card, REPORT.md and the timeline. */
export function questionLines(qs: Question[]): string[] {
	const out: string[] = [];
	qs.forEach((q, i) => {
		out.push(`Q${i + 1}. ${q.ask.trim()}`);
		if (q.options?.length) out.push(`    Options: ${q.options.map((o, j) => `(${String.fromCharCode(97 + j)}) ${o.trim()}`).join("  ")}`);
		if (q.recommend) out.push(`    Recommended: ${q.recommend.trim()}${q.why ? `, because ${lowerFirst(q.why.trim().replace(/\.$/, ""))}.` : ""}`);
		else if (q.why) out.push(`    Why it matters: ${q.why.trim()}`);
	});
	return out;
}

function lowerFirst(s: string): string {
	return s && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

export interface Card {
	title: string;
	overview: string;
	questions: Question[];
	reportFile: string;
	timelineFile: string;
	/** How to answer the questions, shown under them (e.g. "/answer opens them one at a time"). */
	answerHint?: string;
	/** The question dialog holds the options: the card lists the asks only. */
	dialog?: boolean;
}

/** First sentences of the overview, up to `max` characters, cut at a sentence end. */
export function headline(overview: string, max = 300): string {
	const t = overview.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
	return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))} …`;
}

/** Lines for the widget pinned above the prompt. Paths are on their own lines so a click finds them whole. */
export function cardLines(c: Card): string[] {
	const out: string[] = [];
	out.push(`━━ Final report: ${c.title} ━━`);
	out.push(headline(c.overview));
	if (c.questions.length) {
		out.push("", `NEEDS YOU: ${c.questions.length} question${c.questions.length === 1 ? "" : "s"}`);
		out.push(...(c.dialog ? c.questions.map((q, i) => `Q${i + 1}. ${q.ask.trim()}`) : questionLines(c.questions)));
		if (c.answerHint) out.push(c.answerHint);
	} else {
		out.push("Nothing needs you.");
	}
	out.push("", "Report:", c.reportFile, "Timeline (your directions and every report):", c.timelineFile, "/jump to go back · /report hide to clear");
	return out;
}

/**
 * Fold a long finished reply to its first lines. Display only: the model,
 * the session and /jump keep the full text.
 */
export function fold(text: string, maxLines: number, keep = 4): string | undefined {
	if (maxLines <= 0) return undefined;
	const lines = text.split("\n");
	if (lines.length <= maxLines) return undefined;
	return `${lines.slice(0, keep).join("\n")}\n\n_… ${lines.length - keep} more lines folded. /jump shows the full text._`;
}

/** One ask-dialog question per report question: the recommendation preselected, "why" under it. */
export interface DialogQuestion {
	id: string;
	header: string;
	question: string;
	options: { label: string; description?: string }[];
	recommended?: number;
}

export function dialogQuestions(qs: Question[]): DialogQuestion[] {
	return qs.map((q, i) => {
		const options = (q.options ?? []).map(o => ({ label: o.trim() }));
		const rec = q.recommend ? options.findIndex(o => o.label === q.recommend!.trim()) : -1;
		if (rec >= 0 && q.why) options[rec] = { ...options[rec]!, description: q.why.trim() };
		const question = q.why && rec < 0 ? `${q.ask.trim()}\n${q.why.trim()}` : q.ask.trim();
		return { id: `q${i + 1}`, header: `Q${i + 1}`, question, options, ...(rec >= 0 ? { recommended: rec } : {}) };
	});
}

/** A submitted answer to one dialog question (the fields omp's ask dialog returns). */
export interface DialogAnswer {
	id: string;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
}

/** The answers as one plain message to the agent, in question order. */
export function answersText(qs: Question[], answers: DialogAnswer[]): string {
	const lines = ["My answers to the questions in the final report:"];
	qs.forEach((q, i) => {
		const a = answers.find(x => x.id === `q${i + 1}`);
		const picked = [...(a?.selectedOptions ?? []), ...(a?.customInput?.trim() ? [a.customInput.trim()] : [])];
		lines.push(`Q${i + 1}. ${q.ask.trim()}`, `    ${picked.length ? picked.join("; ") : "(no answer)"}${a?.note?.trim() ? ` (note: ${a.note.trim()})` : ""}`);
	});
	return lines.join("\n");
}

/** Firstmate's operational input envelope (bin/fm-operational-input.sh): not a direction from you. */
export function isOperational(text: string): boolean {
	const t = text.trimStart();
	return t.startsWith("⁣FIRSTMATE_OP:") || t.startsWith("[fm-from-firstmate]") || t.startsWith(": Firstmate instruction waiting:");
}

export function timelineEntry(kind: "direction" | "report", ts: string, body: string): string {
	const when = ts.replace("T", " ").slice(0, 16);
	const head = kind === "direction" ? `## ${when} · You` : `## ${when} · Final report`;
	return `${head}\n\n${body.trim()}\n\n`;
}

export function reportBody(c: Card): string {
	const lines = [c.overview.trim()];
	if (c.questions.length) lines.push("", "Needs you:", ...questionLines(c.questions));
	lines.push("", `Full report: ${c.reportFile}`);
	return lines.join("\n");
}
