import { describe, expect, it } from 'vitest';
import { measureText, stripBox, STRIP_COLUMNS } from './minimap';

describe('measureText', () => {
	it('finds where the text starts and ends', () => {
		expect(measureText('    return x;')).toEqual({ indent: 4, length: 13 });
	});

	it('expands tabs to the next tab stop', () => {
		expect(measureText('\tx')).toEqual({ indent: 4, length: 5 });
		expect(measureText('ab\tc')).toEqual({ indent: 0, length: 5 });
	});

	it('draws nothing for a blank or whitespace-only line', () => {
		expect(measureText('')).toEqual({ indent: 0, length: 0 });
		expect(measureText('   \t ')).toEqual({ indent: 0, length: 0 });
	});

	it('measures across parts, as the segments of a diff row', () => {
		expect(measureText(['  foo', 'bar'])).toEqual({ indent: 2, length: 8 });
	});

	it('stops at the minimap edge however long the line', () => {
		expect(measureText('x'.repeat(1_000_000))).toEqual({ indent: 0, length: STRIP_COLUMNS });
		expect(measureText(' '.repeat(STRIP_COLUMNS + 10) + 'late')).toEqual({
			indent: STRIP_COLUMNS,
			length: STRIP_COLUMNS
		});
	});
});

describe('stripBox', () => {
	// A 773px minimap over the 462,440px the wash2 pair comes to: one window of content
	// is 1.3 minimap pixels, so every box is widened to the 16px minimum.
	const LONG = { scale: 773 / 462_440, height: 773, view: 773, min: 16 };

	it('keeps the box inside the strip at the end of a long file', () => {
		const start = 462_440 - LONG.view;
		const box = stripBox(LONG.scale, LONG.height, start, start + LONG.view, LONG.min);

		expect(box.height).toBe(16);
		expect(box.top + box.height).toBeCloseTo(LONG.height);
	});

	it('never leaves the strip at any scroll position', () => {
		for (let i = 0; i <= 20; i++) {
			const start = ((462_440 - LONG.view) * i) / 20;
			const box = stripBox(LONG.scale, LONG.height, start, start + LONG.view, LONG.min);

			expect(box.top).toBeGreaterThanOrEqual(0);
			expect(box.top + box.height).toBeLessThanOrEqual(LONG.height + 0.001);
		}
	});

	it('follows the view where the box is bigger than the minimum', () => {
		expect(stripBox(0.15, 400, 0, 1000, 16)).toEqual({ top: 0, height: 150 });
		expect(stripBox(0.15, 400, 1000, 2000, 16)).toEqual({ top: 150, height: 150 });
	});

	it('gives a box no taller than the strip, however little content there is', () => {
		expect(stripBox(0, 10, 0, 0, 16)).toEqual({ top: 0, height: 10 });
	});
});
