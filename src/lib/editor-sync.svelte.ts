import type { EditorView } from '@codemirror/view';
import { mapLine, type LineChunk, type Side } from './line-alignment';
import type { PaneState } from './panes.svelte';

/**
 * Keeps the two editors level as either one scrolls.
 *
 * Level means matching lines side by side, not matching scroll offsets: once one side
 * has lines the other lacks, equal offsets would drift apart. The line at the middle of
 * the scrolled editor is mapped through the diff, and the other editor scrolls to put
 * its counterpart in the same place.
 */

/**
 * How long an editor keeps the lead after its last scroll event. Within it the other
 * editor's scroll events are ignored: they are that editor following, plus the small
 * corrections it makes as it measures lines it has just scrolled into view — and sending
 * those back would have the two editors push each other back and forth.
 */
const LEAD_MS = 150;

export class EditorSync {
	/** How the two texts' lines line up, or null while the panes do not hold two texts. */
	#alignment: LineChunk[] | null = null;

	#views: Record<Side, EditorView | null> = { left: null, right: null };
	/** The editor being scrolled, which the other follows, and until when it leads. */
	#leader: { side: Side; until: number } | null = null;
	/** Drops an alignment that finishes after a newer one was asked for. */
	#token = 0;

	/** Registers an editor's view; the returned function unregisters it. */
	attach(side: Side, view: EditorView): () => void {
		this.#views[side] = view;
		return () => {
			if (this.#views[side] === view) this.#views[side] = null;
		};
	}

	/** Aligns two text panes afresh, pushing any unsaved edits to the service first. */
	async refresh(left: PaneState, right: PaneState) {
		const token = ++this.#token;
		try {
			const [leftId, rightId] = await Promise.all([left.sync(), right.sync()]);
			const alignment = leftId && rightId ? await window.comparer.lineChunks(leftId, rightId) : null;
			if (token === this.#token) this.#alignment = alignment;
		} catch {
			// Alignment is a convenience: without it each editor just scrolls on its own.
			if (token === this.#token) this.#alignment = null;
		}
	}

	clear() {
		this.#token++;
		this.#alignment = null;
	}

	/** Brings the other editor level with `from`, which just scrolled. */
	follow(from: Side) {
		const now = performance.now();
		if (this.#leader && this.#leader.side !== from && now < this.#leader.until) return;
		this.#leader = { side: from, until: now + LEAD_MS };

		const to: Side = from === 'left' ? 'right' : 'left';
		const source = this.#views[from];
		const target = this.#views[to];
		const alignment = this.#alignment;
		if (!alignment || !source || !target) return;

		const line = mapLine(alignment, lineAtMiddle(source), from);
		const scroller = target.scrollDOM;
		const middle = target.documentPadding.top + heightAtLine(target, line);
		const top = Math.max(
			0,
			Math.min(scroller.scrollHeight - scroller.clientHeight, middle - scroller.clientHeight / 2)
		);
		if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
	}
}

/** The fractional, zero-based line at the vertical middle of an editor's view. */
function lineAtMiddle(view: EditorView): number {
	const scroller = view.scrollDOM;
	return lineAtScroll(view, scroller.scrollTop + scroller.clientHeight / 2);
}

/**
 * The fractional, zero-based line at a scroll position in an editor, running on past the
 * last line by whole lines of the default height, for a position in the editor's padding.
 */
export function lineAtScroll(view: EditorView, scrollY: number): number {
	const doc = view.state.doc;
	const y = scrollY - view.documentPadding.top;
	const block = view.lineBlockAtHeight(y);
	const line = doc.lineAt(block.from).number - 1;
	if (y > block.bottom && line === doc.lines - 1) return doc.lines + (y - block.bottom) / view.defaultLineHeight;
	return line + (block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0);
}

/** How far down the document a fractional, zero-based line starts; past the end, where it ends. */
function heightAtLine(view: EditorView, line: number): number {
	const doc = view.state.doc;
	if (line >= doc.lines) return view.lineBlockAt(doc.length).bottom;
	const whole = Math.max(0, Math.floor(line));
	const block = view.lineBlockAt(doc.line(whole + 1).from);
	return block.top + (line - whole) * block.height;
}
