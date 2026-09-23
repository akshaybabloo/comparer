import { describe, expect, it } from 'vitest';
import { addRecent, parseRecent, resolvePaths, type RecentComparison } from './launch';

describe('resolvePaths', () => {
	const dev = { packaged: false, appPath: '/src/comparer', cwd: '/src/comparer' };
	const packaged = { packaged: true, appPath: '/opt/comparer/resources/app.asar', cwd: '/home/me/project' };

	it('skips flags and the app itself in a development run', () => {
		expect(resolvePaths(['--inspect', '--no-sandbox', '.'], dev)).toEqual([]);
		expect(resolvePaths(['--no-sandbox', 'a.txt', 'b.txt', '.'], dev)).toEqual([
			'/src/comparer/a.txt',
			'/src/comparer/b.txt'
		]);
	});

	it('resolves relative paths against the working directory, keeping absolute ones', () => {
		expect(resolvePaths(['old/file.txt', '/tmp/new.txt'], packaged)).toEqual([
			'/home/me/project/old/file.txt',
			'/tmp/new.txt'
		]);
		// A packaged app has no app path argument, so `.` is the working directory.
		expect(resolvePaths(['.', '../other'], packaged)).toEqual(['/home/me/project', '/home/me/other']);
	});

	it('takes at most two paths', () => {
		expect(resolvePaths(['a', 'b', 'c'], packaged)).toHaveLength(2);
	});
});

describe('recent comparisons', () => {
	const entry = (left: string, at: number): Omit<RecentComparison, 'id'> => ({ kind: 'file', left, right: 'r', at });

	it('puts the newest first, moves a repeat to the top, and keeps the limit', () => {
		let list: RecentComparison[] = [];
		list = addRecent(list, entry('a', 1));
		list = addRecent(list, entry('b', 2));
		list = addRecent(list, entry('a', 3));
		expect(list.map((item) => [item.left, item.at])).toEqual([
			['a', 3],
			['b', 2]
		]);
		for (let i = 0; i < 20; i++) list = addRecent(list, entry(`x${i}`, i), 5);
		expect(list).toHaveLength(5);
		expect(list[0].left).toBe('x19');
	});

	it('reads back only well-formed entries', () => {
		const good = addRecent([], entry('a', 1));
		expect(parseRecent(JSON.stringify([...good, { id: 1 }, null, 'x']))).toEqual(good);
		expect(parseRecent('not json')).toEqual([]);
		expect(parseRecent('{}')).toEqual([]);
	});
});
