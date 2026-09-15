import { describe, expect, it } from 'vitest';
import type { DiffRow, DiffTag } from './diff-types';
import { toHtmlReport, toPatch } from './export';

/** Rows for two texts given as `[tag, text]`, numbered as the diff engine would. */
function rows(lines: [DiffTag, string][], missingNewlineAt = -1): DiffRow[] {
	let oldLine = 0;
	let newLine = 0;
	return lines.map(([tag, text], index) => ({
		tag,
		oldLine: tag === 'insert' ? null : ++oldLine,
		newLine: tag === 'delete' ? null : ++newLine,
		segments: text ? [{ emphasized: false, value: text }] : [],
		missingNewline: index === missingNewlineAt
	}));
}

const labels = { left: 'old.txt', right: 'new.txt' };

describe('toPatch', () => {
	it('writes hunks with three lines of context and correct ranges', () => {
		const lines: [DiffTag, string][] = [];
		// Changes at line 5 and after line 14, with six unchanged lines between their context.
		for (let i = 1; i <= 14; i++) lines.push(['equal', `line ${i}`]);
		lines.splice(4, 1, ['delete', 'line 5'], ['insert', 'line five']);
		lines.push(['insert', 'line 15']);
		expect(toPatch(rows(lines), labels)).toBe(
			[
				'--- a/old.txt',
				'+++ b/new.txt',
				'@@ -2,7 +2,7 @@',
				' line 2',
				' line 3',
				' line 4',
				'-line 5',
				'+line five',
				' line 6',
				' line 7',
				' line 8',
				'@@ -12,3 +12,4 @@',
				' line 12',
				' line 13',
				' line 14',
				'+line 15',
				''
			].join('\n')
		);
	});

	it('merges changes whose context overlaps into one hunk', () => {
		const patch = toPatch(
			rows([
				['equal', 'a'],
				['delete', 'b'],
				['equal', 'c'],
				['equal', 'd'],
				['insert', 'e']
			]),
			labels
		);
		expect(patch.match(/^@@/gm)).toHaveLength(1);
		expect(patch).toContain('@@ -1,4 +1,4 @@');
	});

	it('names the line before an empty side, and marks a missing final newline', () => {
		expect(toPatch(rows([['insert', 'first']]), labels)).toContain('@@ -0,0 +1 @@');
		const patch = toPatch(
			rows(
				[
					['insert', 'first'],
					['equal', 'only']
				],
				1
			),
			labels
		);
		expect(patch).toContain('@@ -1 +1,2 @@');
		expect(patch.endsWith(' only\n\\ No newline at end of file\n')).toBe(true);
	});

	it('is empty when nothing changed', () => {
		expect(toPatch(rows([['equal', 'same']]), labels)).toBe('');
	});
});

describe('toHtmlReport', () => {
	it('escapes the text and summarises the change', () => {
		const html = toHtmlReport(
			rows([
				['equal', 'keep'],
				['delete', '<script>alert(1)</script>'],
				['insert', 'a & b']
			]),
			{ left: 'x<y>.html', right: 'b.html' }
		);
		expect(html).not.toContain('<script>alert');
		expect(html).toContain('&#60;script&#62;');
		expect(html).toContain('a &#38; b');
		expect(html).toContain('<title>x&#60;y&#62;.html → b.html</title>');
		expect(html).toContain('+1</span> <span class="del-count">−1');
	});

	it('collapses unchanged lines beyond the context into a gap row', () => {
		const lines: [DiffTag, string][] = [['delete', 'gone']];
		for (let i = 0; i < 10; i++) lines.push(['equal', `same ${i}`]);
		const html = toHtmlReport(rows(lines), labels);
		expect(html).toContain('7 unchanged lines');
		expect(html.match(/<tr class="equal">/g)).toHaveLength(3);
	});
});
