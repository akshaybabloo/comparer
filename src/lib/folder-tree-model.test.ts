import type { ChangeStatus, EntryKind, TreeNode } from 'comparer-ts';
import { describe, expect, it } from 'vitest';
import {
	ALL_CHANGES,
	ancestorPaths,
	initiallyExpanded,
	jumpTargets,
	treeOrder,
	visibleRows,
	type ShownChange
} from './folder-tree-model';

function node(path: string, status: ChangeStatus, children: TreeNode[] = [], kind?: EntryKind): TreeNode {
	const resolved: EntryKind = kind ?? (children.length > 0 ? 'dir' : 'file');
	return {
		name: path.split('/').at(-1)!,
		path,
		left_kind: status === 'added' ? null : resolved,
		right_kind: status === 'deleted' ? null : resolved,
		status,
		reasons: status === 'modified' ? ['modified_time'] : [],
		has_changes: status !== 'unchanged' || children.some((child) => child.has_changes),
		children
	};
}

/**
 * src/ (modified folder)
 *   a.ts (modified)
 *   b.ts (unchanged)
 *   new/ (added folder) → x.ts (added)
 * docs/ (unchanged folder) → old.md (deleted)
 * same/ (unchanged folder) → c.ts (unchanged)
 * README.md (added)
 */
function sample(): TreeNode[] {
	return [
		node('src', 'modified', [
			node('src/a.ts', 'modified'),
			node('src/b.ts', 'unchanged'),
			node('src/new', 'added', [node('src/new/x.ts', 'added')])
		]),
		node('docs', 'unchanged', [node('docs/old.md', 'deleted')]),
		node('same', 'unchanged', [node('same/c.ts', 'unchanged')]),
		node('README.md', 'added')
	];
}

const everything = (entries: TreeNode[]) => new Set(treeOrder(entries).keys());
const paths = (rows: { node: TreeNode }[]) => rows.map((row) => row.node.path);

describe('visibleRows', () => {
	it('shows the open part of the tree in order', () => {
		const entries = sample();
		expect(paths(visibleRows(entries, initiallyExpanded(entries), false))).toEqual([
			'src',
			'src/a.ts',
			'src/b.ts',
			'src/new',
			'docs',
			'docs/old.md',
			'same',
			'README.md'
		]);
	});

	it('hides unchanged entries with nothing changed inside', () => {
		const entries = sample();
		expect(paths(visibleRows(entries, everything(entries), true))).toEqual([
			'src',
			'src/a.ts',
			'src/new',
			'src/new/x.ts',
			'docs',
			'docs/old.md',
			'README.md'
		]);
	});

	it('shows only the chosen changes, keeping folders on the way to them', () => {
		const entries = sample();
		const added = new Set<ShownChange>(['added']);
		expect(paths(visibleRows(entries, everything(entries), true, added))).toEqual([
			'src',
			'src/new',
			'src/new/x.ts',
			'README.md'
		]);
		const deleted = new Set<ShownChange>(['deleted']);
		expect(paths(visibleRows(entries, everything(entries), true, deleted))).toEqual(['docs', 'docs/old.md']);
		// Unchanged entries still show while Hide unchanged is off.
		expect(paths(visibleRows(entries, everything(entries), false, deleted))).toEqual([
			'docs',
			'docs/old.md',
			'same',
			'same/c.ts'
		]);
	});

	it('always shows entries that could not be compared', () => {
		const entries = [node('broken', 'unknown'), node('gone', 'deleted')];
		const added = new Set<ShownChange>(['added']);
		expect(paths(visibleRows(entries, new Set(), true, added))).toEqual(['broken']);
	});
});

describe('jumpTargets', () => {
	it('stops at each change, skipping modified folders and the inside of added folders', () => {
		expect(jumpTargets(sample()).map((target) => target.path)).toEqual([
			'src/a.ts',
			'src/new',
			'docs/old.md',
			'README.md'
		]);
	});

	it('follows the filter', () => {
		const modified = new Set<ShownChange>(['modified']);
		expect(jumpTargets(sample(), modified).map((target) => target.path)).toEqual(['src/a.ts']);
		expect(jumpTargets(sample(), ALL_CHANGES)).toHaveLength(4);
	});
});

describe('treeOrder and ancestorPaths', () => {
	it('orders every node as if the whole tree were open', () => {
		const order = treeOrder(sample());
		expect(order.get('src/new/x.ts')).toBeLessThan(order.get('docs')!);
		expect(order.size).toBe(10);
	});

	it('lists the folders above a path, outermost first', () => {
		expect(ancestorPaths('a/b/c.txt')).toEqual(['a', 'a/b']);
		expect(ancestorPaths('top.txt')).toEqual([]);
	});
});
