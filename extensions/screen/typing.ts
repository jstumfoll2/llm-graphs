/**
 * Keeps typed-in lines out of the question dialog.
 *
 * Firstmate (and any other script) types into the omp pane: tmux delivers each
 * character a millisecond or so apart, then Enter. With the question dialog
 * open, that Enter would pick the highlighted option and answer for you. While
 * the dialog is open, every raw key goes through this guard first: a line that
 * is clearly not a person typing (it starts with Firstmate's invisible U+2063
 * marker, arrives as a paste, or comes in faster than anyone types) is held
 * back from the dialog, up to and including its Enter, and handed on whole.
 * Your own keys (arrows, Enter, n, Esc, ...) pass straight through.
 */

const MARK = "⁣";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Two printable keys closer than this are a script, not a person. */
export const BURST_MS = 8;
/** A held line with no Enter after this long is handed on anyway. */
export const HOLD_MS = 1000;

export type GuardResult = { consume: boolean; line?: string };

const isEnter = (d: string) => d === "\r" || d === "\n" || d === "\r\n";
/** One printable character or a run of them, with no escape sequence. */
const isPrintable = (d: string) => d.length > 0 && !/[\x00-\x1f\x7f]/.test(d);

export class TypingGuard {
	private held: string | undefined;
	private prev: { ch: string; at: number } | undefined;
	private heldAt = 0;

	/** True while a typed-in line is being held back. */
	holding(): boolean {
		return this.held !== undefined;
	}

	/** One raw key (or chunk) from the terminal. */
	feed(data: string, now = Date.now()): GuardResult {
		if (this.held !== undefined) {
			this.heldAt = now;
			if (isEnter(data)) return this.release();
			const text = stripPaste(data);
			if (isPrintable(text)) this.held += text;
			// Anything else (an escape sequence in the middle of a typed line) is dropped with it.
			return { consume: true };
		}
		if (data.startsWith(PASTE_START) || data.includes(MARK)) return this.hold(stripPaste(data), now);
		if (isPrintable(data)) {
			if (data.length > 1) return this.hold(data, now);
			const p = this.prev;
			this.prev = { ch: data, at: now };
			// The first key of a fast line has already reached the dialog. Firstmate's lines
			// start with U+2063 or "[", which the dialog ignores; of the other letters only
			// "n" does anything (it opens an empty note, which Esc closes).
			if (p && now - p.at < BURST_MS) return this.hold(p.ch + data, now);
			return { consume: false };
		}
		this.prev = undefined;
		return { consume: false };
	}

	/** Call from a timer: a held line whose Enter never came is handed on. */
	tick(now = Date.now()): string | undefined {
		if (this.held === undefined || now - this.heldAt < HOLD_MS) return undefined;
		return this.release().line;
	}

	private hold(text: string, now: number): GuardResult {
		this.held = text;
		this.heldAt = now;
		this.prev = undefined;
		return { consume: true };
	}

	private release(): GuardResult {
		const line = this.held ?? "";
		this.held = undefined;
		this.prev = undefined;
		return { consume: true, line: line.trim() ? line : undefined };
	}
}

function stripPaste(d: string): string {
	return d.split(PASTE_START).join("").split(PASTE_END).join("");
}
