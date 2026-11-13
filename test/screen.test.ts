import { describe, expect, test } from "bun:test";
import { wrap } from "../extensions/screen/register";
import { cardLines, checkQuestions, fold, headline, isOperational, questionLines, timelineEntry } from "../extensions/screen/view";

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

	test("questions render as numbered asks with lettered options and how to answer", () => {
		const lines = questionLines([
			{ ask: "Merge MR !42 now?", options: ["Merge now", "Wait"], recommend: "Merge now", why: "CI is green." },
			{ ask: "Which limit applies?" },
		]);
		expect(lines).toEqual([
			"Q1. Merge MR !42 now?",
			"    Options: (a) Merge now  (b) Wait",
			"    Recommended: Merge now, because CI is green.",
			"Q2. Which limit applies?",
			"Answer like: Q1 a, Q2 <answer>",
		]);
	});
});

describe("the pinned card", () => {
	const card = {
		version: 2,
		title: "Raise the pitch gain",
		overview: "Raised the gain to 1.25. Tests passed.",
		questions: [{ ask: "Open the MR now?", options: ["Yes", "No"], recommend: "Yes" }],
		reportFile: "/home/me/.omp/llm-graphs/reports/repo/t1/REPORT.md",
		timelineFile: "/home/me/.omp/llm-graphs/reports/repo/t1/timeline.md",
	};

	test("has the outcome, the questions, and each path alone on a line", () => {
		const lines = cardLines(card);
		expect(lines[0]).toBe("━━ Final report (v2): Raise the pitch gain ━━");
		expect(lines).toContain("NEEDS YOU: 1 question");
		expect(lines).toContain("Q1. Open the MR now?");
		expect(lines).toContain(card.reportFile);
		expect(lines).toContain(card.timelineFile);
	});

	test("says when a revision is on its way", () => {
		expect(cardLines({ ...card, pending: "An advisor raised a point." })[0]).toBe("… An advisor raised a point.");
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
