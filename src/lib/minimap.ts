import type { ChangeKind } from './line-alignment';

/**
 * What a minimap draws for one line: where its text starts and ends, in columns, and
 * the colour of the change it is part of, if any.
 */
export type StripCell = { indent: number; length: number; kind: ChangeKind | null };

/**
 * One line of content as the minimap samples it: its vertical extent in the content,
 * in pixels, and a cell per column of text — one for a single text, two for the halves
 * of a side by side view.
 */
export type StripLine = { top: number; bottom: number; cells: StripCell[] };

/** Columns the minimap spans. Anything past it is cut off, as a line is by the minimap's edge. */
export const STRIP_COLUMNS = 100;

/** Must match the `tab-size` text is rendered with. */
const TAB_SIZE = 4;

/**
 * The leading whitespace and overall length of some text, in columns with tabs
 * expanded. Only the first `STRIP_COLUMNS` columns are looked at, so a line megabytes
 * long costs no more to measure than a short one.
 */
export function measureText(parts: string | Iterable<string>): { indent: number; length: number } {
	let column = 0;
	let indent = -1;
	for (const part of typeof parts === 'string' ? [parts] : parts) {
		for (const char of part) {
			if (column >= STRIP_COLUMNS) return { indent: indent < 0 ? column : indent, length: column };
			const blank = char === ' ' || char === '\t';
			if (!blank && indent < 0) indent = column;
			column += char === '\t' ? TAB_SIZE - (column % TAB_SIZE) : 1;
		}
	}
	// A line of nothing but whitespace draws nothing.
	return indent < 0 ? { indent: 0, length: 0 } : { indent, length: column };
}
