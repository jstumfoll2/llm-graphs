/**
 * Memory wiring: lesson_add and lesson_helped tools, the /lessons command,
 * and the lessons block in the system prompt (fixed for the life of a task).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { slug } from "../report/store";
import { addLesson, forget, lessonLines, loadDb, markHelped, promote, promptBlock, taskLessons, updateDb } from "./lessons";

const PROMOTE_AFTER = Number(process.env.OMP_GRAPHS_PROMOTE_AFTER ?? 2); // other tasks a lesson must help in before it is a rule

export function memoryDir(): string {
	const fromEnv = process.env.OMP_GRAPHS_MEMORY_DIR?.trim();
	if (fromEnv) return fromEnv.startsWith("~/") ? path.join(os.homedir(), fromEnv.slice(2)) : fromEnv;
	return path.join(os.homedir(), ".omp", "llm-graphs", "memory");
}

export function registerMemory(
	pi: ExtensionAPI,
	deps: {
		repo: () => string;
		/** Current task id, if any. */
		taskId: () => string | undefined;
	},
): {
	promptBlock(): string | undefined;
	forTask(task: string): ReturnType<typeof taskLessons>;
} {
	const z = pi.zod;
	const file = () => path.join(memoryDir(), `${slug(deps.repo() || "repo", 60)}.json`);
	let snapshot: { task: string; text: string | undefined } | undefined;

	const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

	pi.registerTool({
		name: "lesson_add",
		label: "Add lesson",
		loadMode: "essential",
		approval: "read",
		description:
			"Save one thing a later task in this repo would need to know: a build quirk, a test command, where something lives, a trap you fell into. One plain sentence. It starts as a tip and becomes a standing rule only after it helps in other tasks.",
		parameters: z.object({
			text: z.string().describe("The lesson, one sentence, e.g. 'The build needs module load gcc/12 before cmake.'"),
			why: z.string().optional().describe("What happened that taught it"),
		}),
		async execute(_id, params) {
			const r = updateDb(file(), db => addLesson(db, params.text, { why: params.why, task: deps.taskId() }));
			if (r.error) return text(r.error, true);
			return text(r.duplicate ? `Already known as lesson ${r.lesson!.id}. If it helped here, call lesson_helped instead.` : `Saved as lesson ${r.lesson!.id} (a tip until it helps in ${PROMOTE_AFTER} other tasks).`);
		},
	});

	pi.registerTool({
		name: "lesson_helped",
		label: "Lesson helped",
		loadMode: "essential",
		approval: "read",
		description: "Say that a lesson from the lessons list saved you time or a mistake in this task. This is how tips become standing rules.",
		parameters: z.object({ id: z.number().int(), how: z.string().describe("One sentence: how it helped") }),
		async execute(_id, params) {
			const task = deps.taskId();
			if (!task) return text("No task is active yet.", true);
			const r = updateDb(file(), db => markHelped(db, params.id, task, params.how, PROMOTE_AFTER));
			if (r.error) return text(r.error, true);
			if (r.promoted) return text(`Lesson ${params.id} is now a standing rule. It applies from the next task.`);
			return text(r.counted ? `Noted for lesson ${params.id}.` : `Lesson ${params.id} was already counted for this task (or it was written in this task).`);
		},
	});

	pi.registerCommand("lessons", {
		description: "Lessons for this repo. /lessons add <rule>, /lessons promote <id>, /lessons forget <id>",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			const say = (msg: string, level: "info" | "warning" = "info") => (ctx.hasUI ? ctx.ui.notify(msg, level) : console.log(msg));
			const m = a.match(/^(add|promote|forget)\s+(.+)$/s);
			if (m) {
				const [, verb, rest] = m;
				if (verb === "add") {
					const r = updateDb(file(), db => addLesson(db, rest!, { source: "user", task: deps.taskId() }));
					return say(r.error ?? `Rule ${r.lesson!.id} saved. It applies from the next task.`, r.error ? "warning" : "info");
				}
				const id = Number(rest);
				const l = updateDb(file(), db => (verb === "promote" ? promote(db, id) : forget(db, id)));
				return say(l ? `Lesson ${id} ${verb === "promote" ? "is now a rule" : "forgotten"}.` : `There is no lesson ${id}.`, l ? "info" : "warning");
			}
			const lines = lessonLines(loadDb(file()));
			if (ctx.hasUI) await ctx.ui.editor(`Lessons for ${deps.repo()} (Esc to close)`, lines.join("\n"));
			else console.log(lines.join("\n"));
		},
	});

	return {
		promptBlock() {
			const task = deps.taskId() ?? "";
			if (snapshot?.task !== task) snapshot = { task, text: promptBlock(loadDb(file())) };
			return snapshot.text;
		},
		forTask: task => taskLessons(loadDb(file()), task),
	};
}
