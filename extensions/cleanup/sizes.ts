/**
 * Disk use of OMP's session files and this plugin's task folders, and which
 * of them to remove to get under a size cap. Planning is a pure function;
 * removal only ever touches what the plan names.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Unit {
	paths: string[]; // everything that goes together (a session's .jsonl and its artifacts folder)
	key: string; // what to show: the session file or task folder
	bytes: number;
	mtimeMs: number; // newest write anywhere in the unit's top level
}

/** Total size of a file or folder, not following symlinks. */
export function sizeOf(p: string): number {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(p);
	} catch {
		return 0;
	}
	if (!st.isDirectory()) return st.size;
	let total = 0;
	let names: string[] = [];
	try {
		names = fs.readdirSync(p);
	} catch {
		return 0;
	}
	for (const n of names) total += sizeOf(path.join(p, n));
	return total;
}

function mtime(p: string): number {
	try {
		return fs.lstatSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * OMP session units under the sessions root: each `<name>.jsonl` plus its
 * `<name>/` artifacts folder (subagent transcripts and tool output live there).
 */
export function sessionUnits(sessionsRoot: string): Unit[] {
	const out: Unit[] = [];
	let projects: fs.Dirent[] = [];
	try {
		projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const proj of projects) {
		if (!proj.isDirectory()) continue;
		const dir = path.join(sessionsRoot, proj.name);
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			if (!n.endsWith(".jsonl")) continue;
			const file = path.join(dir, n);
			const art = file.slice(0, -".jsonl".length);
			const paths = [file];
			let t = mtime(file);
			if (fs.existsSync(art) && fs.lstatSync(art).isDirectory()) {
				paths.push(art);
				t = Math.max(t, mtime(art));
			}
			out.push({ paths, key: file, bytes: paths.reduce((s, p) => s + sizeOf(p), 0), mtimeMs: t });
		}
	}
	return out;
}

/** This plugin's task folders: <reports root>/<repo>/<task>/. */
export function taskUnits(reportsRoot: string): Unit[] {
	const out: Unit[] = [];
	let repos: fs.Dirent[] = [];
	try {
		repos = fs.readdirSync(reportsRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const r of repos) {
		if (!r.isDirectory()) continue;
		const rdir = path.join(reportsRoot, r.name);
		try {
			for (const t of fs.readdirSync(rdir, { withFileTypes: true })) {
				if (!t.isDirectory()) continue;
				const dir = path.join(rdir, t.name);
				let newest = mtime(dir);
				for (const f of fs.readdirSync(dir)) newest = Math.max(newest, mtime(path.join(dir, f)));
				out.push({ paths: [dir], key: dir, bytes: sizeOf(dir), mtimeMs: newest });
			}
		} catch {
			// removed while we looked
		}
	}
	return out;
}

export interface CleanupPlan {
	total: number;
	remove: Unit[];
	after: number;
	/** Over the cap, but everything left is recent or protected. */
	stuck: boolean;
}

/**
 * Oldest first, remove units until the total is under the cap. Never removes
 * a unit written to in the last `keepMs`, or one `protect` names.
 */
export function planCleanup(units: Unit[], capBytes: number, keepMs: number, now: number, protect: (u: Unit) => boolean = () => false): CleanupPlan {
	const total = units.reduce((s, u) => s + u.bytes, 0);
	let after = total;
	const remove: Unit[] = [];
	if (capBytes > 0) {
		for (const u of [...units].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
			if (after <= capBytes) break;
			if (now - u.mtimeMs < keepMs || protect(u)) continue;
			remove.push(u);
			after -= u.bytes;
		}
	}
	return { total, remove, after, stuck: capBytes > 0 && after > capBytes };
}

export function removeUnits(units: Unit[]): number {
	let n = 0;
	for (const u of units) {
		for (const p of u.paths) fs.rmSync(p, { recursive: true, force: true });
		n++;
	}
	return n;
}

export function gb(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
