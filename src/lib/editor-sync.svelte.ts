import type { EditorView } from '@codemirror/view';
import {
	kindAtLine,
	lineMarks,
	mapLine,
	type ChangeKind,
	type ChangeMark,
	type LineChunk,
	type Side
} from './line-alignment';
import type { PaneState } from './panes.svelte';

/**
 * Keeps the two editors level as either one scrolls, and supplies the change marks for
 * their minimaps.
 *
 * Level means matching lines side by side, not matching scroll offsets: once one side
 * has lines the other lacks, equal offsets would drift apart. The line at the middle of
 * the scrolled editor is mapped through the diff, and the other editor scrolls to put
 * its counterpart in the same place.
 */
export class EditorSync {
	/** The line ranges that differ, or null while the panes do not hold two texts. */
	chunks = $state.raw<LineChunk[] | null>(null);

	#views: Record<Side, EditorView | null> = { left: null, right: null };
	/**
	 * The scroll position this set on each editor. Setting it fires a scroll event of its
	 * own, which must not be taken for the user scrolling that editor and sent back.
	 */
	#echo: Record<Side, number | null> = { left: null, right: null };
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
			const chunks = leftId && rightId ? await window.comparer.lineChunks(leftId, rightId) : null;
			if (token === this.#token) this.chunks = chunks;
		} catch {
			// Alignment is a convenience: without it each editor just scrolls on its own.
			if (token === this.#token) this.chunks = null;
		}
	}

	clear() {
		this.#token++;
		this.chunks = null;
	}

	/** Brings the other editor level with `from`, which just scrolled. */
	follow(from: Side) {
		const to: Side = from === 'left' ? 'right' : 'left';
		const source = this.#views[from];
		const target = this.#views[to];
		const echo = this.#echo[from];
		this.#echo[from] = null;
		if (!this.chunks || !source || !target) return;
		if (echo !== null && Math.abs(source.scrollDOM.scrollTop - echo) < 1) return;

		const line = mapLine(this.chunks, lineAtMiddle(source), from);
		const scroller = target.scrollDOM;
		const middle = target.documentPadding.top + heightAtLine(target, line);
		const top = Math.max(
			0,
			Math.min(scroller.scrollHeight - scroller.clientHeight, middle - scroller.clientHeight / 2)
		);
		if (Math.abs(scroller.scrollTop - top) < 1) return;
		scroller.scrollTop = top;
		this.#echo[to] = scroller.scrollTop;
	}

	/** The kind of change a zero-based line on one side is part of, or null. */
	kindAt(side: Side, line: number): ChangeKind | null {
		return this.chunks ? kindAtLine(this.chunks, side, line) : null;
	}

	/**
	 * Change marks for one editor's minimap, in pixels from the top of its scrollable
	 * area. Lines past what has streamed into the editor so far are placed at
	 * `lineHeight` each, so the whole file's changes show before all of it has loaded.
	 */
	marks(side: Side, view: EditorView, lineHeight: number): ChangeMark[] {
		if (!this.chunks) return [];
		const padding = view.documentPadding.top;
		return lineMarks(this.chunks, side).map((mark) => {
			const start = padding + heightAtLine(view, mark.start, lineHeight);
			const end = mark.end > mark.start ? padding + heightAtLine(view, mark.end, lineHeight) : start;
			return { start, end, kind: mark.kind };
		});
	}
}

/** The fractional, zero-based line at the vertical middle of an editor's view. */
function lineAtMiddle(view: EditorView): number {
	const scroller = view.scrollDOM;
	const y = scroller.scrollTop + scroller.clientHeight / 2 - view.documentPadding.top;
	const block = view.lineBlockAtHeight(y);
	const line = view.state.doc.lineAt(block.from).number - 1;
	return line + (block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0);
}

/**
 * How far down the document a fractional, zero-based line starts. A line past the end of
 * what the editor holds is placed after it at `lineHeight` per line, or at the end without one.
 */
function heightAtLine(view: EditorView, line: number, lineHeight = 0): number {
	const doc = view.state.doc;
	if (line >= doc.lines) return view.lineBlockAt(doc.length).bottom + (line - doc.lines) * lineHeight;
	const whole = Math.max(0, Math.floor(line));
	const block = view.lineBlockAt(doc.line(whole + 1).from);
	return block.top + (line - whole) * block.height;
}
