import type { ChangeReason, ChangeStatus, EntryKind, TreeNode } from 'comparer-ts';

/**
 * Pure tree shaping for `FolderTree.svelte`, kept out of the component so the
 * windowed list only ever deals with a flat array of rows.
 */

export type TreeRow = {
	node: TreeNode;
	depth: number;
	/** Has children to show, so it gets a chevron. */
	expandable: boolean;
	expanded: boolean;
};

/**
 * Folders that start open: those with a change somewhere inside, so every
 * change is on screen without a click. An added or deleted folder stays shut —
 * everything inside it has that same status, so opening it shows nothing new
 * while potentially flooding the list with a whole `node_modules`.
 */
export function initiallyExpanded(entries: TreeNode[]): Set<string> {
	const expanded = new Set<string>();
	const visit = (nodes: TreeNode[]) => {
		for (const node of nodes) {
			if (node.children.length === 0 || !node.has_changes) continue;
			if (node.status === 'added' || node.status === 'deleted') continue;
			expanded.add(node.path);
			visit(node.children);
		}
	};
	visit(entries);
	return expanded;
}

/** Flattens the open part of the tree, in display order. */
export function visibleRows(entries: TreeNode[], expanded: ReadonlySet<string>, hideUnchanged: boolean): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (nodes: TreeNode[], depth: number) => {
		for (const node of nodes) {
			// `has_changes` covers the node and everything inside it, so a folder
			// holding a single change survives the filter along with that change.
			if (hideUnchanged && !node.has_changes) continue;
			const expandable = node.children.length > 0;
			const open = expandable && expanded.has(node.path);
			rows.push({ node, depth, expandable, expanded: open });
			if (open) walk(node.children, depth + 1);
		}
	};
	walk(entries, 0);
	return rows;
}

/**
 * Whether a node's error concerns this side. An entry on both sides carries
 * its errors prefixed `left:` or `right:`; one on a single side needs no prefix,
 * since there is only one side it can be about.
 */
export function hasErrorOn(node: TreeNode, side: 'left' | 'right'): boolean {
	if (!node.error) return false;
	if (node.status === 'deleted') return side === 'left';
	if (node.status === 'added') return side === 'right';
	return side === 'left' ? node.error.startsWith('left: ') : node.error.includes('right: ');
}

/** The kind shown for a node: what it is now, or what it was if it is gone. */
export function displayKind(node: TreeNode): EntryKind {
	return node.right_kind ?? node.left_kind ?? 'file';
}

export function isFolderNode(node: TreeNode): boolean {
	return node.left_kind === 'dir' || node.right_kind === 'dir';
}

export const STATUS_LETTER: Record<ChangeStatus, string> = {
	added: 'A',
	deleted: 'D',
	modified: 'M',
	unchanged: '',
	unknown: '?'
};

const STATUS_LABEL: Record<ChangeStatus, string> = {
	added: 'Added',
	deleted: 'Deleted',
	modified: 'Modified',
	unchanged: 'Unchanged',
	unknown: 'Could not compare'
};

const KIND_LABEL: Record<EntryKind, string> = {
	file: 'file',
	dir: 'folder',
	symlink: 'symlink',
	other: 'special file'
};

const REASON_LABEL: Record<ChangeReason, string> = {
	kind: 'type',
	content: 'content',
	size: 'size',
	permissions: 'permissions',
	owner: 'owner',
	modified_time: 'modified time',
	link_target: 'link target'
};

/** "file → folder", for an entry whose type changed. */
export function kindChange(node: TreeNode): string | null {
	if (!node.reasons.includes('kind') || !node.left_kind || !node.right_kind) return null;
	if (node.left_kind === node.right_kind) return `${KIND_LABEL[node.left_kind]} type changed`;
	return `${KIND_LABEL[node.left_kind]} → ${KIND_LABEL[node.right_kind]}`;
}

/**
 * A modified file on both sides, which is the one kind of entry with two
 * versions to diff. Added and deleted files have only one side, and a type
 * change has nothing comparable on the other.
 */
export function canOpen(node: TreeNode): boolean {
	return node.status === 'modified' && node.left_kind === 'file' && node.right_kind === 'file';
}

/** "Modified: content, permissions" — the status and, for a change, why. */
export function changeSummary(node: TreeNode): string {
	const status = STATUS_LABEL[node.status];
	if (node.status !== 'modified') return status;
	return `${status}: ${node.reasons.map((reason) => (reason === 'kind' ? kindChange(node) : REASON_LABEL[reason])).join(', ')}`;
}

/** Tooltip text: the status, why it changed, and any error. */
export function describeNode(node: TreeNode): string {
	const lines = [node.path, changeSummary(node)];
	if (node.status === 'unchanged' && node.has_changes) lines.push('Contains changes');
	if (node.error) lines.push(node.error);
	if (canOpen(node)) lines.push('Double-click to compare');
	return lines.join('\n');
}
