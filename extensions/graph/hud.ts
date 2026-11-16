/**
 * The step list as it shows above the prompt, drawn to look like OMP's own
 * TODO HUD: a bold "TODO" title, a spine that fills with progress and ends in
 * a short tail, checkboxes, done steps struck through in green, the active
 * step in the accent color, the rest dim, and a walking window that keeps the
 * active step in view ("… N more steps" for the rest). Substeps hang under
 * their step one level down. Pure function of the plan and the theme.
 */
import type { Plan, PlanStep } from "./plan";

/** The parts of OMP's theme this uses. Anything missing falls back to plain text. */
export interface HudTheme {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
	strikethrough?: (text: string) => string;
	checkbox?: { checked: string; unchecked: string };
	tree?: { branch: string; last: string; vertical: string; horizontal: string; hook: string };
}

const OPEN_CAP = 5; // open steps previewed, like OMP's active-stage cap
const TAIL_LEN = 6;
const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
	return [...s.replace(ANSI, "")].length;
}

function glyphs(t: HudTheme) {
	return {
		checked: t.checkbox?.checked ?? "☑",
		unchecked: t.checkbox?.unchecked ?? "☐",
		branch: t.tree?.branch ?? "├─",
		last: t.tree?.last ?? "└─",
		vertical: t.tree?.vertical ?? "│",
		horizontal: t.tree?.horizontal ?? "─",
		hook: t.tree?.hook ?? "└",
	};
}

/**
 * Which steps the collapsed view shows, the way OMP picks todos: the last
 * finished step for context, then the active step and the open steps after
 * it, up to the cap. A substep in view brings its parent along.
 */
export function selectSteps(plan: Plan, cap = OPEN_CAP): { shown: PlanStep[]; hidden: number } {
	const steps = plan.steps;
	if (steps.length <= cap + 2) return { shown: steps, hidden: 0 };
	const open = steps.filter(s => s.status !== "done");
	if (!open.length) return { shown: steps.slice(-(cap + 1)), hidden: 0 };
	const lead = steps.filter(s => s.status === "done").slice(-1);
	let picked: PlanStep[];
	if (open.length <= cap + 1) picked = open;
	else {
		const from = Math.max(0, open.findIndex(s => s.status === "active"));
		picked = open.slice(from, from + cap);
		if (picked.length < cap) picked = open.slice(Math.max(0, open.length - cap));
	}
	const keep = new Set<PlanStep>([...lead, ...picked]);
	for (const s of [...keep]) {
		if (s.parent === undefined) continue;
		const parent = steps.find(p => p.id === s.parent);
		if (parent) keep.add(parent);
	}
	const left = open.filter(s => !keep.has(s));
	// a summary row that would hide one step shows that step instead
	if (left.length === 1) {
		keep.add(left[0]!);
		const parent = steps.find(p => p.id === left[0]!.parent);
		if (parent) keep.add(parent);
	}
	const shown = steps.filter(s => keep.has(s));
	return { shown, hidden: open.filter(s => !keep.has(s)).length };
}

/** A step's row, wrapped to `room`: checkbox and title in the step's color, notes dim. */
function stepPieces(s: PlanStep, t: HudTheme, room: number): string[] {
	const g = glyphs(t);
	const fg = (c: string, x: string) => (t.fg ? t.fg(c, x) : x);
	const strike = (x: string) => (t.strikethrough ? t.strikethrough(x) : x);
	const done = s.status === "done";
	const box = `${done ? g.checked : g.unchecked} `;
	const color = done ? "success" : s.status === "active" ? "accent" : s.status === "blocked" ? "error" : "dim";
	const notes = [s.status === "blocked" ? "blocked" : "", s.source === "inbox" ? "your ask" : ""].filter(Boolean);
	const suffix = notes.length ? ` · ${notes.join(" · ")}` : "";
	const plain = wrap(`${box}${s.title}`, room);
	const painted = plain.map((piece, i) => {
		const lead = i === 0 ? piece.slice(0, box.length) : "";
		const rest = i === 0 ? piece.slice(box.length) : piece;
		return fg(color, `${lead}${done && rest ? strike(rest) : rest}`);
	});
	if (suffix) {
		if (visibleWidth(plain[plain.length - 1]!) + suffix.length <= room) painted[painted.length - 1] += fg("dim", suffix);
		else painted.push(fg("dim", suffix.slice(3)));
	}
	return painted;
}

/** Word wrap on plain text; a word longer than the width is split. */
function wrap(text: string, width: number): string[] {
	if (visibleWidth(text) <= width) return [text];
	const out: string[] = [];
	let cur = "";
	for (let word of text.split(" ")) {
		while (word.length > width) {
			if (cur) out.push(cur), (cur = "");
			out.push(word.slice(0, width));
			word = word.slice(width);
		}
		const next = cur ? `${cur} ${word}` : word;
		if (visibleWidth(next) <= width) cur = next;
		else out.push(cur), (cur = word);
	}
	if (cur) out.push(cur);
	return out;
}

/** The rows of the HUD for a given width, including the blank row above it. */
export function hudRows(plan: Plan, theme: HudTheme, width: number): string[] {
	if (!plan.steps.length) return [];
	const t = theme;
	const g = glyphs(t);
	const fg = (c: string, x: string) => (t.fg ? t.fg(c, x) : x);
	const bold = (x: string) => (t.bold ? t.bold(x) : x);
	const RESET = t.fg ? "\x1b[0m" : "";

	const total = plan.steps.length;
	const done = plan.steps.filter(s => s.status === "done").length;
	const blocked = plan.steps.filter(s => s.status === "blocked").length;
	const { shown, hidden } = selectSteps(plan);

	// Content rows hung on the spine: the list header, then the step tree.
	type Row = { first: string; hang: string; pieces: (room: number) => string[] };
	const plainRow = (text: string) => (room: number) => wrap(text, room);
	const blocks: Row[][] = [];
	const counts = ` · ${done}/${total}${blocked ? ` · ${blocked} blocked` : ""}`;
	const header = () => [bold(fg("accent", "Steps")) + fg("dim", counts)];
	const tree: Row[] = [];
	const top = shown.filter(s => s.parent === undefined);
	const summary = hidden > 0 ? `… ${hidden} more step${hidden === 1 ? "" : "s"}` : "";
	top.forEach((s, i) => {
		const isLast = i === top.length - 1 && !summary;
		const cont = isLast ? "   " : `${g.vertical}  `;
		tree.push({ first: `${fg("dim", isLast ? g.last : g.branch)} `, hang: `${fg("dim", cont)}  `, pieces: room => stepPieces(s, t, room) });
		const subs = shown.filter(c => c.parent === s.id);
		subs.forEach((c, j) => {
			const subLast = j === subs.length - 1;
			const pre = fg("dim", cont);
			tree.push({
				first: `${pre}${fg("dim", subLast ? g.last : g.branch)} `,
				hang: `${pre}${fg("dim", subLast ? "   " : `${g.vertical}  `)}  `,
				pieces: room => stepPieces(c, t, room),
			});
		});
	});
	if (summary) tree.push({ first: `${fg("dim", g.last)} `, hang: "   ", pieces: room => plainRow(summary)(room).map(x => fg("muted", x)) });
	blocks.push([{ first: "", hang: "", pieces: header }, ...tree]);
	if (plan.inbox.length) {
		const n = plan.inbox.length;
		const ask = `${n} ask${n === 1 ? "" : "s"} queued, joining after the current step`;
		blocks.push([{ first: "", hang: "", pieces: room => plainRow(ask)(room).map(x => fg("muted", x)) }]);
	}

	// Flatten onto the spine: `├─` on a block's first row, `│` after it.
	const lines: ({ spine: string; spineHang: string } & Row)[] = [];
	for (const block of blocks) {
		block.forEach((r, i) => lines.push({ spine: i === 0 ? `${g.branch} ` : `${g.vertical}  `, spineHang: `${g.vertical}  `, ...r }));
	}

	// Progress fills the path: down the spine, round the bend, out the tail.
	const tail = g.hook + g.horizontal.repeat(Math.max(0, TAIL_LEN - visibleWidth(g.hook)));
	const pathLen = lines.length + TAIL_LEN;
	let filled = Math.round((done / total) * pathLen);
	if (done > 0) filled = Math.max(filled, 1);
	if (done < total) filled = Math.min(filled, pathLen - 1);

	const out = ["", ` ${bold(fg("accent", "TODO"))}`];
	lines.forEach((l, i) => {
		const color = i < filled ? "accent" : "dim";
		const spine = `  ${fg(color, l.spine)}`;
		const spineHang = `  ${fg(color, l.spineHang)}`;
		const room = Math.max(10, width - visibleWidth(spine) - Math.max(visibleWidth(l.first), visibleWidth(l.hang)));
		const pieces = l.pieces(room);
		pieces.forEach((p, k) => {
			out.push(`${k === 0 ? spine : spineHang}${k === 0 ? l.first : l.hang}${p}${k < pieces.length - 1 ? RESET : ""}`);
		});
	});
	const tailFilled = Math.max(0, Math.min(filled - lines.length, [...tail].length));
	const tailChars = [...tail];
	out.push(`  ${fg("accent", tailChars.slice(0, tailFilled).join(""))}${fg("dim", tailChars.slice(tailFilled).join(""))}`);
	return out;
}
