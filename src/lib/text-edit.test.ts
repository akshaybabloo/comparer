import { describe, expect, it } from 'vitest';
import { replaceLines } from './text-edit';

describe('replaceLines', () => {
	const left = 'one\ntwo\nthree\nfour\n';

	it('replaces a changed line with the other side’s', () => {
		const right = 'one\nTWO\nthree\nfour\n';
		expect(replaceLines(right, left, { from: 1, to: 2 }, { from: 1, to: 2 })).toBe(left);
	});

	it('inserts lines the target lacks, and deletes lines the source lacks', () => {
		const shorter = 'one\nfour\n';
		expect(replaceLines(shorter, left, { from: 1, to: 1 }, { from: 1, to: 3 })).toBe(left);
		expect(replaceLines(left, shorter, { from: 1, to: 3 }, { from: 1, to: 1 })).toBe(shorter);
	});

	it('inserts at the very start and the very end', () => {
		expect(replaceLines('b\n', 'a\nb\n', { from: 0, to: 0 }, { from: 0, to: 1 })).toBe('a\nb\n');
		expect(replaceLines('a\n', 'a\nb\n', { from: 1, to: 1 }, { from: 1, to: 2 })).toBe('a\nb\n');
		expect(replaceLines('', 'a\nb\n', { from: 0, to: 0 }, { from: 0, to: 2 })).toBe('a\nb\n');
	});

	it('keeps a target without a final newline that way', () => {
		// Appending after a last line with no newline.
		expect(replaceLines('a', 'a\nb\nc\n', { from: 1, to: 1 }, { from: 1, to: 2 })).toBe('a\nb');
		// Replacing that last line.
		expect(replaceLines('a\nx', 'a\ny\nz\n', { from: 1, to: 2 }, { from: 1, to: 2 })).toBe('a\ny');
		// Deleting it.
		expect(replaceLines('a\nx', 'a\n', { from: 1, to: 2 }, { from: 1, to: 1 })).toBe('a');
	});

	it('gives a copied last line without a newline one when it lands mid-file', () => {
		expect(replaceLines('a\nOLD\nc\n', 'z\nnew', { from: 1, to: 2 }, { from: 1, to: 2 })).toBe('a\nnew\nc\n');
	});

	it('converts copied lines to the target’s line endings', () => {
		expect(replaceLines('a\r\nOLD\r\nc\r\n', 'a\nnew\nc\n', { from: 1, to: 2 }, { from: 1, to: 2 })).toBe(
			'a\r\nnew\r\nc\r\n'
		);
		expect(replaceLines('a\nOLD\nc\n', 'a\r\nnew\r\nc\r\n', { from: 1, to: 2 }, { from: 1, to: 2 })).toBe(
			'a\nnew\nc\n'
		);
	});
});
