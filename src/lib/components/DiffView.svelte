<script lang="ts">
	import ChangeStrip from '$lib/components/ChangeStrip.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { formatCount } from '$lib/format';
	import type { DiffResult, DiffRow } from '$lib/diff-types';
	import { measureText, type StripCell, type StripLine } from '$lib/minimap';
	import type { ChangeKind, ChangeMark } from '$lib/line-alignment';
	import {
		changeOf,
		changeRange,
		changeStarts,
		columnsOf,
		filterRows,
		findMatches,
		hasTabs,
		highlightParts,
		MAX_MATCHES,
		renderSegments,
		sliceByColumns,
		TAB_SIZE,
		toSplitRows,
		toUnifiedRows,
		type DiffFilter,
		type Highlight,
		type RenderedPart,
		type SearchMatch
	} from '$lib/diff-view-model';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import XIcon from '@lucide/svelte/icons/x';
	import type { ChangeRange } from '$lib/text-edit';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { tick } from 'svelte';

	type Props = {
		result: DiffResult;
		mode: 'unified' | 'split';
		/** Wrap long lines instead of scrolling them horizontally. */
		wrap: boolean;
		/** Which lines to show; hidden runs collapse into a line saying how many were left out. */
		show?: DiffFilter;
		/**
		 * Identifies the two documents compared. The view starts at the top only when it
		 * changes, so re-diffing the same files — after copying a change — keeps its place.
		 */
		documentKey?: string;
		/** Copies a change to one side, making that side match the other there. Without it, changes cannot be copied. */
		oncopy?: (range: ChangeRange, toward: 'left' | 'right') => void;
	};

	let { result, mode, wrap, show = 'all', documentKey, oncopy }: Props = $props();

	/** Height of a single (unwrapped) line, matching `leading-5`. */
	const LINE_HEIGHT = 20;
	/** Rows rendered beyond the viewport, so fast scrolling does not show gaps. */
	const OVERSCAN = 8;
	/** Combined width of the line-number gutters and the +/- marker column. */
	const UNIFIED_GUTTER_PX = 14 * 4 + 14 * 4 + 16;
	const SPLIT_GUTTER_PX = 14 * 4;

	const rows = $derived(filterRows(mode === 'split' ? toSplitRows(result.hunks) : toUnifiedRows(result.hunks), show));

	let viewport: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let viewportWidth = $state(0);
	/** Width of one character in the row font, measured from the DOM once. */
	let charWidth = $state(0);

	/** Measures the monospace advance width so wrapped heights can be derived. */
	function probe(node: HTMLElement) {
		const measure = () => {
			const width = node.getBoundingClientRect().width / 100;
			if (width > 0) charWidth = width;
		};
		measure();
		// Re-measure if the font loads after first paint, which would otherwise
		// leave every wrapped height computed against a fallback face.
		void document.fonts?.ready?.then(measure);
	}

	/** Columns available for row text, per side. */
	const columnsPerLine = $derived.by(() => {
		if (!wrap || charWidth <= 0 || viewportWidth <= 0) return Infinity;
		const gutters = mode === 'split' ? SPLIT_GUTTER_PX * 2 : UNIFIED_GUTTER_PX;
		const textWidth = mode === 'split' ? (viewportWidth - gutters) / 2 : viewportWidth - gutters;
		return Math.max(20, Math.floor(textWidth / charWidth));
	});

	function linesFor(columns: number): number {
		if (columns <= 0 || columnsPerLine === Infinity) return 1;
		return Math.max(1, Math.ceil(columns / columnsPerLine));
	}

	function heightOf(index: number): number {
		const item = rows[index];
		if (item.kind === 'collapsed') return LINE_HEIGHT;
		if (item.kind === 'row') return linesFor(columnsOf(item.row)) * LINE_HEIGHT;
		return Math.max(linesFor(columnsOf(item.left)), linesFor(columnsOf(item.right))) * LINE_HEIGHT;
	}

	/**
	 * A row taller than the viewport is windowed in its own right: only the
	 * wrapped lines on screen are rendered, offset into a container of the row's
	 * full height.
	 *
	 * Row-level windowing cannot help a file with no newlines — that is a single
	 * row, so there is nothing to choose between and all of it would land in the
	 * DOM. This is the same technique one level down.
	 */
	type RowSlice = { top: number; parts: RenderedPart[] } | null;

	function sliceFor(index: number, row: DiffRow | null): RowSlice {
		if (!row || columnsPerLine === Infinity || viewportHeight <= 0) return null;

		const lines = linesFor(columnsOf(row));
		// Rows that comfortably fit are cheaper to render whole than to slice.
		if (lines <= Math.ceil(viewportHeight / LINE_HEIGHT) + OVERSCAN * 2) return null;
		// Column maths assumes one character per column, which tabs break.
		if (hasTabs(row)) return null;

		const rowTop = offsets[index];
		// Clamped into the row, so a row sitting entirely above or below the
		// viewport yields an empty range and draws no text at all. Returning null
		// here instead would fall back to rendering the row whole — which for a
		// 10 MB line is the entire problem this exists to solve.
		const firstLine = Math.min(lines, Math.max(0, Math.floor((scrollTop - rowTop) / LINE_HEIGHT) - OVERSCAN));
		const lastLine = Math.max(
			firstLine,
			Math.min(lines, Math.ceil((scrollTop + viewportHeight - rowTop) / LINE_HEIGHT) + OVERSCAN)
		);

		return {
			top: firstLine * LINE_HEIGHT,
			parts: lastLine > firstLine ? sliceByColumns(row, firstLine * columnsPerLine, lastLine * columnsPerLine) : []
		};
	}

	/**
	 * Running offset of every row. Rebuilt when the rows, the wrap setting or the
	 * width change — virtualising a variable-height list needs the position of
	 * rows that are not currently rendered, so they cannot simply be measured.
	 */
	const offsets = $derived.by(() => {
		const out = new Float64Array(rows.length + 1);
		for (let i = 0; i < rows.length; i++) out[i + 1] = out[i] + heightOf(i);
		return out;
	});

	const totalHeight = $derived(offsets[rows.length] ?? 0);

	/** Last index whose offset is <= `y`. */
	function indexAt(y: number): number {
		let low = 0;
		let high = rows.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (offsets[mid + 1] <= y) low = mid + 1;
			else high = mid;
		}
		return Math.min(low, Math.max(0, rows.length - 1));
	}

	/**
	 * Split view without wrapping.
	 *
	 * Letting each row grow to fit its text puts the right half wherever that
	 * row's left line happens to end, so the columns no longer line up. Instead
	 * both halves keep a fixed width and their text pans horizontally, together,
	 * under a scrollbar sized to the widest line — the gutters stay put.
	 */
	const panned = $derived(mode === 'split' && !wrap);
	/**
	 * Chromium stops laying out elements beyond roughly 33.5 million pixels. The
	 * scroll track is capped well below that and mapped onto the real width, so
	 * a multi-megabyte line can still be panned to its end.
	 */
	const MAX_PAN_TRACK_PX = 16_000_000;
	/** Matches the cell's `pr-4`. */
	const CELL_PADDING_PX = 16;
	/** Room after the longest line for the "no newline at end of file" note. */
	const NOTE_COLUMNS = 30;
	/** Columns rendered either side of the visible ones while panning. */
	const PAN_OVERSCAN_COLUMNS = 40;

	let scrollLeft = $state(0);

	const halfTextPx = $derived(Math.max(0, (viewportWidth - SPLIT_GUTTER_PX * 2) / 2 - CELL_PADDING_PX));

	const widestColumns = $derived.by(() => {
		if (!panned) return 0;
		let widest = 0;
		for (const item of rows) {
			if (item.kind === 'pair') widest = Math.max(widest, columnsOf(item.left), columnsOf(item.right));
		}
		return widest;
	});

	const panRange = $derived(
		panned && charWidth > 0 ? Math.max(0, (widestColumns + NOTE_COLUMNS) * charWidth - halfTextPx) : 0
	);
	const panTrack = $derived(Math.min(panRange, MAX_PAN_TRACK_PX));
	const panX = $derived(panTrack > 0 ? Math.min(scrollLeft, panTrack) * (panRange / panTrack) : 0);

	/**
	 * The columns of a row that fall inside its half at the current pan, and
	 * where they start. Horizontal windowing, so a 10 MB line puts a screenful
	 * of text in the DOM rather than all of it.
	 */
	function panSliceFor(row: DiffRow): { left: number; parts: RenderedPart[]; trailing: boolean } {
		// Column maths assumes one character per column, which tabs break.
		if (hasTabs(row) || charWidth <= 0) {
			return { left: 0, parts: renderSegments(row).parts, trailing: true };
		}
		const columns = columnsOf(row);
		const firstColumn = Math.max(0, Math.floor(panX / charWidth) - PAN_OVERSCAN_COLUMNS);
		const lastColumn = Math.min(columns, Math.ceil((panX + halfTextPx) / charWidth) + PAN_OVERSCAN_COLUMNS);
		return {
			left: firstColumn * charWidth,
			parts: lastColumn > firstColumn ? sliceByColumns(row, firstColumn, lastColumn) : [],
			trailing: lastColumn >= columns
		};
	}

	const firstVisible = $derived(Math.max(0, indexAt(scrollTop) - OVERSCAN));
	const lastVisible = $derived(Math.min(rows.length, indexAt(scrollTop + viewportHeight) + 1 + OVERSCAN));
	const visible = $derived(rows.slice(firstVisible, lastVisible));
	const offsetY = $derived(offsets[firstVisible] ?? 0);

	// New documents: start at the top rather than halfway down a diff the user has not
	// seen. Without a key, every new result counts as new documents.
	$effect(() => {
		void (documentKey ?? result);
		void mode;
		void show;
		if (viewport) {
			viewport.scrollTop = 0;
			viewport.scrollLeft = 0;
		}
		scrollTop = 0;
		scrollLeft = 0;
	});

	function stripCell(row: DiffRow | null, kind: ChangeKind | null): StripCell {
		if (!row) return { indent: 0, length: 0, kind: null };
		return { ...measureText(row.segments.map((segment) => segment.value)), kind };
	}

	/** The row at a height in the diff, for the minimap: one cell unified, two side by side. */
	function stripLineAt(y: number): StripLine | null {
		if (rows.length === 0) return null;
		const index = indexAt(y);
		const item = rows[index];
		if (item.kind === 'collapsed') return null;
		const [top, bottom] = [offsets[index], offsets[index + 1]];
		const kind = changeOf(item);
		if (item.kind === 'row') return { top, bottom, cells: [stripCell(item.row, kind)] };
		// Each half takes the pair's colour only if that half is the one that changed.
		const leftKind = item.left?.tag === 'delete' ? kind : null;
		const rightKind = item.right?.tag === 'insert' ? kind : null;
		return { top, bottom, cells: [stripCell(item.left, leftKind), stripCell(item.right, rightKind)] };
	}

	/** Changed rows for the minimap, merged into runs, in pixels down the diff. */
	const marks = $derived.by(() => {
		const out: ChangeMark[] = [];
		for (let i = 0; i < rows.length; i++) {
			const kind = changeOf(rows[i]);
			if (!kind) continue;
			const last = out.at(-1);
			if (last && last.kind === kind && last.end === offsets[i]) last.end = offsets[i + 1];
			else out.push({ start: offsets[i], end: offsets[i + 1], kind });
		}
		return out;
	});

	/** Lines of context left above a change the Up and Down buttons jump to. */
	const JUMP_CONTEXT = 3 * LINE_HEIGHT;

	const maxScroll = $derived(Math.max(0, totalHeight - viewportHeight));

	/**
	 * Where a jump scrolls to for each change. Changes near the end clamp to the
	 * furthest scroll position, so several can share one.
	 */
	const changeTops = $derived(changeStarts(rows).map((index) => Math.max(0, offsets[index] - JUMP_CONTEXT)));
	const changePositions = $derived(changeTops.map((top) => Math.min(maxScroll, top)));

	/**
	 * The change the last jump landed on, while the view is still where it put it. Changes
	 * near the end share a scroll position, so the view alone cannot say which one is meant.
	 */
	let jumped = $state.raw<{ index: number; top: number; rows: typeof rows } | null>(null);

	function jumpedIndex(): number {
		return jumped && jumped.rows === rows && Math.abs(scrollTop - jumped.top) < 2 ? jumped.index : -1;
	}

	/** A brief highlight over the change a jump landed on; `token` restarts it for each jump. */
	let flash = $state.raw<{ start: number; token: number } | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	/** The change a jump in `direction` lands on, or -1 when there is none that way. */
	function jumpTarget(direction: 1 | -1): number {
		const at = jumpedIndex();
		if (at >= 0) {
			const next = at + direction;
			return next >= 0 && next < changePositions.length ? next : -1;
		}
		if (direction > 0) return changePositions.findIndex((position) => position > scrollTop + 1);
		// Of several changes sharing the position before this one, land on the first.
		const last = changePositions.findLastIndex((position) => position < scrollTop - 1);
		return last < 0 ? last : changePositions.indexOf(changePositions[last]);
	}

	export function canJump(direction: 1 | -1): boolean {
		return jumpTarget(direction) >= 0;
	}

	/** Scrolls to the previous (-1) or next (1) change. */
	export function jump(direction: 1 | -1) {
		const target = jumpTarget(direction);
		if (target < 0 || !viewport) return;
		viewport.scrollTo({ top: changePositions[target] });
		scrollTop = viewport.scrollTop;
		jumped = { index: target, top: scrollTop, rows };
		flash = { start: starts[target], token: (flash?.token ?? 0) + 1 };
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 1000);
	}

	/**
	 * Which change the view is at, counting from 1, and how many there are. The
	 * current change is the last one scrolled to or past, 0 before the first. At
	 * the very end of a scrollable diff every remaining change is on screen, so
	 * that counts as the last.
	 */
	export function changeCount(): { current: number; total: number } {
		const total = changeTops.length;
		const at = jumpedIndex();
		if (at >= 0) return { current: at + 1, total };
		if (maxScroll > 0 && scrollTop >= maxScroll - 1) return { current: total, total };
		return { current: changeTops.findLastIndex((top) => top <= scrollTop + 1) + 1, total };
	}

	let searchOpen = $state(false);
	let query = $state('');
	let activeMatch = $state(0);
	let searchInput: HTMLInputElement | null = $state(null);

	const matches = $derived(searchOpen ? findMatches(rows, query) : []);
	const currentMatch = $derived(matches.length > 0 ? Math.min(activeMatch, matches.length - 1) : -1);

	/** Matches grouped by row index, for drawing them. */
	const matchesByRow = $derived.by(() => {
		const out = new Map<number, { match: SearchMatch; active: boolean }[]>();
		matches.forEach((match, position) => {
			const list = out.get(match.index) ?? [];
			list.push({ match, active: position === currentMatch });
			out.set(match.index, list);
		});
		return out;
	});

	/** The search highlights to draw in one cell. */
	function highlightsFor(index: number, side: 'row' | 'left' | 'right'): Highlight[] {
		const list = matchesByRow.get(index);
		if (!list) return [];
		return list
			.filter(({ match }) => match.side === side || (match.side === 'both' && side !== 'row'))
			.map(({ match, active }) => ({ start: match.start, end: match.end, active }));
	}

	/** Opens the search bar, or selects its text when it is already open. */
	export async function openSearch() {
		searchOpen = true;
		await tick();
		searchInput?.focus();
		searchInput?.select();
	}

	function closeSearch() {
		searchOpen = false;
	}

	function onQueryInput() {
		// Start from the first match at or below the top of the view, rather than
		// jumping back to the start of the file.
		const top = indexAt(scrollTop);
		const first = matches.findIndex((match) => match.index >= top);
		activeMatch = Math.max(0, first);
		if (matches.length > 0) revealMatch(matches[activeMatch]);
	}

	/** Moves to the next (1) or previous (-1) match, wrapping around. */
	export function stepMatch(direction: 1 | -1) {
		if (matches.length === 0) return;
		activeMatch = (currentMatch + direction + matches.length) % matches.length;
		revealMatch(matches[activeMatch]);
	}

	/** Scrolls a match into view, down to the wrapped line and across to its column. */
	function revealMatch(match: SearchMatch) {
		if (!viewport) return;
		let top = offsets[match.index];
		if (columnsPerLine !== Infinity) top += Math.floor(match.start / columnsPerLine) * LINE_HEIGHT;
		if (top < scrollTop || top + LINE_HEIGHT > scrollTop + viewportHeight) {
			viewport.scrollTop = top - viewportHeight / 3;
		}
		if (wrap || charWidth <= 0) return;
		const x = match.start * charWidth;
		if (panned) {
			// Both halves pan together, so either side's match sets the same pan.
			if (x < panX || x + (match.end - match.start) * charWidth > panX + halfTextPx) {
				const target = Math.max(0, x - halfTextPx / 3);
				viewport.scrollLeft = panRange > 0 ? (target * panTrack) / panRange : 0;
			}
		} else {
			const cellX = UNIFIED_GUTTER_PX + x;
			if (
				cellX < viewport.scrollLeft + UNIFIED_GUTTER_PX ||
				cellX > viewport.scrollLeft + viewportWidth - charWidth * 4
			) {
				viewport.scrollLeft = Math.max(0, x - viewportWidth / 3);
			}
		}
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			stepMatch(event.shiftKey ? -1 : 1);
		} else if (event.key === 'Escape') {
			// Handled here, so Escape does not also close the file opened from a folder.
			event.preventDefault();
			event.stopPropagation();
			closeSearch();
		}
	}

	/** Every row of the diff in order, unfiltered, for working out which lines a change covers. */
	const allRows = $derived(result.hunks.flatMap((hunk) => hunk.rows));
	const rowPosition = $derived(new Map(allRows.map((row, index) => [row, index])));
	const starts = $derived(changeStarts(rows));

	/**
	 * The first row of the change a row belongs to, or -1 for a row that is not part of
	 * one. A row standing in for hidden differences is a change of its own.
	 */
	function changeAt(index: number): number {
		const item = rows[index];
		if (!item) return -1;
		if (item.kind === 'collapsed') return item.hidden === 'different' ? index : -1;
		if (changeOf(item) === null) return -1;
		let low = 0;
		let high = starts.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (starts[mid] <= index) low = mid + 1;
			else high = mid;
		}
		return low > 0 ? starts[low - 1] : -1;
	}

	/** The first row of the change the counter is at, which is marked down the gutter. */
	const currentChange = $derived(starts[changeCount().current - 1] ?? -1);

	/** The row under the pointer, whose change shows its copy buttons there. */
	let hoveredRow = $state(-1);
	/** Where the pointer last was over the rows, so scrolling under a still pointer moves the buttons along. */
	let pointerY: number | null = null;

	function trackPointer() {
		if (pointerY === null || !viewport || rows.length === 0) {
			hoveredRow = -1;
			return;
		}
		const y = scrollTop + pointerY - viewport.getBoundingClientRect().top;
		hoveredRow = y >= 0 && y < totalHeight ? indexAt(y) : -1;
	}

	/** The lines each side of the change starting at `index` covers. */
	function rangeOf(index: number): ChangeRange | null {
		const item = rows[index];
		if (!item || item.kind === 'collapsed') return null;
		const row = item.kind === 'row' ? item.row : item.left?.tag === 'delete' ? item.left : item.right;
		const position = row ? rowPosition.get(row) : undefined;
		return position === undefined ? null : changeRange(allRows, position);
	}

	function copy(index: number, toward: 'left' | 'right') {
		const range = rangeOf(index);
		if (range) oncopy?.(range, toward);
	}

	/** Copies the change the counter is at to one side, for Alt+→ and Alt+←. */
	export function copyCurrent(toward: 'left' | 'right') {
		const { current } = changeCount();
		const index = starts[current - 1];
		if (index !== undefined && rows[index]?.kind !== 'collapsed') copy(index, toward);
	}

	function onScroll(event: Event) {
		const el = event.currentTarget as HTMLElement;
		scrollTop = el.scrollTop;
		scrollLeft = el.scrollLeft;
		trackPointer();
	}

	function gutterClass(row: DiffRow | null) {
		if (!row) return 'bg-background empty-stripes';
		if (row.tag === 'insert') return 'bg-add-bg text-add-gutter';
		if (row.tag === 'delete') return 'bg-del-bg text-del-gutter';
		return 'bg-background text-muted-foreground';
	}

	function bodyClass(row: DiffRow | null) {
		if (!row) return 'bg-muted/25 empty-stripes';
		if (row.tag === 'insert') return 'bg-add-bg text-add-ink';
		if (row.tag === 'delete') return 'bg-del-bg text-del-ink';
		return 'text-foreground';
	}

	function marker(row: DiffRow | null) {
		if (!row) return '';
		if (row.tag === 'insert') return '+';
		if (row.tag === 'delete') return '-';
		return ' ';
	}

	// When wrapping, the cell must be allowed to shrink below its content
	// (`min-w-0`) so the text breaks. When not wrapping, it must NOT shrink —
	// otherwise a long line is clipped instead of widening the row into a
	// horizontal scroll.
	const textClass = $derived(wrap ? 'min-w-0 flex-1 whitespace-pre-wrap break-all' : 'flex-1 whitespace-pre');
</script>

<!-- Off-screen probe: 100 characters of the row font, for the width measurement. -->
<span
	aria-hidden="true"
	class="pointer-events-none invisible absolute font-mono text-[12.5px] whitespace-pre"
	{@attach probe}
	>0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000</span
>

<!-- Copies the change under the pointer across, from whichever of its rows the pointer is on. -->
{#snippet copyButtons(index: number)}
	{#snippet copyButton(toward: 'left' | 'right', extra: string)}
		<button
			type="button"
			class="pointer-events-auto grid size-[18px] place-items-center rounded-sm border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground {extra}"
			title={toward === 'right' ? 'Copy this change to the right (Alt+→)' : 'Copy this change to the left (Alt+←)'}
			aria-label={toward === 'right' ? 'Copy this change to the right' : 'Copy this change to the left'}
			onclick={() => copy(index, toward)}
		>
			{#if toward === 'right'}<ArrowRightIcon class="size-3" />{:else}<ArrowLeftIcon class="size-3" />{/if}
		</button>
	{/snippet}
	{#if oncopy && hoveredRow === index && rows[index]?.kind !== 'collapsed' && changeAt(index) >= 0}
		{#if mode === 'split'}
			<span class="pointer-events-none absolute inset-y-0 left-1 z-[2] flex items-center">
				{@render copyButton('right', '')}
			</span>
			<span class="pointer-events-none absolute inset-y-0 left-[calc(50%+4px)] z-[2] flex items-center">
				{@render copyButton('left', '')}
			</span>
		{:else}
			<span class="pointer-events-none absolute inset-y-0 left-1 z-[2] flex items-center gap-1">
				{@render copyButton('right', '')}
				{@render copyButton('left', '')}
			</span>
		{/if}
	{/if}
{/snippet}

<!-- The current change: a bar down the gutter, and a flash when a jump has just landed on it. -->
{#snippet changeMarker(index: number)}
	{@const change = changeAt(index)}
	{#if change >= 0 && change === currentChange}
		<span class="pointer-events-none absolute inset-y-0 left-0 z-[1] w-1 bg-brand" aria-hidden="true"></span>
	{/if}
	{#if flash && change >= 0 && change === flash.start}
		{#key flash.token}
			<span class="pointer-events-none absolute inset-0 z-[1] animate-jump-flash bg-brand/35" aria-hidden="true"></span>
		{/key}
	{/if}
{/snippet}

{#snippet inlineParts(row: DiffRow, parts: RenderedPart[], trailing: boolean, highlights: Highlight[])}
	{#each highlightParts(parts, highlights) as part, index (index)}
		{#if part.match !== 'none'}
			<!-- A search match; the one Enter last moved to stands out. -->
			<mark
				class="rounded-xs text-foreground {part.match === 'active'
					? 'bg-search-active outline outline-search-active-ring'
					: 'bg-search'}">{part.value}</mark
			>
		{:else if part.emphasized}
			<!-- The words that actually changed within a changed line. -->
			<span class={row.tag === 'insert' ? 'rounded-xs bg-add-bg-strong' : 'rounded-xs bg-del-bg-strong'}
				>{part.value}</span
			>
		{:else}{part.value}{/if}
	{/each}
	{#if trailing && row.missingNewline}
		<span class="text-muted-foreground italic"> ⏎ no newline at end of file</span>
	{/if}
{/snippet}

<!-- One text cell: the whole row, or just the wrapped lines on screen when the
     row is taller than the viewport. -->
{#snippet cell(row: DiffRow | null, index: number, extra: string, side: 'row' | 'left' | 'right')}
	{#if panned}
		<!-- Fixed half width; the text moves inside it rather than widening the row. -->
		<span class="{bodyClass(row)} min-w-0 flex-1 overflow-hidden whitespace-pre {extra}">
			{#if row}
				{@const pan = panSliceFor(row)}
				<span class="block w-max" style:transform="translateX({pan.left - panX}px)">
					{@render inlineParts(row, pan.parts, pan.trailing, highlightsFor(index, side))}
				</span>
			{/if}
		</span>
	{:else}
		{@render wholeCell(row, index, extra, side)}
	{/if}
{/snippet}

{#snippet wholeCell(row: DiffRow | null, index: number, extra: string, side: 'row' | 'left' | 'right')}
	{@const slice = row ? sliceFor(index, row) : null}
	<span
		class="{bodyClass(row)} {textClass} {extra} {slice ? 'relative block overflow-hidden' : ''}"
		style:height={slice ? `${heightOf(index)}px` : undefined}
	>
		{#if row}
			{#if slice}
				<span class="absolute inset-x-0 pr-4" style:top="{slice.top}px">
					{@render inlineParts(row, slice.parts, false, highlightsFor(index, side))}
				</span>
			{:else}
				{@render inlineParts(row, renderSegments(row).parts, true, highlightsFor(index, side))}
			{/if}
		{/if}
	</span>
{/snippet}

{#if result.identical}
	<div class="grid h-full place-items-center text-center text-muted-foreground">
		<div class="space-y-1">
			<p class="text-sm text-foreground">The two files are identical</p>
			<p class="text-xs">No differences to show.</p>
		</div>
	</div>
{:else}
	<div class="relative flex h-full">
		{#if searchOpen}
			<div
				class="absolute top-2 right-20 z-10 flex items-center gap-1 rounded-md border bg-card p-1 shadow-md"
				role="search"
			>
				<Input
					bind:ref={searchInput}
					bind:value={query}
					oninput={onQueryInput}
					onkeydown={onSearchKeydown}
					placeholder="Find in diff"
					aria-label="Find in diff"
					class="h-7 w-56 text-xs"
				/>
				<span class="min-w-20 px-1 text-center text-[11px] text-muted-foreground tabular-nums">
					{#if !query}
						&nbsp;
					{:else if matches.length === 0}
						No results
					{:else}
						{formatCount(currentMatch + 1)} of {formatCount(matches.length)}{matches.length >= MAX_MATCHES ? '+' : ''}
					{/if}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => stepMatch(-1)}
					disabled={matches.length === 0}
					title="Previous match (Shift+Enter)"
					aria-label="Previous match"
				>
					<ChevronUpIcon class="size-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => stepMatch(1)}
					disabled={matches.length === 0}
					title="Next match (Enter)"
					aria-label="Next match"
				>
					<ChevronDownIcon class="size-3.5" />
				</Button>
				<Button variant="ghost" size="icon-sm" onclick={closeSearch} title="Close (Esc)" aria-label="Close search">
					<XIcon class="size-3.5" />
				</Button>
			</div>
		{/if}
		<div
			bind:this={viewport}
			bind:clientHeight={viewportHeight}
			bind:clientWidth={viewportWidth}
			onscroll={onScroll}
			onpointermove={(event) => {
				pointerY = event.clientY;
				trackPointer();
			}}
			onpointerleave={() => {
				pointerY = null;
				hoveredRow = -1;
			}}
			role="presentation"
			style:tab-size={TAB_SIZE}
			class="h-full min-w-0 flex-1 overflow-auto font-mono text-[12.5px] leading-5 {wrap ? 'overflow-x-hidden' : ''}"
		>
			<!-- Spacer carries the full scroll height; only `visible` is in the DOM.
         When panning it also carries the horizontal track, while the rows stay
         pinned to the viewport and move their text instead. -->
			<div
				style:height="{totalHeight}px"
				style:width={panned ? `${viewportWidth + panTrack}px` : undefined}
				class="relative {panned ? '' : wrap ? 'w-full' : 'w-max min-w-full'}"
			>
				<div
					style:transform="translateY({offsetY}px)"
					style:width={panned ? `${viewportWidth}px` : undefined}
					class={panned ? 'sticky left-0' : 'absolute inset-x-0 top-0'}
				>
					{#each visible as item, offset (item.key)}
						{@const index = firstVisible + offset}
						{#if item.kind === 'collapsed'}
							<div
								class="relative flex items-center gap-2 bg-muted/40 px-3 text-muted-foreground select-none"
								style:height="{LINE_HEIGHT}px"
							>
								{@render changeMarker(index)}
								<span class="h-px flex-1 bg-current opacity-20"></span>
								<span class="text-[11px] tabular-nums"
									>{formatCount(item.count)}
									{item.hidden === 'similar' ? 'similar' : 'different'}
									{item.count === 1 ? 'line' : 'lines'} hidden</span
								>
								<span class="h-px flex-1 bg-current opacity-20"></span>
							</div>
						{:else if item.kind === 'row'}
							<div class="relative flex">
								{@render changeMarker(index)}
								{@render copyButtons(index)}
								<span class="{gutterClass(item.row)} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none">
									{item.row.oldLine ?? ''}
								</span>
								<span class="{gutterClass(item.row)} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none">
									{item.row.newLine ?? ''}
								</span>
								<span class="{bodyClass(item.row)} w-4 shrink-0 text-center select-none">
									{marker(item.row)}
								</span>
								{@render cell(item.row, index, 'pr-4', 'row')}
							</div>
						{:else}
							<!-- Rows are 20px and the stripe tile 8px, so each row shifts its stripes to continue the row above's. -->
							<div class="relative flex" style:--stripe-y="{-(offsets[index] % 8)}px">
								{@render changeMarker(index)}
								{@render copyButtons(index)}
								<!-- Left / original -->
								<span
									class="{gutterClass(item.left)} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
								>
									{item.left?.oldLine ?? ''}
								</span>
								{@render cell(item.left, index, 'border-r pr-4', 'left')}

								<!-- Right / changed -->
								<span
									class="{gutterClass(item.right)} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
								>
									{item.right?.newLine ?? ''}
								</span>
								{@render cell(item.right, index, 'pr-4', 'right')}
							</div>
						{/if}
					{/each}
				</div>
			</div>
		</div>
		<ChangeStrip
			{marks}
			total={totalHeight}
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
