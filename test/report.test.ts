import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { latestTests, renderReport } from "../extensions/report/render";
import { newTaskId, pruneTasks, type StepEntry, slug, TaskStore } from "../extensions/report/store";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmg-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function step(n: number, extra: Partial<StepEntry> = {}): StepEntry {
	return {
		n,
		ts: `2026-11-11T0${n}:00:00.000Z`,
		title: `Step ${n}`,
		done: `Did thing ${n} in src/sim.cpp and checked the output against the reference run.`,
		decisions: [],
		tests: [],
		openQuestions: [],
		needsYou: [],
		files: [],
		...extra,
	};
}

describe("store", () => {
	test("slug and task ids are filesystem safe", () => {
		expect(slug("Fix the 6DOF gain table!!")).toBe("fix-the-6dof-gain-table");
		expect(slug("")).toBe("task");
		expect(newTaskId("Hello world", new Date(2026, 10, 11, 4, 5, 6))).toBe("20261111-040506-hello-world");
	});

	test("round trips task, ledger, steps and summary; skips a torn last line", () => {
		const s = new TaskStore(tmp, "sim-repo", "20261111-000000-a");
		s.create({ id: "a", title: "A", repo: "sim-repo", cwd: "/x", startedAt: "2026-11-11T00:00:00Z", dirtyAtStart: [] });
		s.addLedger({ ts: "t", tool: "edit", path: "a.cpp", error: false });
		s.addStep(step(1));
		fs.appendFileSync(path.join(s.dir, "steps.jsonl"), '{"n":2,"tit'); // crash mid-write
		s.setSummary({ ts: "t", overview: "done", needsYou: [] });
		expect(s.info().title).toBe("A");
		expect(s.ledger()).toHaveLength(1);
		expect(s.steps()).toHaveLength(1);
		expect(s.summary()?.overview).toBe("done");
	});

	test("prune keeps only the newest task folders", () => {
		for (const id of ["20261101-000000-x", "20261102-000000-y", "20261103-000000-z"]) {
			new TaskStore(tmp, "prune-repo", id).create({
				id,
				title: id,
				repo: "prune-repo",
				cwd: "/x",
				startedAt: "t",
				dirtyAtStart: [],
			});
		}
		expect(pruneTasks(tmp, "prune-repo", 2)).toEqual(["20261101-000000-x"]);
		expect(fs.readdirSync(path.join(tmp, "prune-repo")).sort()).toEqual(["20261102-000000-y", "20261103-000000-z"]);
	});
});

describe("render", () => {
	const info = {
		id: "t",
		title: "Fix gain table",
		repo: "sim",
		cwd: "/work/sim",
		startedAt: "2026-11-11T00:00:00.000Z",
		dirtyAtStart: ["notes.txt"],
	};

	test("latest test result per command wins", () => {
		const steps = [
			step(1, { tests: [{ command: "make test", result: "fail" }] }),
			step(2, { tests: [{ command: "make test", result: "pass" }] }),
		];
		expect(latestTests(steps)).toEqual([{ command: "make test", result: "pass" }]);
	});

	test("report leads with summary and decisions, then changes, tests and steps", () => {
		const steps = [
			step(1, { needsYou: ["Approve the new limit of 30 deg"], openQuestions: ["Is the table in degrees?"] }),
			step(2, {
				tests: [{ command: "make test", result: "pass", note: "212 tests" }],
				decisions: [{ what: "Kept the old interpolation", why: "matches flight data" }],
				files: ["src/gain.cpp"],
			}),
		];
		const md = renderReport(
			info,
			steps,
			[
				{ ts: "t", tool: "edit", path: "src/gain.cpp", error: false },
				{ ts: "t", tool: "bash", command: "make", error: true },
			],
			{ ts: "t", overview: "Fixed the off-by-one in the gain table lookup.", needsYou: [], mrLink: "https://gitlab/x/-/merge_requests/1" },
			{ changedFiles: ["src/gain.cpp"], diffStat: " src/gain.cpp | 4 ++--" },
			"2026-11-11T03:00:00.000Z",
		);
		const order = ["## Summary", "## Needs your decision", "## What changed", "## Tests", "## Open questions", "## Step log", "## Activity"];
		const idx = order.map(h => md.indexOf(h));
		expect(idx.every(i => i >= 0)).toBe(true);
		expect([...idx].sort((a, b) => a - b)).toEqual(idx);
		expect(md).toContain("Approve the new limit of 30 deg");
		expect(md).toContain("| `make test` | pass | 212 tests |");
		expect(md).toContain("merge_requests/1");
		expect(md).toContain("Already modified before this task started");
		expect(md).toContain("1 file edits, 1 commands (1 failed)");
		expect(md).toContain("2 h 0 min");
	});

	test("empty task renders without errors", () => {
		const md = renderReport(info, [], [], undefined, { changedFiles: [] });
		expect(md).toContain("No steps reported yet.");
		expect(md).toContain("No file changes since the task started.");
	});
});
