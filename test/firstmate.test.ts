import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ackMessage, appendStatus, busyEventScript, fmTask, isDoorbell, parseRecord, pendingMessages, statusLine } from "../extensions/firstmate/fm";
import { messageText } from "../extensions/firstmate/register";
import { addSteps, blockStep, emptyPlan, finishStep, loadPlan, planText, savePlan, setPlan } from "../extensions/graph/plan";
import { disabledParts } from "../extensions/parts";
import { reportFile } from "../extensions/report/store";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmg-fm-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const record = (body: string, terminator = true) =>
	`schema=fm-task-inbox.v1\nat=2026-11-13T00:00:00Z\n${terminator ? "body-terminator=1\n" : ""}--\n${body}${terminator ? "\n" : ""}`;

describe("firstmate task", () => {
	test("found from FM_TASK_ID and FM_TASK_INBOX; can be turned off", () => {
		const env = { FM_TASK_ID: "t1", FM_TASK_INBOX: "/home/me/fm/state/t1.inbox" };
		expect(fmTask(env)).toEqual({ id: "t1", inbox: "/home/me/fm/state/t1.inbox", stateDir: "/home/me/fm/state", home: "/home/me/fm" });
		expect(fmTask({ ...env, OMP_GRAPHS_FIRSTMATE: "0" })).toBeUndefined();
		expect(fmTask({ FM_TASK_ID: "t1" })).toBeUndefined();
		expect(fmTask({ FM_TASK_ID: "t1", FM_TASK_INBOX: "relative/t1.inbox" })).toBeUndefined();
	});

	test("parts Firstmate owns are off inside a worker, and you can override", () => {
		const fmEnv = { FM_TASK_ID: "t1", FM_TASK_INBOX: "/x/state/t1.inbox" };
		expect([...disabledParts(fmEnv)].sort()).toEqual(["lead", "lessons", "verify"]);
		expect(disabledParts({}).size).toBe(0);
		expect(disabledParts({ ...fmEnv, OMP_GRAPHS_DISABLE: "" }).size).toBe(0);
		expect([...disabledParts({ OMP_GRAPHS_DISABLE: "Cleanup, lead" })].sort()).toEqual(["cleanup", "lead"]);
	});
});

describe("steering inbox", () => {
	test("records parse exactly, including the synthetic final newline", () => {
		expect(parseRecord(record("Stop and rebase.\n\nThen continue."))).toEqual({ at: "2026-11-13T00:00:00Z", body: "Stop and rebase.\n\nThen continue." });
		expect(parseRecord(record("Keep my trailing newline\n"))!.body).toBe("Keep my trailing newline\n");
		expect(parseRecord(record("legacy, no terminator", false))!.body).toBe("legacy, no terminator");
		expect(parseRecord("no header here")).toBeUndefined();
		expect(parseRecord("schema=other\n--\nx")).toBeUndefined();
	});

	test("pending messages come in numeric order; ack moves them to handled/", () => {
		const inbox = path.join(tmp, "state", "t1.inbox");
		fs.mkdirSync(inbox, { recursive: true });
		fs.writeFileSync(path.join(inbox, "010.msg"), record("second"));
		fs.writeFileSync(path.join(inbox, "002.msg"), record("first"));
		fs.writeFileSync(path.join(inbox, "003.msg"), "garbage"); // left for Firstmate to escalate
		fs.writeFileSync(path.join(inbox, ".seq.lock"), "");
		const msgs = pendingMessages(inbox);
		expect(msgs.map(m => [m.seq, m.body])).toEqual([
			[2, "first"],
			[10, "second"],
		]);
		expect(messageText(msgs[0]!)).toContain("instruction inbox #2");
		expect(messageText(msgs[0]!)).toContain("do not list or move inbox files");
		ackMessage(msgs[0]!);
		expect(fs.existsSync(path.join(inbox, "handled", "002.msg"))).toBe(true);
		expect(pendingMessages(inbox).map(m => m.seq)).toEqual([10]);
		expect(pendingMessages(path.join(tmp, "missing"))).toEqual([]);
	});

	test("the doorbell line is recognised", () => {
		expect(
			isDoorbell(
				`: Firstmate instruction waiting: list "$FM_TASK_INBOX"/*.msg in your 't1.inbox' steering inbox, read and act on each in numeric order, then mv each into its handled/.`,
			),
		).toBe(true);
		expect(isDoorbell("Firstmate said hi")).toBe(false);
	});
});

describe("status and progress", () => {
	test("status lines use Firstmate's verb [at=epoch]: text shape", () => {
		expect(statusLine("blocked", "rig  booked\nuntil Friday", 1_700_000_000_500)).toBe("blocked [at=1700000000]: rig booked until Friday\n");
		const t = fmTask({ FM_TASK_ID: "t1", FM_TASK_INBOX: path.join(tmp, "state", "t1.inbox") })!;
		appendStatus(t, "blocked", "one");
		appendStatus(t, "done", "two");
		expect(fs.readFileSync(path.join(tmp, "state", "t1.status"), "utf8").split("\n").filter(Boolean).map(l => l.split(" ")[0])).toEqual([
			"blocked",
			"done",
		]);
	});

	test("fm-busy-event.sh is found under the Firstmate home or FM_ROOT", () => {
		const t = fmTask({ FM_TASK_ID: "t1", FM_TASK_INBOX: path.join(tmp, "state", "t1.inbox") })!;
		expect(busyEventScript(t, {})).toBeUndefined();
		fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
		fs.writeFileSync(path.join(tmp, "bin", "fm-busy-event.sh"), "");
		expect(busyEventScript(t, {})).toBe(path.join(tmp, "bin", "fm-busy-event.sh"));
		const other = path.join(tmp, "elsewhere");
		fs.mkdirSync(path.join(other, "bin"), { recursive: true });
		fs.writeFileSync(path.join(other, "bin", "fm-busy-event.sh"), "");
		expect(busyEventScript(t, { FM_ROOT: other })).toBe(path.join(other, "bin", "fm-busy-event.sh"));
	});
});

describe("report location", () => {
	const vars = { task_dir: "/r/repo/task-1", task: "task-1", repo: "repo", date: "2026-11-13", fm_task: "t1", fm_home: "/fm", fm_state: "/fm/state" };
	test("default is REPORT.md in the task folder", () => {
		expect(reportFile(vars, {})).toBe("/r/repo/task-1/REPORT.md");
	});
	test("a template can put it anywhere", () => {
		expect(reportFile(vars, { OMP_GRAPHS_REPORT_FILE: "{fm_home}/data/{fm_task}/llmg-report.md" })).toBe("/fm/data/t1/llmg-report.md");
		expect(reportFile(vars, { OMP_GRAPHS_REPORT_FILE: "{env:OUT}/{repo}-{date}.md", OUT: "/reports" })).toBe("/reports/repo-2026-11-13.md");
		expect(reportFile(vars, { OMP_GRAPHS_REPORT_FILE: "notes/{task}.md" })).toBe("/r/repo/task-1/notes/task-1.md");
	});
	test("a placeholder with no value falls back to the default", () => {
		expect(reportFile({ ...vars, fm_task: undefined }, { OMP_GRAPHS_REPORT_FILE: "{fm_home}/data/{fm_task}/r.md" })).toBe("/r/repo/task-1/REPORT.md");
		expect(reportFile(vars, { OMP_GRAPHS_REPORT_FILE: "{env:NOPE}/r.md" })).toBe("/r/repo/task-1/REPORT.md");
	});
});

describe("whole step list", () => {
	test("planText shows every step with evidence, reasons and queued asks; plan.md is written", () => {
		const p = emptyPlan();
		setPlan(p, Array.from({ length: 20 }, (_, i) => `Step number ${i + 1}`));
		addSteps(p, Array.from({ length: 20 }, (_, i) => `Step number ${i + 21}`));
		addSteps(p, Array.from({ length: 20 }, (_, i) => `Step number ${i + 41}`));
		finishStep(p, 1, "Ran the gain table check and it passed.");
		blockStep(p, 2, "The HWIL rig is booked until Friday.");
		p.inbox.push("Also update the README");
		const text = planText(p);
		expect(text).toContain("1 of 60 steps done, 1 blocked, 58 to go.");
		expect(text).toContain("Step number 60");
		expect(text).not.toContain("earlier steps");
		expect(text).toContain("Ran the gain table check and it passed.");
		expect(text).toContain("blocked: The HWIL rig is booked until Friday.");
		expect(text).toContain("- Also update the README");
		const dir = path.join(tmp, "task");
		savePlan(dir, p);
		expect(fs.readFileSync(path.join(dir, "plan.md"), "utf8")).toBe(text);
		expect(loadPlan(dir).steps.length).toBe(60);
	});
});
