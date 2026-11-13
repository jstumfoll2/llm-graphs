/**
 * Lessons that carry from one task to the next, per repo. Pure logic plus
 * load/save of one JSON file.
 *
 * A lesson starts as a candidate ("build needs module load gcc/12"). It
 * becomes a standing rule only after it helped in `promoteAfter` other tasks
 * (not the task that wrote it), so a one-off guess never turns into a rule.
 * You can also add rules yourself, or promote and forget lessons by hand.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Help {
	task: string;
	ts: string;
	how: string;
}

export interface Lesson {
	id: number;
	text: string;
	why?: string;
	status: "candidate" | "rule";
	source: "agent" | "user";
	addedAt: string;
	addedIn?: string; // task id
	promotedAt?: string;
	helped: Help[];
}

export interface LessonDb {
	nextId: number;
	lessons: Lesson[];
}

export const MAX_TEXT = 300;
export const MAX_CANDIDATES = 100; // oldest unused candidates are dropped past this
export const MAX_RULES = 40;

export function emptyDb(): LessonDb {
	return { nextId: 1, lessons: [] };
}

export function loadDb(file: string): LessonDb {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LessonDb>;
		return { nextId: raw.nextId ?? 1, lessons: Array.isArray(raw.lessons) ? raw.lessons : [] };
	} catch {
		return emptyDb();
	}
}

export function saveDb(file: string, db: LessonDb): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** Load, change, save in one go, so two sessions in one repo don't lose each other's lessons. */
export function updateDb<T>(file: string, change: (db: LessonDb) => T): T {
	const db = loadDb(file);
	const out = change(db);
	saveDb(file, db);
	return out;
}

function norm(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9/._-]+/g, " ").replace(/[._-]+(\s|$)/g, "$1").replace(/\s+/g, " ").trim();
}

function clean(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** For notes that are never put in the prompt (why, how): cut at a word and mark the cut. */
function shorten(text: string): string {
	const t = clean(text);
	if (t.length <= MAX_TEXT) return t;
	const cut = t.slice(0, MAX_TEXT - 1);
	const space = cut.lastIndexOf(" ");
	return `${space > MAX_TEXT / 2 ? cut.slice(0, space) : cut}…`;
}

/** Distinct tasks, other than the one that wrote it, where the lesson helped. */
export function helpCount(l: Lesson): number {
	return new Set(l.helped.filter(h => h.task !== l.addedIn).map(h => h.task)).size;
}

export function addLesson(
	db: LessonDb,
	text: string,
	opts: { why?: string; task?: string; source?: "agent" | "user"; now?: string } = {},
): { error?: string; lesson?: Lesson; duplicate?: boolean } {
	const t = clean(text);
	// Never cut a lesson: half a command still reads like a rule and gets put in every prompt.
	if (t.length > MAX_TEXT) {
		return { error: `Not saved: the lesson is ${t.length} characters, the limit is ${MAX_TEXT}. Rewrite it shorter (keep any command whole), or split it into separate lessons, and call again.` };
	}
	if (t.split(" ").length < 4) return { error: "Write the lesson as one full sentence someone could act on, e.g. 'The build needs module load gcc/12 first.'" };
	const same = db.lessons.find(l => norm(l.text) === norm(t));
	if (same) return { lesson: same, duplicate: true };
	const source = opts.source ?? "agent";
	const now = opts.now ?? new Date().toISOString();
	const lesson: Lesson = {
		id: db.nextId++,
		text: t,
		why: opts.why ? shorten(opts.why) : undefined,
		status: source === "user" ? "rule" : "candidate", // you said so; no proof needed
		source,
		addedAt: now,
		addedIn: opts.task,
		promotedAt: source === "user" ? now : undefined,
		helped: [],
	};
	db.lessons.push(lesson);
	trim(db);
	return { lesson };
}

/** Record that a lesson helped in this task. Promotes it once it has helped in enough other tasks. */
export function markHelped(
	db: LessonDb,
	id: number,
	task: string,
	how: string,
	promoteAfter = 2,
	now = new Date().toISOString(),
): { error?: string; lesson?: Lesson; promoted?: boolean; counted?: boolean } {
	const l = db.lessons.find(x => x.id === id);
	if (!l) return { error: `There is no lesson ${id}.` };
	if (how.trim().split(/\s+/).length < 4) return { error: "Say in one sentence how it helped." };
	const before = helpCount(l);
	if (!l.helped.some(h => h.task === task)) l.helped.push({ task, ts: now, how: shorten(how) });
	const after = helpCount(l);
	if (l.status === "candidate" && after >= promoteAfter) {
		l.status = "rule";
		l.promotedAt = now;
		return { lesson: l, promoted: true, counted: after > before };
	}
	return { lesson: l, counted: after > before };
}

export function forget(db: LessonDb, id: number): Lesson | undefined {
	const i = db.lessons.findIndex(l => l.id === id);
	return i < 0 ? undefined : db.lessons.splice(i, 1)[0];
}

export function promote(db: LessonDb, id: number, now = new Date().toISOString()): Lesson | undefined {
	const l = db.lessons.find(x => x.id === id);
	if (l && l.status !== "rule") {
		l.status = "rule";
		l.promotedAt = now;
	}
	return l;
}

/** Keep the file bounded: drop the oldest candidates that never helped, then the oldest candidates. */
function trim(db: LessonDb): void {
	const cands = () => db.lessons.filter(l => l.status === "candidate");
	while (cands().length > MAX_CANDIDATES) {
		const c = cands();
		const victim = c.find(l => helpCount(l) === 0) ?? c[0]!;
		db.lessons.splice(db.lessons.indexOf(victim), 1);
	}
}

/**
 * Text for the system prompt. Taken once at the start of a task and kept for
 * the whole task, so lessons learned mid-task never change the instructions
 * the agent is working under.
 */
export function promptBlock(db: LessonDb, maxCandidates = 10): string | undefined {
	const rules = db.lessons.filter(l => l.status === "rule").slice(-MAX_RULES);
	const cands = db.lessons
		.filter(l => l.status === "candidate")
		.sort((a, b) => helpCount(b) - helpCount(a) || b.id - a.id)
		.slice(0, maxCandidates);
	const out = [
		"## Lessons for this repo (llm-graphs)",
		"- When you learn something a later task in this repo would need (a build quirk, a test command, where a thing lives), call lesson_add with one plain sentence.",
		"- When a lesson below saves you time or a mistake, call lesson_helped with its id.",
	];
	if (rules.length) out.push("", "Standing rules (proven, follow them):", ...rules.map(l => `- [${l.id}] ${l.text}`));
	if (cands.length) out.push("", "Unproven tips (may be wrong; check before relying on them):", ...cands.map(l => `- [${l.id}] ${l.text}`));
	return out.join("\n");
}

export function lessonLines(db: LessonDb): string[] {
	if (!db.lessons.length) return ["No lessons yet."];
	return db.lessons.map(
		l => `[${l.id}] ${l.status === "rule" ? "RULE" : `tip, helped ${helpCount(l)}x`}${l.source === "user" ? " (yours)" : ""}: ${l.text}`,
	);
}

/** Lessons this task added or used, for its report. */
export function taskLessons(db: LessonDb, task: string): { added: string[]; helped: string[]; promoted: string[] } {
	return {
		added: db.lessons.filter(l => l.addedIn === task).map(l => `[${l.id}] ${l.text}`),
		helped: db.lessons.filter(l => l.helped.some(h => h.task === task)).map(l => `[${l.id}] ${l.text} How it helped: ${l.helped.find(h => h.task === task)!.how}`),
		promoted: db.lessons
			.filter(l => l.status === "rule" && l.source === "agent" && l.helped.at(-1)?.task === task && l.promotedAt === l.helped.at(-1)?.ts)
			.map(l => `[${l.id}] ${l.text}`),
	};
}
