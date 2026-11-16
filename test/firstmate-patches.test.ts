import { describe, expect, test } from "bun:test";
// @ts-expect-error plain .mjs scripts, no types
import { applyReplyShape } from "../firstmate/apply-reply-shape.mjs";
// @ts-expect-error plain .mjs scripts, no types
import { mergeOverlay } from "../firstmate/merge-worker-overlay.mjs";

const agents = (heading: string) =>
	[
		"# AGENTS",
		"",
		"## 7. Supervision protocol",
		"",
		"- Watch the panes.",
		"",
		heading,
		"",
		"- **Talk in outcomes, not mechanics.**",
		"",
		"Every escalation must stand alone and remain concise.",
		"Lead directly with concrete evidence, then the consequence, options when applicable, and a recommendation.",
		"Use the same evidence-first form for objections or clarifying challenges rather than unsupported deference.",
		"",
		"- Batch non-urgent updates into the next natural reply.",
		"",
		"## 10. Backlog contract",
		"",
		"- Batch non-urgent updates into the next natural reply.",
		"",
	].join("\n");

describe("reply shape", () => {
	for (const heading of ["## 9. Escalation and captain etiquette", "## 8. Escalation and captain etiquette", "## Escalation and captain etiquette"]) {
		test(`finds the section by name: ${heading}`, () => {
			const r = applyReplyShape(agents(heading));
			expect(r.error).toBeUndefined();
			expect(r.failed).toEqual([]);
			expect(r.done).toHaveLength(3);
			const [inside, outside] = r.text.split("## 10. Backlog contract");
			expect(inside).toContain(`${heading}\n\n### Reply shape\n`);
			expect(inside).toContain("Lead with the ask in one sentence");
			expect(inside).toContain("below its first line and above its question block.");
			// the same line in another section is left alone
			expect(outside).toContain("- Batch non-urgent updates into the next natural reply.\n");
			expect(outside).not.toContain("question block");
		});
	}

	test("running it twice changes nothing", () => {
		const once = applyReplyShape(agents("## 9. Escalation and captain etiquette")).text;
		const twice = applyReplyShape(once);
		expect(twice.text).toBe(once);
		expect(twice.done).toEqual([]);
		expect(twice.skipped).toHaveLength(3);
	});

	test("reports a rewrite it can't place and still adds the block", () => {
		const r = applyReplyShape(agents("## 8. Escalation and captain etiquette").replace("- Batch non-urgent updates into the next natural reply.\n\n## 10", "- Batch updates.\n\n## 10"));
		expect(r.done).toContain("Reply shape block");
		expect(r.failed.map((f: { what: string }) => f.what)).toEqual(["batched updates go between first line and questions"]);
	});

	test("no such section is an error, not a guess", () => {
		expect(applyReplyShape("# AGENTS\n\n## 9. Etiquette\n").error).toContain("no heading named");
	});
});

const upstream = `composer:
  shape: borderless
retry:
  # comment
  usageReservePolicy: auto
`;

const topKeys = (text: string) => text.split("\n").filter(l => /^[A-Za-z]/.test(l)).map(l => l.split(":")[0]);

describe("worker overlay merge", () => {
	test("adds new blocks to an overlay without them", () => {
		const r = mergeOverlay(upstream);
		expect(r.error).toBeUndefined();
		expect(topKeys(r.text)).toEqual(["composer", "retry", "advisor", "recap"]);
		expect(r.text).toContain("  continueSeverity: blocker\n  maxNotesPerUpdate: 1\nrecap:");
		expect(r.text).toContain("recap:\n  # The idle recap");
		expect(r.text.endsWith("  enabled: false\n")).toBe(true);
	});

	test("merges into an existing advisor block instead of adding a second one", () => {
		const r = mergeOverlay(`${upstream}advisor:\n  # off for workers\n  enabled: false\nprewalk:\n  enabled: false\n`);
		expect(topKeys(r.text).filter(k => k === "advisor")).toHaveLength(1);
		expect(r.text).toContain("advisor:\n  # off for workers\n  enabled: false\n");
		expect(r.text).toContain("  maxNotesPerUpdate: 1\nprewalk:\n  enabled: false\n");
	});

	test("changes a different value in place and is idempotent", () => {
		const r = mergeOverlay(`advisor:\n  continueSeverity: concern # was default\n`);
		expect(r.text).toContain("  continueSeverity: blocker # was default\n");
		expect(r.changes[0]).toBe("changed advisor.continueSeverity: concern -> blocker");
		const again = mergeOverlay(r.text);
		expect(again.changes).toEqual([]);
		expect(again.text).toBe(r.text);
	});

	test("refuses a file that already has a duplicate key", () => {
		expect(mergeOverlay("advisor:\n  enabled: false\nadvisor:\n  maxNotesPerUpdate: 1\n").error).toContain('"advisor:" appears twice');
	});
});
