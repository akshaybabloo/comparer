import { describe, expect, it } from 'vitest';
import { chunksFromLines, mapLine, trimLines } from './line-alignment';

const tags = (text: string) =>
	[...text].map((char) => ({ tag: { '=': 'equal', '-': 'delete', '+': 'insert' }[char]! }));

describe('trimLines', () => {
	it('trims every line but keeps the line count', () => {
		expect(trimLines('  a\n\tb  \n\n    c')).toBe('a\nb\n\nc');
	});
});

describe('chunksFromLines', () => {
	it('folds each run of deletions and insertions into one chunk', () => {
		expect(chunksFromLines(tags('==--+==+'))).toEqual([
			{ leftStart: 2, leftEnd: 4, rightStart: 2, rightEnd: 3 },
			{ leftStart: 6, leftEnd: 6, rightStart: 5, rightEnd: 6 }
		]);
	});

	it('has no chunks for identical texts', () => {
		expect(chunksFromLines(tags('====='))).toEqual([]);
	});
});

describe('mapLine', () => {
	// Left lines 2–3 were replaced by right line 2; right line 5 was inserted.
	const chunks = chunksFromLines(tags('==--+==+=='));

	it('maps lines before any change straight across', () => {
		expect(mapLine(chunks, 1.5, 'left')).toBe(1.5);
	});

	it('offsets lines after a change by what it added or removed', () => {
		// Left line 4 is the first equal line after the change, matching right line 3.
		expect(mapLine(chunks, 4, 'left')).toBe(3);
		expect(mapLine(chunks, 3, 'right')).toBe(4);
		expect(mapLine(chunks, 8, 'right')).toBe(8);
	});

	it('moves proportionally through a changed chunk', () => {
		expect(mapLine(chunks, 3, 'left')).toBe(2.5);
		expect(mapLine(chunks, 2.5, 'right')).toBe(3);
	});

	it('waits at an insertion the other side has no lines for', () => {
		// Right line 5 was inserted: the left holds at line 6 across it.
		expect(mapLine(chunks, 5, 'right')).toBe(6);
		expect(mapLine(chunks, 5.5, 'right')).toBe(6);
	});
});
