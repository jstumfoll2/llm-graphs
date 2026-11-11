import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	active,
	addSteps,
	blockStep,
	emptyPlan,
	finishStep,
	gateAdvisor,
	loadPlan,
	planLines,
	savePlan,
	setPlan,
} from "../extensions/graph/plan";
import { renderReport } from "../extensions/report/render";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmg-plan-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const EVIDENCE = "Ran make test, 212 passed and 0 failed after the change.";

describe("plan", () => {
	test("first plan activates step 1 and cannot be rewritten", () => {
		const p = emptyPlan();
		expect(setPlan(p, ["Investigate", "Fix"]).error).toBeUndefined();
		expect(active(p)?.id).toBe(1);
		expect(setPlan(p, ["Something else", "Other"]).error).toContain("already exists");
		expect(setPlan(emptyPlan(), ["Only one"]).error).toContain("2 to 20");
	});

	test("finishing needs the active id and real evidence", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		expect(finishStep(p, 2, EVIDENCE).error).toContain("not the active step");
		expect(finishStep(p, 1, "done").error).toContain("too thin");
		const r = finishStep(p, 1, EVIDENCE);
		expect(r.error).toBeUndefined();
		expect(r.next?.id).toBe(2);
		expect(p.steps[0]!.status).toBe("done");
	});

	test("a mid-task ask waits for the step boundary and lands after the original steps", () => {
		const p = emptyPlan();
		setPlan(p, ["Part 1", "Part 2"]);
		p.inbox.push("Also update the docs");
		expect(p.steps).toHaveLength(2); // nothing changes mid-step
		const r = finishStep(p, 1, EVIDENCE);
		expect(r.fromInbox.map(s => s.title)).toEqual(["Also update the docs"]);
		expect(p.steps.map(s => s.title)).toEqual(["Part 1", "Part 2", "Also update the docs"]);
		expect(r.next?.title).toBe("Part 2"); // part 2 of the original ask still comes first
	});

	test("added steps go to the end; blocked steps move on", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		addSteps(p, ["C"]);
		expect(p.steps.map(s => s.id)).toEqual([1, 2, 3]);
		expect(blockStep(p, 1, "no access to the test rig").next?.id).toBe(2);
		expect(p.steps[0]!.reason).toBe("no access to the test rig");
	});

	test("advisor gate passes one note per step, holds the rest, and is stable on replay", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		expect(gateAdvisor(p, 100, "check units", 1)).toBe(true);
		expect(gateAdvisor(p, 101, "re-investigate", 1)).toBe(false);
		expect(gateAdvisor(p, 100, "check units", 1)).toBe(true); // same message seen again
		finishStep(p, 1, EVIDENCE);
		expect(gateAdvisor(p, 102, "new step, new note", 1)).toBe(true);
	});

	test("save and load round trip", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		savePlan(tmp, p);
		expect(loadPlan(tmp).steps.map(s => s.status)).toEqual(["active", "pending"]);
		expect(loadPlan(path.join(tmp, "missing")).steps).toEqual([]);
	});

	test("long plans keep the active step in view", () => {
		const p = emptyPlan();
		setPlan(
			p,
			Array.from({ length: 20 }, (_, i) => `S${i + 1}`),
		);
		for (let i = 1; i <= 15; i++) finishStep(p, i, EVIDENCE);
		const lines = planLines(p, 6);
		expect(lines).toHaveLength(6);
		expect(lines.some(l => l.startsWith("[>] 16."))).toBe(true);
	});

	test("report shows the plan and held advisor notes", () => {
		const p = emptyPlan();
		setPlan(p, ["A", "B"]);
		gateAdvisor(p, 1, "first", 1);
		gateAdvisor(p, 2, "Consider the wind model too", 1);
		finishStep(p, 1, EVIDENCE);
		const info = { id: "t", title: "T", repo: "r", cwd: "/r", startedAt: "2026-11-11T00:00:00.000Z", dirtyAtStart: [] };
		const md = renderReport(info, [], [], undefined, { changedFiles: [] }, undefined, p);
		expect(md).toContain("## Plan");
		expect(md).toContain("1 of 2 steps done.");
		expect(md).toContain("| 1 | A | done | Ran make test");
		expect(md).toContain("Consider the wind model too");
	});
});
