import { describe, expect, it } from 'vitest';
import { measureText, STRIP_COLUMNS } from './minimap';

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
