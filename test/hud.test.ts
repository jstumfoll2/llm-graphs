import { describe, expect, test } from "bun:test";
import { hudRows, selectSteps, visibleWidth } from "../extensions/graph/hud";
import { addSteps, blockStep, emptyPlan, finishStep, setPlan } from "../extensions/graph/plan";

const EV = "ran the check and it showed what was expected here";
const TITLES = ["Read the gain table code", "Write a failing test", "Fix the edge", "Run the regression", "Update the docs", "Open the MR", "Report", "Tidy up", "Close out"];

describe("step list HUD (drawn like OMP's TODO)", () => {
	test("title, header with count, checkbox rows, closing tail", () => {
		const p = emptyPlan();
		setPlan(p, ["Read the code", "Fix it", "Test it"]);
		finishStep(p, 1, EV);
		const rows = hudRows(p, {}, 80);
		expect(rows).toEqual([
			"",
			" TODO",
			"  ├─ Steps · 1/3",
			"  │  ├─ ☑ Read the code",
			"  │  ├─ ☐ Fix it",
			"  │  └─ ☐ Test it",
			"  └─────",
		]);
	});

	test("substeps hang under their step; queued asks and blocked steps show", () => {
		const p = emptyPlan();
		setPlan(p, ["Write a test", "Fix it"]);
		addSteps(p, ["Check 3D table", "Check 2D table"], "added", 1);
		p.inbox.push("bump the version");
		const rows = hudRows(p, {}, 80);
		expect(rows.slice(2)).toEqual([
			"  ├─ Steps · 0/4",
			"  │  ├─ ☐ Write a test",
			"  │  │  ├─ ☐ Check 3D table",
			"  │  │  └─ ☐ Check 2D table",
			"  │  └─ ☐ Fix it",
			"  ├─ 1 ask queued, joining after the current step",
			"  └─────",
		]);
		blockStep(p, 3, "no 3D table data on this machine"); // the queued ask joins here
		expect(hudRows(p, {}, 80)).toContain("  │  │  ├─ ☐ Check 3D table · blocked");
		expect(hudRows(p, {}, 80)[2]).toBe("  ├─ Steps · 0/5 · 1 blocked");
	});

	test("long lists keep the last done step and the active one in view", () => {
		const p = emptyPlan();
		setPlan(p, TITLES);
		finishStep(p, 1, EV);
		finishStep(p, 2, EV);
		const { shown, hidden } = selectSteps(p);
		expect(shown.map(s => s.id)).toEqual([2, 3, 4, 5, 6, 7]);
		expect(hidden).toBe(2);
		const rows = hudRows(p, {}, 80);
		expect(rows).toContain("  │  └─ … 2 more steps");
		expect(rows).not.toContain("  │  ├─ ☑ Read the gain table code");
	});

	test("a summary that would hide one step shows the step instead", () => {
		const p = emptyPlan();
		setPlan(p, TITLES.slice(0, 7));
		const { shown, hidden } = selectSteps(p);
		expect(hidden).toBe(0);
		expect(shown.length).toBe(7);
	});

	test("long titles wrap under their own text, never past the width", () => {
		const p = emptyPlan();
		setPlan(p, ["Fix the interpolation at the very edge of the three dimensional gain table", "Report"]);
		const rows = hudRows(p, {}, 40);
		for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
		expect(rows[3]).toBe("  │  ├─ ☐ Fix the interpolation at the");
		expect(rows[4]).toStartWith("  │  │    very edge");
	});

	test("uses the theme's colors and glyphs", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		finishStep(p, 1, EV);
		const theme = {
			fg: (c: string, s: string) => `<${c}>${s}</>`,
			bold: (s: string) => `*${s}*`,
			strikethrough: (s: string) => `~${s}~`,
			checkbox: { checked: "x", unchecked: "o" },
		};
		const rows = hudRows(p, theme, 80);
		expect(rows[1]).toBe(" *<accent>TODO</>*");
		expect(rows.some(r => r.includes("<success>x ~A~</>"))).toBe(true);
		expect(rows.some(r => r.includes("<accent>o B</>"))).toBe(true);
	});

	test("empty plan draws nothing", () => {
		expect(hudRows(emptyPlan(), {}, 80)).toEqual([]);
	});
});
