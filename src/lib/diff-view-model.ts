import type { DiffHunk, DiffRow } from './diff-types';
import type { ChangeKind } from './line-alignment';
import type { ChangeRange } from './text-edit';

export type VisualRow =
	/**
	 * Stands in for lines left out: equal lines omitted between two hunks, or
	 * lines hidden by the Show filter. `hidden` says which kind they were.
	 */
	| { kind: 'collapsed'; key: string; count: number; hidden: 'similar' | 'different' }
	/** Unified: one source line. */
	| { kind: 'row'; key: string; row: DiffRow }
	/** Split: the same line on both sides, either of which may be absent. */
	| { kind: 'pair'; key: string; left: DiffRow | null; right: DiffRow | null };

/** Must match the `tab-size` the rows are rendered with. */
export const TAB_SIZE = 4;

export type RenderedPart = {
	kind: 'text';
	emphasized: boolean;
	value: string;
	/** Character offset of `value` within its row, so search matches can be placed on it. */
	start: number;
};

export type RenderedLine = {
	parts: RenderedPart[];
};

/**
 * How many monospace columns a row occupies once tabs are expanded.
 *
 * The font is monospace, so this is enough to work out how many lines a row
 * wraps to without measuring anything in the DOM — which matters because the
 * height of every row has to be known to virtualise the list, including the
 * ones currently scrolled out of view.
 */
const columnCache = new WeakMap<DiffRow, number>();
const tabCache = new WeakMap<DiffRow, boolean>();

/**
 * Whether the row contains tabs, whose width depends on the column they start
 * at. Cached: answering it means scanning the row, and a row can be megabytes.
 */
export function hasTabs(row: DiffRow): boolean {
	const cached = tabCache.get(row);
	if (cached !== undefined) return cached;
	let found = false;
	for (const segment of row.segments) {
		if (segment.value.includes('\t')) {
			found = true;
			break;
		}
	}
	tabCache.set(row, found);
	return found;
}

export function columnsOf(row: DiffRow | null): number {
	if (!row) return 0;
	const cached = columnCache.get(row);
	if (cached !== undefined) return cached;

	let columns = 0;
	if (hasTabs(row)) {
		for (const segment of row.segments) {
			for (const char of segment.value) {
				columns += char === '\t' ? TAB_SIZE - (columns % TAB_SIZE) : 1;
			}
		}
	} else {
		// Without tabs a character is a column, so summing lengths is enough — and
		// that keeps this cheap across hundreds of thousands of rows.
		for (const segment of row.segments) columns += segment.value.length;
	}

	columnCache.set(row, columns);
	return columns;
}

/**
 * The part of a row lying between two columns.
 *
 * This is what makes a single enormous line scrollable: a 10 MB line with no
 * newlines is one row, so row-level windowing has nothing to choose between
 * and the whole thing lands in the DOM. Slicing it by column lets the view
 * render only the wrapped lines actually on screen.
 *
 * Only valid for rows without tabs, where a column is a character — see
 * `hasTabs`.
 */
export function sliceByColumns(row: DiffRow, from: number, to: number): RenderedPart[] {
	const parts: RenderedPart[] = [];
	let offset = 0;

	for (const segment of row.segments) {
		const start = offset;
		const end = start + segment.value.length;
		offset = end;

		if (end <= from) continue;
		if (start >= to) break;

		const sliceStart = Math.max(0, from - start);
		parts.push({
			kind: 'text',
			emphasized: segment.emphasized,
			value: segment.value.slice(sliceStart, Math.min(segment.value.length, to - start)),
			start: start + sliceStart
		});
	}

	return parts;
}

/** Every segment of the row, in full — nothing is clipped or hidden. */
export function renderSegments(row: DiffRow): RenderedLine {
	let start = 0;
	return {
		parts: row.segments.map((segment) => {
			const part = { kind: 'text' as const, emphasized: segment.emphasized, value: segment.value, start };
			start += segment.value.length;
			return part;
		})
	};
}

/** One row per source line, deletions immediately before their insertions. */
export function toUnifiedRows(hunks: DiffHunk[]): VisualRow[] {
	const out: VisualRow[] = [];
	hunks.forEach((hunk, hunkIndex) => {
		if (hunk.collapsedBefore > 0) {
			out.push({ kind: 'collapsed', key: `c${hunkIndex}`, count: hunk.collapsedBefore, hidden: 'similar' });
		}
		hunk.rows.forEach((row, rowIndex) => {
			out.push({ kind: 'row', key: `${hunkIndex}:${rowIndex}`, row });
		});
	});
	return out;
}

/**
 * Two columns. Consecutive deletions and insertions are zipped so an edited
 * line sits opposite the line it replaced; an unmatched surplus on either side
 * gets a blank cell facing it.
 */
export function toSplitRows(hunks: DiffHunk[]): VisualRow[] {
	const out: VisualRow[] = [];

	hunks.forEach((hunk, hunkIndex) => {
		if (hunk.collapsedBefore > 0) {
			out.push({ kind: 'collapsed', key: `c${hunkIndex}`, count: hunk.collapsedBefore, hidden: 'similar' });
		}

		const rows = hunk.rows;
		let i = 0;
		let pairIndex = 0;

		while (i < rows.length) {
			if (rows[i].tag === 'equal') {
				out.push({
					kind: 'pair',
					key: `${hunkIndex}:${pairIndex++}`,
					left: rows[i],
					right: rows[i]
				});
				i++;
				continue;
			}

			// Gather the whole delete/insert block, then zip the two sides.
			const deletions: DiffRow[] = [];
			const insertions: DiffRow[] = [];
			while (i < rows.length && rows[i].tag !== 'equal') {
				if (rows[i].tag === 'delete') deletions.push(rows[i]);
				else insertions.push(rows[i]);
				i++;
			}

			const height = Math.max(deletions.length, insertions.length);
			for (let j = 0; j < height; j++) {
				out.push({
					kind: 'pair',
					key: `${hunkIndex}:${pairIndex++}`,
					left: deletions[j] ?? null,
					right: insertions[j] ?? null
				});
			}
		}
	});

	return out;
}

/** Which lines the diff shows: everything, only the lines both sides share, or only the changes. */
export type DiffFilter = 'all' | 'similar' | 'different';

/**
 * How many source lines a row stands for. An equal line is one line shown on
 * both sides; a changed pair counts each side that changed.
 */
function lineCount(item: VisualRow): number {
	if (item.kind === 'collapsed') return item.count;
	if (item.kind === 'row') return 1;
	if (item.left?.tag === 'equal') return 1;
	return (item.left ? 1 : 0) + (item.right ? 1 : 0);
}

function isSimilar(item: VisualRow): boolean {
	if (item.kind === 'collapsed') return item.hidden === 'similar';
	if (item.kind === 'row') return item.row.tag === 'equal';
	return item.left?.tag === 'equal';
}

/**
 * Drops the rows the filter hides. Each run of hidden rows becomes one
 * collapsed row saying how many lines it left out, so the reader can see where
 * something was skipped.
 */
export function filterRows(rows: VisualRow[], filter: DiffFilter): VisualRow[] {
	if (filter === 'all') return rows;
	const keepSimilar = filter === 'similar';
	const hidden = keepSimilar ? 'different' : 'similar';
	const out: VisualRow[] = [];
	let run: Extract<VisualRow, { kind: 'collapsed' }> | null = null;

	for (const item of rows) {
		if (isSimilar(item) === keepSimilar) {
			run = null;
			out.push(item);
			continue;
		}
		if (run) {
			run.count += lineCount(item);
		} else {
			run = { kind: 'collapsed', key: `h${item.key}`, count: lineCount(item), hidden };
			out.push(run);
		}
	}

	return out;
}

/** How a row changed: an insertion, a deletion, or — side by side — a line replaced by another. */
export function changeOf(item: VisualRow): ChangeKind | null {
	if (item.kind === 'collapsed') return null;
	if (item.kind === 'row') return item.row.tag === 'insert' ? 'add' : item.row.tag === 'delete' ? 'del' : null;
	const removed = item.left?.tag === 'delete';
	const added = item.right?.tag === 'insert';
	return removed && added ? 'mod' : removed ? 'del' : added ? 'add' : null;
}

function isChangeRow(item: VisualRow): boolean {
	if (item.kind === 'collapsed') return item.hidden === 'different';
	return changeOf(item) !== null;
}

/**
 * Index of the first row of each change. A change is a run of changed rows of
 * any kind, so a deletion and the insertion replacing it are one change. With
 * the Similar filter the rows standing in for hidden differences are the changes.
 */
export function changeStarts(rows: VisualRow[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (isChangeRow(rows[i]) && (i === 0 || !isChangeRow(rows[i - 1]))) out.push(i);
	}
	return out;
}

/**
 * One occurrence of the search text. `side` is the cell it is in: `row` in the
 * unified view, `left` or `right` side by side, or `both` for an unchanged line,
 * which shows the same text on each side and counts once.
 */
export type SearchMatch = { index: number; side: 'row' | 'left' | 'right' | 'both'; start: number; end: number };

/** More matches than this are not worth counting one by one; the search stops there. */
export const MAX_MATCHES = 10_000;

const textCache = new WeakMap<DiffRow, string>();

function rowText(row: DiffRow): string {
	let text = textCache.get(row);
	if (text === undefined) {
		text = row.segments.map((segment) => segment.value).join('');
		textCache.set(row, text);
	}
	return text;
}

/** Every case-insensitive occurrence of `query` in the rows, in reading order. */
export function findMatches(rows: VisualRow[], query: string, limit = MAX_MATCHES): SearchMatch[] {
	const out: SearchMatch[] = [];
	if (!query) return out;
	// Without the `u` flag, `i` folds case character by character, so match
	// positions stay offsets into the original text.
	const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

	const scan = (text: string, index: number, side: SearchMatch['side']) => {
		pattern.lastIndex = 0;
		for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
			if (out.length >= limit) return;
			out.push({ index, side, start: found.index, end: found.index + found[0].length });
		}
	};

	for (let index = 0; index < rows.length && out.length < limit; index++) {
		const item = rows[index];
		if (item.kind === 'collapsed') continue;
		if (item.kind === 'row') {
			scan(rowText(item.row), index, 'row');
		} else if (item.left && item.left === item.right) {
			scan(rowText(item.left), index, 'both');
		} else {
			if (item.left) scan(rowText(item.left), index, 'left');
			if (item.right) scan(rowText(item.right), index, 'right');
		}
	}
	return out;
}

/** A search match within one cell, in that row's character offsets. */
export type Highlight = { start: number; end: number; active: boolean };

export type HighlightedPart = { emphasized: boolean; value: string; match: 'none' | 'match' | 'active' };

/** Splits rendered parts wherever a search match starts or ends, so matches can be drawn over them. */
export function highlightParts(parts: RenderedPart[], highlights: Highlight[]): HighlightedPart[] {
	if (highlights.length === 0) {
		return parts.map((part) => ({ emphasized: part.emphasized, value: part.value, match: 'none' }));
	}
	const out: HighlightedPart[] = [];
	for (const part of parts) {
		const end = part.start + part.value.length;
		let cursor = part.start;
		for (const highlight of highlights) {
			if (highlight.end <= cursor || highlight.start >= end) continue;
			const from = Math.max(cursor, highlight.start);
			const to = Math.min(end, highlight.end);
			if (from > cursor) {
				out.push({
					emphasized: part.emphasized,
					value: part.value.slice(cursor - part.start, from - part.start),
					match: 'none'
				});
			}
			out.push({
				emphasized: part.emphasized,
				value: part.value.slice(from - part.start, to - part.start),
				match: highlight.active ? 'active' : 'match'
			});
			cursor = to;
		}
		if (cursor < end) {
			out.push({ emphasized: part.emphasized, value: part.value.slice(cursor - part.start), match: 'none' });
		}
	}
	return out;
}

/**
 * The lines on each side taken up by the change containing `rows[at]`, where
 * `rows` are every row of the diff in order. A side with nothing in the change
 * gets an empty range at the point the other side's lines would go.
 */
export function changeRange(rows: DiffRow[], at: number): ChangeRange {
	let start = at;
	while (start > 0 && rows[start - 1].tag !== 'equal') start--;
	let end = at;
	while (end < rows.length && rows[end].tag !== 'equal') end++;

	const block = rows.slice(start, end);
	const deleted = block.filter((row) => row.tag === 'delete');
	const inserted = block.filter((row) => row.tag === 'insert');
	const before = rows[start - 1];
	const after = rows[end];

	// Line numbers are 1-based; ranges count lines from 0.
	const position = (side: 'oldLine' | 'newLine', first: DiffRow | undefined) =>
		first ? first[side]! - 1 : before ? before[side]! : after ? after[side]! - 1 : 0;

	const leftFrom = position('oldLine', deleted[0]);
	const rightFrom = position('newLine', inserted[0]);
	return {
		left: { from: leftFrom, to: leftFrom + deleted.length },
		right: { from: rightFrom, to: rightFrom + inserted.length }
	};
}
