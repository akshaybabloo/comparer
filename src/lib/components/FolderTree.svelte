<script lang="ts">
	import ChangeStrip from '$lib/components/ChangeStrip.svelte';
	import type { FolderDiffResult } from '$lib/diff-types';
	import {
		ALL_CHANGES,
		ancestorPaths,
		canOpen,
		describeNode,
		displayKind,
		hasErrorOn,
		initiallyExpanded,
		jumpTargets,
		kindChange,
		STATUS_LETTER,
		treeOrder,
		visibleRows,
		type ShownChange,
		type TreeRow
	} from '$lib/folder-tree-model';
	import { formatCount } from '$lib/format';
	import type { StripLine } from '$lib/minimap';
	import type { ChangeKind, ChangeMark } from '$lib/line-alignment';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileQuestionMarkIcon from '@lucide/svelte/icons/file-question-mark';
	import FileSymlinkIcon from '@lucide/svelte/icons/file-symlink';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { ChangeStatus, EntryKind, TreeNode } from 'comparer-ts';
	import { tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	type Props = {
		result: FolderDiffResult;
		leftName: string;
		rightName: string;
		/** One merged tree, or the two folders side by side, as in the file diff. */
		mode: 'unified' | 'split';
		/** Drop entries with no change in or below them. */
		hideUnchanged: boolean;
		/** Which changes to list; a folder with a listed change inside stays too. */
		shown?: ReadonlySet<ShownChange>;
		/** A modified file was double-clicked, or Enter was pressed on it. */
		onopen?: (node: TreeNode) => void;
	};

	let { result, leftName, rightName, mode, hideUnchanged, shown = ALL_CHANGES, onopen }: Props = $props();

	/** For returning keyboard focus to the tree, such as after closing an opened file. */
	export function focus() {
		viewport?.focus();
	}

	/** Fixed, so the list can be windowed by arithmetic alone. */
	const ROW_HEIGHT = 24;
	/** The sticky column header above the rows, inside the scrolling element. */
	const HEADER_HEIGHT = 32;
	/** Rows rendered beyond the viewport, so fast scrolling does not show gaps. */
	const OVERSCAN = 12;
	const INDENT_PX = 16;

	// Both derive from `result` so a new comparison starts from its own defaults,
	// while staying ordinary state in between: the set is mutated in place, and
	// the selection is reassigned.
	const expanded = $derived(new SvelteSet(initiallyExpanded(result.entries)));
	let selectedPath = $derived<string | null>(result && null);

	const rows = $derived(visibleRows(result.entries, expanded, hideUnchanged, shown));
	const selectedIndex = $derived(rows.findIndex((row) => row.node.path === selectedPath));
	const total = $derived(
		result.stats.added + result.stats.deleted + result.stats.modified + result.stats.unchanged + result.stats.unknown
	);

	let viewport: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportHeight = $state(0);

	const firstVisible = $derived(Math.max(0, Math.floor((scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN));
	const lastVisible = $derived(
		Math.min(rows.length, Math.ceil((scrollTop + viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN)
	);
	const visible = $derived(rows.slice(firstVisible, lastVisible));

	/**
	 * The row at a height in the tree, for the minimap: its name, indented by depth, in
	 * one cell for the merged tree or on whichever halves have the entry side by side.
	 */
	function stripLineAt(y: number): StripLine | null {
		const index = Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT);
		const row = rows[index];
		if (!row) return null;
		const top = HEADER_HEIGHT + index * ROW_HEIGHT;
		const kind = CHANGE[row.node.status] ?? null;
		const cell = (present: boolean) => ({
			indent: row.depth * 2,
			length: present ? row.depth * 2 + 2 + row.node.name.length : 0,
			kind
		});
		const cells =
			mode === 'split' ? [cell(row.node.left_kind !== null), cell(row.node.right_kind !== null)] : [cell(true)];
		return { top, bottom: top + ROW_HEIGHT, cells };
	}

	const CHANGE: Partial<Record<ChangeStatus, ChangeKind>> = {
		added: 'add',
		deleted: 'del',
		modified: 'mod',
		unknown: 'unknown'
	};

	/** Changed rows for the minimap, merged into runs, in pixels down the scrollable area. */
	const marks = $derived.by(() => {
		const out: ChangeMark[] = [];
		for (let i = 0; i < rows.length; i++) {
			const kind = CHANGE[rows[i].node.status];
			if (!kind) continue;
			const start = HEADER_HEIGHT + i * ROW_HEIGHT;
			const last = out.at(-1);
			if (last && last.kind === kind && last.end === start) last.end = start + ROW_HEIGHT;
			else out.push({ start, end: start + ROW_HEIGHT, kind });
		}
		return out;
	});

	// A new result is a new tree: start at the top rather than wherever the last
	// one was scrolled to.
	$effect(() => {
		void result;
		if (viewport) viewport.scrollTop = 0;
		scrollTop = 0;
	});

	function toggle(node: TreeNode) {
		if (expanded.has(node.path)) {
			expanded.delete(node.path);
			// Keep the selection on screen rather than hidden inside the closed folder.
			if (selectedPath?.startsWith(`${node.path}/`)) selectedPath = node.path;
		} else {
			expanded.add(node.path);
		}
	}

	/** Every entry's place in the whole tree, open or not, and the changes Jump stops at. */
	const order = $derived(treeOrder(result.entries));
	const targets = $derived(jumpTargets(result.entries, shown));

	/** Where the selection sits in the whole tree; -1 with nothing selected. */
	const selectedOrder = $derived(selectedPath === null ? -1 : (order.get(selectedPath) ?? -1));

	/** The change a jump in `direction` lands on, or -1 when there is none that way. */
	function jumpTarget(direction: 1 | -1): number {
		if (direction > 0) return targets.findIndex((node) => order.get(node.path)! > selectedOrder);
		return selectedOrder < 0 ? -1 : targets.findLastIndex((node) => order.get(node.path)! < selectedOrder);
	}

	export function canJump(direction: 1 | -1): boolean {
		return jumpTarget(direction) >= 0;
	}

	/** Selects the previous (-1) or next (1) change, opening the folders above it. */
	export async function jump(direction: 1 | -1) {
		const target = targets[jumpTarget(direction)];
		if (!target) return;
		for (const path of ancestorPaths(target.path)) expanded.add(path);
		// Let the list grow to include the opened folders before scrolling to the row.
		selectedPath = target.path;
		await tick();
		select(rows.findIndex((row) => row.node.path === target.path));
		viewport?.focus();
	}

	/** Which change is selected, counting from 1, and how many there are; 0 before the first. */
	export function changeCount(): { current: number; total: number } {
		return {
			current: targets.findLastIndex((node) => order.get(node.path)! <= selectedOrder) + 1,
			total: targets.length
		};
	}

	function select(index: number) {
		const row = rows[index];
		if (!row) return;
		selectedPath = row.node.path;

		// Scroll just far enough to bring the row fully into view, below the
		// sticky header rather than behind it.
		if (!viewport) return;
		const top = index * ROW_HEIGHT;
		if (top < viewport.scrollTop) viewport.scrollTop = top;
		else if (HEADER_HEIGHT + top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
			viewport.scrollTop = HEADER_HEIGHT + top + ROW_HEIGHT - viewport.clientHeight;
		}
	}

	function parentIndex(index: number) {
		const depth = rows[index].depth;
		for (let i = index - 1; i >= 0; i--) {
			if (rows[i].depth < depth) return i;
		}
		return -1;
	}

	/** Arrow keys follow the usual tree conventions, as in a file manager. */
	function onKeydown(event: KeyboardEvent) {
		// Modified arrows belong to the app, such as Alt+↓ jumping to the next change.
		if (rows.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
		const index = selectedIndex;
		const row = rows[index];
		const page = Math.max(1, Math.floor((viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) - 1);

		switch (event.key) {
			case 'ArrowDown':
				select(index < 0 ? 0 : Math.min(rows.length - 1, index + 1));
				break;
			case 'ArrowUp':
				select(index < 0 ? 0 : Math.max(0, index - 1));
				break;
			case 'PageDown':
				select(Math.min(rows.length - 1, Math.max(0, index) + page));
				break;
			case 'PageUp':
				select(Math.max(0, index - page));
				break;
			case 'Home':
				select(0);
				break;
			case 'End':
				select(rows.length - 1);
				break;
			case 'ArrowRight':
				if (!row) select(0);
				else if (row.expandable && !row.expanded) toggle(row.node);
				else if (row.expanded) select(index + 1);
				break;
			case 'ArrowLeft':
				if (!row) break;
				if (row.expanded) toggle(row.node);
				else select(parentIndex(index));
				break;
			case 'Enter':
				if (row?.expandable) toggle(row.node);
				else if (row && canOpen(row.node)) onopen?.(row.node);
				break;
			case ' ':
				if (row?.expandable) toggle(row.node);
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	function inkClass(status: ChangeStatus) {
		if (status === 'added') return 'text-add-ink';
		if (status === 'deleted') return 'text-del-ink';
		if (status === 'modified') return 'text-mod-ink';
		if (status === 'unknown') return 'text-unknown-ink';
		return 'text-muted-foreground';
	}

	function nameClass(node: TreeNode) {
		if (node.status === 'deleted') return 'text-del-ink line-through decoration-del-ink/60';
		// An unchanged folder on the way to a change stays readable, so the path
		// down to each change stands out from the untouched rest of the tree.
		if (node.status === 'unchanged') return node.has_changes ? 'text-foreground' : 'text-muted-foreground';
		return inkClass(node.status);
	}

	/**
	 * The tint behind one side of a split row, mirroring the file diff: red where
	 * something left, green where it arrived, and an empty well on the side where
	 * the entry does not exist.
	 */
	function sideClass(node: TreeNode, kind: EntryKind | null) {
		if (!kind) return 'bg-muted/25 empty-stripes';
		if (node.status === 'added') return 'bg-add-bg/70';
		if (node.status === 'deleted') return 'bg-del-bg/70';
		if (node.status === 'modified') return 'bg-mod-ink/10';
		if (node.status === 'unknown') return 'bg-unknown-ink/10';
		return '';
	}
</script>

<!-- One side of an entry: indent, chevron, icon and name. In unified mode the
     single side stands for both folders. -->
{#snippet entry(row: TreeRow, kind: EntryKind)}
	{@const node = row.node}
	<span class="grid size-4 shrink-0 place-items-center">
		<!-- Only a side that is a folder can be opened; the other side of a type
         change shows its file without a chevron, but opens along with it. -->
		{#if row.expandable && kind === 'dir'}
			<button
				type="button"
				tabindex="-1"
				aria-label={row.expanded ? 'Collapse' : 'Expand'}
				class="grid size-4 place-items-center text-muted-foreground hover:text-foreground"
				onclick={(event) => {
					event.stopPropagation();
					toggle(node);
				}}
			>
				<ChevronRightIcon class="size-3.5 transition-transform {row.expanded ? 'rotate-90' : ''}" />
			</button>
		{/if}
	</span>

	{#if kind === 'dir' && row.expanded}
		<FolderOpenIcon class="size-3.5 shrink-0 {inkClass(node.status)}" />
	{:else if kind === 'dir'}
		<FolderIcon class="size-3.5 shrink-0 {inkClass(node.status)}" />
	{:else if kind === 'symlink'}
		<FileSymlinkIcon class="size-3.5 shrink-0 {inkClass(node.status)}" />
	{:else if kind === 'other'}
		<FileQuestionMarkIcon class="size-3.5 shrink-0 {inkClass(node.status)}" />
	{:else}
		<FileIcon class="size-3.5 shrink-0 {inkClass(node.status)}" />
	{/if}

	<span class="truncate {nameClass(node)}">{node.name}</span>

	{#if node.status === 'unchanged' && node.has_changes}
		<span class="size-1.5 shrink-0 rounded-full bg-mod-ink opacity-80" aria-hidden="true"></span>
	{/if}
{/snippet}

{#snippet warning()}
	<TriangleAlertIcon class="size-3.5 shrink-0 text-unknown-ink" aria-label="Could not be read" />
{/snippet}

<!-- The letter repeats the colour, so status never rests on colour alone. -->
{#snippet letter(node: TreeNode, extra: string)}
	<span class="shrink-0 text-center font-mono text-[11px] font-semibold {inkClass(node.status)} {extra}">
		{STATUS_LETTER[node.status]}
	</span>
{/snippet}

<!-- Column titles. Kept inside the scrolling element, so the split columns
     line up with the rows whether or not a scrollbar takes up width. -->
{#snippet columns()}
	<div class="sticky top-0 z-10 flex shrink-0 items-center border-b bg-card text-xs" style:height="{HEADER_HEIGHT}px">
		{#if mode === 'split'}
			<span class="min-w-0 flex-1 truncate px-3 font-medium" title={leftName}>{leftName}</span>
			<span class="w-6 shrink-0"></span>
			<span class="flex min-w-0 flex-1 items-center gap-2 px-3">
				<span class="truncate font-medium" title={rightName}>{rightName}</span>
				<span class="ml-auto shrink-0 text-muted-foreground tabular-nums">
					{formatCount(total)}
					{total === 1 ? 'entry' : 'entries'}
				</span>
			</span>
		{:else}
			<span class="flex min-w-0 flex-1 items-center gap-2 px-3">
				<span class="truncate font-medium" title={leftName}>{leftName}</span>
				<span class="shrink-0 text-muted-foreground">→</span>
				<span class="truncate font-medium" title={rightName}>{rightName}</span>
				<span class="ml-auto shrink-0 text-muted-foreground tabular-nums">
					{formatCount(total)}
					{total === 1 ? 'entry' : 'entries'}
				</span>
			</span>
		{/if}
	</div>
{/snippet}

{#if result.identical}
	<div class="flex h-full flex-col">
		{@render columns()}
		<div class="grid min-h-0 flex-1 place-items-center text-center text-muted-foreground">
			<div class="space-y-1">
				<p class="text-sm text-foreground">The two folders are identical</p>
				<p class="text-xs">
					{total === 0 ? 'Both folders are empty.' : `All ${formatCount(total)} entries match, metadata included.`}
				</p>
			</div>
		</div>
	</div>
{:else}
	<div class="flex h-full">
		<div
			bind:this={viewport}
			bind:clientHeight={viewportHeight}
			onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
			onkeydown={onKeydown}
			role="tree"
			aria-label="Folder comparison"
			aria-activedescendant={selectedIndex >= firstVisible && selectedIndex < lastVisible
				? `tree-row-${selectedIndex}`
				: undefined}
			tabindex="0"
			class="h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
		>
			{@render columns()}

			<!-- Spacer carries the full scroll height; only `visible` is in the DOM. -->
			<div class="relative w-full" style:height="{rows.length * ROW_HEIGHT}px">
				<div class="absolute inset-x-0 top-0" style:transform="translateY({firstVisible * ROW_HEIGHT}px)">
					{#each visible as row, offset (row.node.path)}
						{@const index = firstVisible + offset}
						{@const node = row.node}
						{@const selected = node.path === selectedPath}
						{@const indent = `${8 + row.depth * INDENT_PX}px`}
						<!-- Keys are handled once, on the tree, rather than on every row. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							id="tree-row-{index}"
							role="treeitem"
							tabindex="-1"
							aria-level={row.depth + 1}
							aria-expanded={row.expandable ? row.expanded : undefined}
							aria-selected={selected}
							title={describeNode(node)}
							class="flex items-stretch whitespace-nowrap select-none {selected
								? 'bg-accent ring-1 ring-brand/60 ring-inset'
								: 'hover:bg-muted/50'} {canOpen(node) ? 'cursor-pointer' : ''}"
							style:height="{ROW_HEIGHT}px"
							onclick={() => (selectedPath = node.path)}
							ondblclick={() => {
								if (row.expandable) toggle(node);
								else if (canOpen(node)) onopen?.(node);
							}}
						>
							{#if mode === 'split'}
								<!-- Left / original -->
								<div
									class="flex min-w-0 flex-1 items-center gap-1.5 pr-2 {sideClass(node, node.left_kind)}"
									style:padding-left={indent}
								>
									{#if node.left_kind}
										{@render entry(row, node.left_kind)}
										{#if hasErrorOn(node, 'left')}{@render warning()}{/if}
									{/if}
								</div>

								{@render letter(node, 'grid w-6 place-items-center border-x')}

								<!-- Right / changed -->
								<div
									class="flex min-w-0 flex-1 items-center gap-1.5 pr-2 {sideClass(node, node.right_kind)}"
									style:padding-left={indent}
								>
									{#if node.right_kind}
										{@render entry(row, node.right_kind)}
										{#if hasErrorOn(node, 'right')}{@render warning()}{/if}
									{/if}
								</div>
							{:else}
								{@const change = kindChange(node)}
								<div class="flex min-w-0 flex-1 items-center gap-1.5 pr-3" style:padding-left={indent}>
									{@render entry(row, displayKind(node))}
									{#if change}
										<span class="shrink-0 text-[11px] text-muted-foreground">{change}</span>
									{/if}
									{#if node.error}{@render warning()}{/if}
									{@render letter(node, 'ml-auto w-3')}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
		<ChangeStrip
			{marks}
			total={HEADER_HEIGHT + rows.length * ROW_HEIGHT}
			lineAt={stripLineAt}
			viewStart={scrollTop}
			viewEnd={scrollTop + viewportHeight}
			onjump={(position) => {
				if (viewport) viewport.scrollTop = position - viewportHeight / 2;
			}}
			onscrollby={(delta) => viewport?.scrollBy({ top: delta })}
		/>
	</div>
{/if}
