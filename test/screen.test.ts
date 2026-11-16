import { describe, expect, test } from "bun:test";
import { askMode, BOOKKEEPING_TOOLS, QuietSpans, sameQuestions, wrap } from "../extensions/screen/register";
import { HOLD_MS, TypingGuard } from "../extensions/screen/typing";
import { noticeKind, noticesOn } from "../extensions/firstmate/notices";
import { answersText, cardLines, checkQuestions, dialogQuestions, fold, headline, isOperational, questionLines, timelineEntry } from "../extensions/screen/view";

describe("questions", () => {
	test("direct questions with options and a recommendation pass", () => {
		expect(
			checkQuestions([
				{ ask: "Merge MR !42 into develop now?", options: ["Merge now", "Wait for Alice"], recommend: "Merge now", why: "CI is green." },
				{ ask: "Which gain limit applies, 30 or 35 deg?" },
			]),
		).toBeUndefined();
	});

	test("indirect, multi-part or malformed questions are refused with the reason", () => {
		expect(checkQuestions([{ ask: "Let me know if you would like me to open an MR." }])).toContain("must be one direct question");
		expect(checkQuestions([{ ask: "Let me know if you want the MR?" }])).toContain("indirect");
		expect(checkQuestions([{ ask: "Should I merge? Or wait?" }])).toContain("more than one thing");
		expect(checkQuestions([{ ask: `${"word ".repeat(45)}ok?` }])).toContain("40 or fewer");
		expect(checkQuestions([{ ask: "Merge now?", options: ["Yes"] }])).toContain("one option");
		expect(checkQuestions([{ ask: "Merge now?", options: ["Yes", "No"], recommend: "Maybe" }])).toContain("must be one of its options");
	});

	test("questions render as numbered asks with lettered options", () => {
		const lines = questionLines([
			{ ask: "Merge MR !42 now?", options: ["Merge now", "Wait"], recommend: "Merge now", why: "CI is green." },
			{ ask: "Which limit applies?" },
		]);
		expect(lines).toEqual([
			"Q1. Merge MR !42 now?",
			"    Options: (a) Merge now  (b) Wait",
			"    Recommended: Merge now, because CI is green.",
			"Q2. Which limit applies?",
		]);
	});
});

describe("the pinned card", () => {
	const card = {
		title: "Raise the pitch gain",
		overview: "Raised the gain to 1.25. Tests passed.",
		questions: [{ ask: "Open the MR now?", options: ["Yes", "No"], recommend: "Yes" }],
		reportFile: "/home/me/.omp/llm-graphs/reports/repo/t1/REPORT.md",
		timelineFile: "/home/me/.omp/llm-graphs/reports/repo/t1/timeline.md",
	};

	test("has the outcome, the questions, and each path alone on a line", () => {
		const lines = cardLines(card);
		expect(lines[0]).toBe("━━ Final report: Raise the pitch gain ━━");
		expect(lines).toContain("NEEDS YOU: 1 question");
		expect(lines).toContain("Q1. Open the MR now?");
		expect(lines).toContain(card.reportFile);
		expect(lines).toContain(card.timelineFile);
	});

	test("never numbers revisions, and says how to answer", () => {
		const lines = cardLines({ ...card, answerHint: "/answer opens these one at a time." });
		expect(lines.join("\n")).not.toMatch(/v2|revis/);
		expect(lines).toContain("/answer opens these one at a time.");
	});

	test("with the dialog, the card lists only the asks", () => {
		const lines = cardLines({ ...card, dialog: true });
		expect(lines).toContain("Q1. Open the MR now?");
		expect(lines.join("\n")).not.toContain("Options:");
	});

	test("says plainly when nothing needs you", () => {
		expect(cardLines({ ...card, questions: [] })).toContain("Nothing needs you.");
	});

	test("long overviews are cut at a sentence", () => {
		const long = `${"The first sentence is here. ".repeat(20)}End.`;
		const h = headline(long, 100);
		expect(h.length).toBeLessThanOrEqual(100);
		expect(h.endsWith(".")).toBe(true);
	});

	test("wrapping never drops part of a long path", () => {
		const p = `/very/long/${"segment/".repeat(20)}REPORT.md`;
		expect(wrap(p, 40).join("")).toBe(p);
		expect(wrap("short line", 40)).toEqual(["short line"]);
		expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
	});
});

describe("folding and history", () => {
	test("long replies fold to their first lines; short ones are left alone", () => {
		const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const f = fold(text, 30)!;
		expect(f).toContain("line 4");
		expect(f).not.toContain("line 5\n");
		expect(f).toContain("46 more lines folded");
		expect(fold("a\nb", 30)).toBeUndefined();
		expect(fold(text, 0)).toBeUndefined();
	});

	test("Firstmate's notices are not counted as your directions", () => {
		expect(isOperational("⁣FIRSTMATE_OP: v1 watcher: task t1 is done")).toBe(true);
		expect(isOperational(": Firstmate instruction waiting: list ...")).toBe(true);
		expect(isOperational("[fm-from-firstmate]⁣please check")).toBe(true);
		expect(isOperational("Fix the login test and add dark mode")).toBe(false);
	});

	test("timeline entries carry who and when", () => {
		expect(timelineEntry("direction", "2026-11-13T03:41:40Z", "Do X")).toBe("## 2026-11-13 03:41 · You\n\nDo X\n\n");
		expect(timelineEntry("report", "2026-11-13T04:00:00Z", "Done")).toContain("· Final report");
	});
});

describe("the question dialog", () => {
	const qs = [
		{ ask: "Merge MR !42 now?", options: ["Merge now", "Wait"], recommend: "Merge now", why: "CI is green." },
		{ ask: "Which limit applies?", why: "The spec gives two." },
	];

	test("each question becomes a tab with the recommendation preselected", () => {
		const d = dialogQuestions(qs);
		expect(d[0]).toEqual({
			id: "q1",
			header: "Q1",
			question: "Merge MR !42 now?",
			options: [{ label: "Merge now", description: "CI is green." }, { label: "Wait" }],
			recommended: 0,
		});
		expect(d[1]).toEqual({ id: "q2", header: "Q2", question: "Which limit applies?\nThe spec gives two.", options: [] });
	});

	test("answers go back to the agent as one plain message", () => {
		const text = answersText(qs, [
			{ id: "q1", selectedOptions: ["Wait"], note: "after lunch" },
			{ id: "q2", selectedOptions: [], customInput: "35 deg" },
		]);
		expect(text).toBe(
			"My answers to the questions in the final report:\nQ1. Merge MR !42 now?\n    Wait (note: after lunch)\nQ2. Which limit applies?\n    35 deg",
		);
	});

	test("opens by itself, Firstmate or not, unless switched to /answer only or off", () => {
		expect(askMode({})).toBe("auto");
		expect(askMode({ FM_HOME: "/fm" })).toBe("auto");
		expect(askMode({ FM_HOME: "/fm", OMP_GRAPHS_ASK: "command" })).toBe("command");
		expect(askMode({ OMP_GRAPHS_ASK: "off" })).toBe("off");
	});

	test("a later report with the same questions counts as answered", () => {
		const a = [{ ask: "Merge MR !42 now?" }, { ask: "Which limit applies?" }];
		expect(sameQuestions(a, [{ ask: " Merge MR !42 now? " }, { ask: "Which limit applies?" }])).toBe(true);
		expect(sameQuestions(a, [{ ask: "Merge MR !42 now?" }])).toBe(false);
		expect(sameQuestions(a, [{ ask: "Merge MR !43 now?" }, { ask: "Which limit applies?" }])).toBe(false);
	});
});

describe("typing kept out of the open dialog", () => {
	/** Feed a string one key at a time, `gap` ms apart, like tmux send-keys. */
	function type(g: TypingGuard, text: string, start: number, gap: number) {
		const out: { key: string; consume: boolean; line?: string }[] = [];
		[...text].forEach((key, i) => out.push({ key, ...g.feed(key, start + i * gap) }));
		return out;
	}

	test("a Firstmate notice is held back whole, its Enter included, and handed on", () => {
		const g = new TypingGuard();
		const notice = "\u2063FIRSTMATE_OP: v1 watcher: wake";
		const keys = type(g, notice, 1000, 1);
		expect(keys.every(k => k.consume)).toBe(true);
		expect(g.feed("\r", 1100)).toEqual({ consume: true, line: notice });
		expect(g.holding()).toBe(false);
		// The dialog is yours again.
		expect(g.feed("\r", 3000).consume).toBe(false);
	});

	test("a fast line without the marker is caught from its second key", () => {
		const g = new TypingGuard();
		const keys = type(g, "[fm-from-firstmate] hi", 1000, 1);
		expect(keys[0]!.consume).toBe(false); // "[" does nothing in the dialog
		expect(keys.slice(1).every(k => k.consume)).toBe(true);
		expect(g.feed("\r", 1050).line).toBe("[fm-from-firstmate] hi");
	});

	test("a paste is held back", () => {
		const g = new TypingGuard();
		expect(g.feed("\x1b[200~some text\x1b[201~", 1000)).toEqual({ consume: true });
		expect(g.feed("\r", 1010).line).toBe("some text");
	});

	test("your own keys pass: arrows, Enter, n for a note, letters typed at a human pace", () => {
		const g = new TypingGuard();
		for (const [i, k] of ["\x1b[B", "\x1b[A", "n", "o", "k", "\r", " ", "\t", "\x1b"].entries()) {
			expect(g.feed(k, 1000 + i * 120).consume).toBe(false);
		}
	});

	test("a held line whose Enter never comes is handed on after a while", () => {
		const g = new TypingGuard();
		type(g, "\u2063FIRSTMATE_OP: v1 x: y", 1000, 1);
		expect(g.tick(1100)).toBeUndefined();
		expect(g.tick(1100 + HOLD_MS)).toBe("\u2063FIRSTMATE_OP: v1 x: y");
		expect(g.holding()).toBe(false);
	});
});

describe("behind the scenes", () => {
	test("text is hidden from a nudge or final report until you write again", () => {
		const q = new QuietSpans();
		expect(q.covers(5)).toBe(false);
		q.start(10);
		q.start(12); // already open: no new span
		expect(q.covers(11)).toBe(true);
		expect(q.covers(9)).toBe(false);
		q.end(20);
		expect(q.covers(19)).toBe(true);
		expect(q.covers(20)).toBe(false);
		expect(q.open()).toBe(false);
	});

	test("only the plugin's own bookkeeping tools are hidden", () => {
		expect(BOOKKEEPING_TOOLS.has("report_step")).toBe(true);
		expect(BOOKKEEPING_TOOLS.has("step_done")).toBe(true);
		expect(BOOKKEEPING_TOOLS.has("bash")).toBe(false);
		expect(BOOKKEEPING_TOOLS.has("edit")).toBe(false);
	});

	test("Firstmate's typed notices are recognized by kind", () => {
		expect(noticeKind("\u2063FIRSTMATE_OP: v1 away-supervisor: check t1")).toBe("away-supervisor");
		expect(noticeKind("[fm-from-firstmate] do this")).toBe("message");
		expect(noticeKind(": Firstmate instruction waiting: list ...")).toBeUndefined(); // a worker's doorbell
		expect(noticeKind("Fix the login test")).toBeUndefined();
		expect(noticesOn({})).toBe(true);
		expect(noticesOn({ OMP_GRAPHS_FM_NOTICES: "show" })).toBe(false);
	});
});
