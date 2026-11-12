import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planCleanup, sessionUnits, taskUnits, type Unit } from "../extensions/cleanup/sizes";
import { blockReason, leadMayRun } from "../extensions/lead/register";
import { addLesson, emptyDb, forget, helpCount, loadDb, markHelped, promptBlock, taskLessons, updateDb } from "../extensions/memory/lessons";
import { renderReport } from "../extensions/report/render";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmg-lmc-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("lead mode", () => {
	test("the lead may run single git and glab calls only", () => {
		expect(leadMayRun("git status")).toBe(true);
		expect(leadMayRun("git commit -m 'Fix gain lookup'")).toBe(true);
		expect(leadMayRun("glab mr view")).toBe(true);
		expect(leadMayRun("make -j16")).toBe(false);
		expect(leadMayRun("git status && make")).toBe(false);
		expect(leadMayRun("git log | head")).toBe(false);
		expect(leadMayRun("git diff > x.patch")).toBe(false);
		expect(leadMayRun("git $(rm -rf x)")).toBe(false);
		expect(leadMayRun("gitk")).toBe(false);
	});

	test("the refusal names the workers", () => {
		const r = blockReason("edit");
		expect(r).toContain("llmg-fix");
		expect(r).toContain("llmg-investigate");
		expect(r).toContain("llmg-test");
	});

	test("worker definitions ship with the plugin", () => {
		for (const name of ["llmg-investigate", "llmg-test", "llmg-fix"]) {
			const md = fs.readFileSync(path.join(import.meta.dir, "..", "agents", `${name}.md`), "utf8");
			expect(md).toContain(`name: ${name}`);
			expect(md).toMatch(/description: .{20,}/);
		}
	});
});

describe("lessons", () => {
	test("a tip becomes a rule only after helping in two other tasks", () => {
		const db = emptyDb();
		const r = addLesson(db, "The build needs module load gcc/12 before cmake.", { task: "t1" });
		expect(r.lesson?.status).toBe("candidate");
		const id = r.lesson!.id;
		expect(markHelped(db, id, "t1", "Saved a failed build in this task.").counted).toBe(false); // its own task doesn't count
		expect(markHelped(db, id, "t2", "Build worked on the first try.").promoted).toBeUndefined();
		expect(markHelped(db, id, "t2", "Same task, counted once.").counted).toBe(false);
		expect(helpCount(db.lessons[0]!)).toBe(1);
		const p = markHelped(db, id, "t3", "Build worked on the first try again.");
		expect(p.promoted).toBe(true);
		expect(db.lessons[0]!.status).toBe("rule");
		expect(markHelped(db, 99, "t3", "nothing at all here").error).toContain("no lesson 99");
	});

	test("duplicates, short text, your own rules, forget", () => {
		const db = emptyDb();
		addLesson(db, "Unit tests run with ctest -R gain from build/.");
		expect(addLesson(db, "unit tests run with  ctest -R gain from build/").duplicate).toBe(true);
		expect(addLesson(db, "use gcc").error).toContain("full sentence");
		const mine = addLesson(db, "Never touch the frozen 6DOF reference tables.", { source: "user" });
		expect(mine.lesson?.status).toBe("rule");
		expect(forget(db, 1)?.id).toBe(1);
		expect(db.lessons.map(l => l.id)).toEqual([2]);
	});

	test("prompt lists rules and tips; report lists what this task used", () => {
		const db = emptyDb();
		addLesson(db, "The build needs module load gcc/12 before cmake.", { task: "t1" });
		addLesson(db, "Never touch the frozen 6DOF reference tables.", { source: "user" });
		markHelped(db, 1, "t2", "Build worked on the first try.");
		const block = promptBlock(db)!;
		expect(block).toContain("Standing rules");
		expect(block).toContain("[2] Never touch");
		expect(block).toContain("Unproven tips");
		expect(block).toContain("[1] The build needs");
		const used = taskLessons(db, "t2");
		expect(used.helped[0]).toContain("Build worked on the first try.");
		const info = { id: "t2", title: "T", repo: "r", cwd: "/r", startedAt: "2026-11-12T00:00:00.000Z", dirtyAtStart: [] };
		const md = renderReport(info, [], [], undefined, { changedFiles: [], lessons: used });
		expect(md).toContain("## Lessons");
		expect(md).toContain("Lessons that helped:");
	});

	test("file updates keep both writers' lessons", () => {
		const f = path.join(tmp, "mem", "repo.json");
		updateDb(f, db => addLesson(db, "First session learned this one thing."));
		updateDb(f, db => addLesson(db, "Second session learned another thing."));
		expect(loadDb(f).lessons.map(l => l.id)).toEqual([1, 2]);
		fs.writeFileSync(f, "{broken");
		expect(loadDb(f).lessons).toEqual([]);
	});
});

describe("cleanup", () => {
	const DAY = 86_400_000;
	const now = Date.parse("2026-11-12T00:00:00Z");
	const u = (key: string, gbs: number, daysOld: number): Unit => ({ key, paths: [key], bytes: gbs * 1e9, mtimeMs: now - daysOld * DAY });

	test("removes oldest first until under the cap, never recent or protected", () => {
		const units = [u("a", 10, 30), u("b", 10, 20), u("c", 10, 10), u("d", 10, 1)];
		const p = planCleanup(units, 25e9, 3 * DAY, now);
		expect(p.remove.map(x => x.key)).toEqual(["a", "b"]);
		expect(p.after).toBe(20e9);
		expect(planCleanup(units, 25e9, 3 * DAY, now, x => x.key === "a").remove.map(x => x.key)).toEqual(["b", "c"]);
		const stuck = planCleanup(units, 5e9, 15 * DAY, now);
		expect(stuck.remove.map(x => x.key)).toEqual(["a", "b"]);
		expect(stuck.stuck).toBe(true);
		expect(planCleanup(units, 0, 0, now).remove).toEqual([]); // cap 0 = off
	});

	test("finds session files with their artifact folders, and task folders", () => {
		const s = path.join(tmp, "sessions", "--home-me-sim--");
		fs.mkdirSync(path.join(s, "2026-11-01_abc"), { recursive: true });
		fs.writeFileSync(path.join(s, "2026-11-01_abc.jsonl"), "x".repeat(100));
		fs.writeFileSync(path.join(s, "2026-11-01_abc", "out.log"), "y".repeat(50));
		fs.writeFileSync(path.join(s, "notes.txt"), "not a session");
		const units = sessionUnits(path.join(tmp, "sessions"));
		expect(units).toHaveLength(1);
		expect(units[0]!.bytes).toBe(150);
		expect(units[0]!.paths).toHaveLength(2);
		const r = path.join(tmp, "reports", "sim", "20261101-000000-ab12-x");
		fs.mkdirSync(r, { recursive: true });
		fs.writeFileSync(path.join(r, "task.json"), "{}");
		expect(taskUnits(path.join(tmp, "reports")).map(x => x.key)).toEqual([r]);
	});
});
