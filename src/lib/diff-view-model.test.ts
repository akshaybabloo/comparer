import { describe, expect, it } from 'vitest';
import type { DiffHunk, DiffRow, DiffTag } from './diff-types';
import {
	changeRange,
	changeStarts,
	filterRows,
	findMatches,
	highlightParts,
	renderSegments,
	sliceByColumns,
	toSplitRows,
	toUnifiedRows
} from './diff-view-model';

let line = 0;

function row(tag: DiffTag, text: string, emphasized: [number, number] | null = null): DiffRow {
	line++;
	const segments = emphasized
		? [
				{ emphasized: false, value: text.slice(0, emphasized[0]) },
				{ emphasized: true, value: text.slice(emphasized[0], emphasized[1]) },
				{ emphasized: false, value: text.slice(emphasized[1]) }
			].filter((segment) => segment.value)
		: [{ emphasized: false, value: text }];
	return {
		tag,
		oldLine: tag === 'insert' ? null : line,
		newLine: tag === 'delete' ? null : line,
		segments,
		missingNewline: false
	};
}

/** equal a, delete b, insert B, insert C, equal d, delete e, equal f */
function sample(): DiffHunk[] {
	return [
		{
			collapsedBefore: 0,
			rows: [
				row('equal', 'alpha'),
				row('delete', 'bravo'),
				row('insert', 'Bravo'),
				row('insert', 'charlie'),
				row('equal', 'delta'),
				row('delete', 'echo'),
				row('equal', 'foxtrot')
			]
		}
	];
}

describe('filterRows', () => {
	it('returns every row for All', () => {
		const rows = toUnifiedRows(sample());
		expect(filterRows(rows, 'all')).toBe(rows);
	});

	it('collapses changed lines for Similar, counting each changed line', () => {
		const shown = filterRows(toUnifiedRows(sample()), 'similar');
		expect(shown.map((item) => (item.kind === 'collapsed' ? `${item.count} ${item.hidden}` : item.kind))).toEqual([
			'row',
			'3 different',
			'row',
			'1 different',
			'row'
		]);
	});

	it('counts the same hidden lines side by side as unified', () => {
		const counts = (rows: ReturnType<typeof toUnifiedRows>) =>
			filterRows(rows, 'similar').flatMap((item) => (item.kind === 'collapsed' ? [item.count] : []));
		const hunks = sample();
		expect(counts(toSplitRows(hunks))).toEqual(counts(toUnifiedRows(hunks)));
	});

	it('collapses similar lines for Different, merging a hunk gap into the run', () => {
		const hunks: DiffHunk[] = [
			{ collapsedBefore: 0, rows: [row('delete', 'a')] },
			{ collapsedBefore: 5, rows: [row('equal', 'b'), row('insert', 'c')] }
		];
		const shown = filterRows(toSplitRows(hunks), 'different');
		expect(shown.map((item) => (item.kind === 'collapsed' ? `${item.count} ${item.hidden}` : item.kind))).toEqual([
			'pair',
			'6 similar',
			'pair'
		]);
		expect(new Set(shown.map((item) => item.key)).size).toBe(shown.length);
	});
});

describe('changeStarts', () => {
	it('treats a deletion and the insertions after it as one change', () => {
		const rows = toUnifiedRows(sample());
		expect(changeStarts(rows)).toEqual([1, 5]);
		expect(changeStarts(toSplitRows(sample()))).toEqual([1, 4]);
	});

	it('uses the hidden-difference rows under the Similar filter', () => {
		const rows = filterRows(toUnifiedRows(sample()), 'similar');
		expect(changeStarts(rows)).toEqual([1, 3]);
	});
});

describe('findMatches', () => {
	it('finds case-insensitive matches in reading order', () => {
		const matches = findMatches(toUnifiedRows(sample()), 'BRAVO');
		expect(matches).toEqual([
			{ index: 1, side: 'row', start: 0, end: 5 },
			{ index: 2, side: 'row', start: 0, end: 5 }
		]);
	});

	it('counts an unchanged line once side by side, and each side of a changed pair', () => {
		const rows = toSplitRows(sample());
		expect(findMatches(rows, 'alpha')).toEqual([{ index: 0, side: 'both', start: 0, end: 5 }]);
		expect(findMatches(rows, 'ravo').map((match) => match.side)).toEqual(['left', 'right']);
	});

	it('treats the query as plain text and stops at the limit', () => {
		const rows = toUnifiedRows([{ collapsedBefore: 0, rows: [row('equal', 'a.b a.b axb (a.b)')] }]);
		expect(findMatches(rows, 'a.b')).toHaveLength(3);
		expect(findMatches(rows, 'a.b', 2)).toHaveLength(2);
		expect(findMatches(rows, '')).toEqual([]);
	});
});

describe('rendered parts', () => {
	it('carry their offset within the row', () => {
		const changed = row('insert', 'hello world', [6, 11]);
		expect(renderSegments(changed).parts.map((part) => part.start)).toEqual([0, 6]);
		expect(sliceByColumns(changed, 4, 8).map((part) => [part.start, part.value])).toEqual([
			[4, 'o '],
			[6, 'wo']
		]);
	});

	it('split around search highlights, across emphasized segments', () => {
		const parts = renderSegments(row('insert', 'hello world', [6, 11])).parts;
		const pieces = highlightParts(parts, [
			{ start: 4, end: 7, active: true },
			{ start: 9, end: 10, active: false }
		]);
		expect(pieces.map((piece) => `${piece.value}|${piece.emphasized ? 'e' : ''}|${piece.match}`)).toEqual([
			'hell||none',
			'o ||active',
			'w|e|active',
			'or|e|none',
			'l|e|match',
			'd|e|none'
		]);
		expect(pieces.map((piece) => piece.value).join('')).toBe('hello world');
	});
});

describe('changeRange', () => {
	const flat = (hunks: DiffHunk[]) => hunks.flatMap((hunk) => hunk.rows);

	it('covers the deletions and insertions of one change, from any row in it', () => {
		line = 0;
		// alpha=1, bravo=old 2, Bravo=new 2, charlie=new 3, delta=old 3/new 4, echo=old 4, foxtrot=old 5/new 5
		const rows = flat([
			{
				collapsedBefore: 0,
				rows: [
					{ ...row('equal', 'alpha'), oldLine: 1, newLine: 1 },
					{ ...row('delete', 'bravo'), oldLine: 2, newLine: null },
					{ ...row('insert', 'Bravo'), oldLine: null, newLine: 2 },
					{ ...row('insert', 'charlie'), oldLine: null, newLine: 3 },
					{ ...row('equal', 'delta'), oldLine: 3, newLine: 4 },
					{ ...row('delete', 'echo'), oldLine: 4, newLine: null },
					{ ...row('equal', 'foxtrot'), oldLine: 5, newLine: 5 }
				]
			}
		]);
		const first = { left: { from: 1, to: 2 }, right: { from: 1, to: 3 } };
		expect(changeRange(rows, 1)).toEqual(first);
		expect(changeRange(rows, 3)).toEqual(first);
		// A deletion only: an empty range on the right, after "delta".
		expect(changeRange(rows, 5)).toEqual({ left: { from: 3, to: 4 }, right: { from: 4, to: 4 } });
	});

	it('places an empty side at the start of the file', () => {
		const rows = [
			{ ...row('insert', 'new'), oldLine: null, newLine: 1 },
			{ ...row('equal', 'same'), oldLine: 1, newLine: 2 }
		];
		expect(changeRange(rows, 0)).toEqual({ left: { from: 0, to: 0 }, right: { from: 0, to: 1 } });
	});
});
