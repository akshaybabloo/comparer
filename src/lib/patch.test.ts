import { describe, expect, it } from 'vitest';
import { parsePatch, patchNote } from './patch';

/**
 * The fixtures are the real output of `diff -u` and `git diff`, pasted as they came,
 * timestamps and all — the point is to read what those tools actually write rather than
 * what the format is remembered to look like.
 */
describe('parsePatch', () => {
	it('reads back both texts, over several hunks', () => {
		const patch = [
			'--- a.txt\t2026-09-22 15:34:56.658793796 +1200',
			'+++ b.txt\t2026-09-22 15:34:56.658793796 +1200',
			'@@ -1,10 +1,10 @@',
			' one',
			' two',
			'-three',
			'+THREE',
			' four',
			' five',
			' six',
			' seven',
			' eight',
			'-nine',
			'+NINE',
			' ten',
			''
		].join('\n');

		expect(parsePatch(patch)).toEqual([
			{
				name: 'b.txt',
				beforeName: 'a.txt',
				afterName: 'b.txt',
				before: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
				after: 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nNINE\nten\n',
				binary: false
			}
		]);
	});

	it('keeps a missing final newline on the side it belongs to', () => {
		const patch = [
			'--- nonl-a.txt\t2026-09-22 15:34:56 +1200',
			'+++ nonl-b.txt\t2026-09-22 15:34:56 +1200',
			'@@ -1,2 +1,2 @@',
			' x',
			'-y',
			'\\ No newline at end of file',
			'+z',
			'\\ No newline at end of file',
			''
		].join('\n');

		expect(parsePatch(patch)).toEqual([
			{
				name: 'nonl-b.txt',
				beforeName: 'nonl-a.txt',
				afterName: 'nonl-b.txt',
				before: 'x\ny',
				after: 'x\nz',
				binary: false
			}
		]);
	});

	// `git diff --cached` over an edit, an addition and a deletion at once.
	it('reads a git patch of several files, with its prefixes and trailers', () => {
		const patch = `diff --git a/keep.txt b/keep.txt
index 85c3040..e50310a 100644
--- a/keep.txt
+++ b/keep.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..374571a
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+added
+lines
diff --git a/removed.txt b/removed.txt
deleted file mode 100644
index 286c5f5..0000000
--- a/removed.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

		expect(parsePatch(patch)).toEqual([
			{
				name: 'keep.txt',
				beforeName: 'keep.txt',
				afterName: 'keep.txt',
				before: 'alpha\nbeta\ngamma\n',
				after: 'alpha\nBETA\ngamma\n',
				binary: false
			},
			// A file that did not exist has no name of its own on that side.
			{
				name: 'new.txt',
				beforeName: 'new.txt',
				afterName: 'new.txt',
				before: '',
				after: 'added\nlines\n',
				binary: false
			},
			{
				name: 'removed.txt',
				beforeName: 'removed.txt',
				afterName: 'removed.txt',
				before: 'gone\n',
				after: '',
				binary: false
			}
		]);
	});

	it('separates patches that were simply concatenated, with no git header between them', () => {
		const patch = [
			'--- one.txt',
			'+++ one.txt',
			'@@ -1 +1 @@',
			'-a',
			'+A',
			'--- two.txt',
			'+++ two.txt',
			'@@ -1 +1 @@',
			'-b',
			'+B',
			''
		].join('\n');

		expect(parsePatch(patch).map((file) => [file.name, file.before, file.after])).toEqual([
			['one.txt', 'a\n', 'A\n'],
			['two.txt', 'b\n', 'B\n']
		]);
	});

	it('marks a binary change, which a patch describes but does not quote', () => {
		const patch = `diff --git a/pic.png b/pic.png
index 694cc8c..e494d0d 100644
Binary files a/pic.png and b/pic.png differ
`;

		expect(parsePatch(patch)).toEqual([
			{ name: 'pic.png', beforeName: 'pic.png', afterName: 'pic.png', before: '', after: '', binary: true }
		]);
	});

	it('keeps an empty line inside a hunk, written bare or as a single space', () => {
		const patch = ['--- x', '+++ x', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+B', ''].join('\n');

		expect(parsePatch(patch)[0]).toMatchObject({ before: 'a\n\nb\n', after: 'a\n\nB\n' });
	});

	it('reads a patch with Windows line endings', () => {
		const patch = ['--- x', '+++ x', '@@ -1 +1 @@', '-a', '+b', ''].join('\r\n');

		expect(parsePatch(patch)[0]).toMatchObject({ before: 'a\n', after: 'b\n' });
	});

	it('ignores prose around a patch, as an email or an issue would have', () => {
		const patch = [
			'Here is the fix, please apply:',
			'',
			'--- x',
			'+++ x',
			'@@ -1 +1 @@',
			'-a',
			'+b',
			'',
			'Thanks!',
			''
		].join('\n');

		expect(parsePatch(patch).map((file) => [file.before, file.after])).toEqual([['a\n', 'b\n']]);
	});

	it('finds no files in text that is not a patch', () => {
		expect(parsePatch('just some notes\nabout nothing\n')).toEqual([]);
		expect(parsePatch('')).toEqual([]);
	});
});

describe('patchNote', () => {
	const file = (name: string, binary = false) => ({
		name,
		beforeName: name,
		afterName: name,
		before: 'a\n',
		after: 'b\n',
		binary
	});

	it('says nothing when the patch is only the file on screen', () => {
		const only = file('one.ts');

		expect(patchNote([only], only)).toBe('');
	});

	it('names the other files the patch changes', () => {
		const files = [file('one.ts'), file('two.ts'), file('three.ts')];

		expect(patchNote(files, files[0])).toBe('Showing one.ts; the patch also changes two.ts, three.ts.');
	});

	it('marks a binary change, which cannot be shown at all', () => {
		const files = [file('one.ts'), file('pic.png', true)];

		expect(patchNote(files, files[0])).toBe('Showing one.ts; the patch also changes pic.png (binary).');
	});

	it('counts the rest once there are too many to name', () => {
		const files = ['one', 'two', 'three', 'four', 'five', 'six'].map((name) => file(`${name}.ts`));

		expect(patchNote(files, files[0])).toBe(
			'Showing one.ts; the patch also changes two.ts, three.ts, four.ts and 2 more.'
		);
	});
});
