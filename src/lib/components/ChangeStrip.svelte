<script lang="ts">
	import type { ChangeKind, ChangeMark } from '$lib/line-alignment';
	import { STRIP_COLUMNS, stripBox, type StripLine } from '$lib/minimap';

	type Props = {
		/**
		 * The full length of the content the minimap stands for, in its caller's units:
		 * pixels of scroll height, or lines.
		 */
		total: number;
		/** The part of the content currently on screen, in the same units. */
		viewStart: number;
		viewEnd: number;
		/** The line of content at a position, in the same units, or null where there is none. */
		lineAt: (position: number) => StripLine | null;
		/**
		 * The most minimap pixels one unit may be drawn as, so a short text reads as lines
		 * at the top of the minimap rather than blocks stretched down its whole height. The
		 * default suits pixel units: a 20px line is drawn at most 3px tall.
		 */
		maxScale?: number;
		/**
		 * Changed stretches, drawn as a bar down the minimap's edge, so a change still shows
		 * where its lines are blank or where the other side's lines were removed. None for a
		 * minimap that only shows text.
		 */
		marks?: readonly ChangeMark[];
		/**
		 * Moves whenever what `lineAt` returns may have changed without anything reactive
		 * changing with it, such as an editor's line heights.
		 */
		revision?: number;
		/** Asks to bring `position`, in the same units, into the middle of the view. */
		onjump: (position: number) => void;
		/** Asks to scroll the view by `delta` pixels, for the mouse wheel over the minimap. */
		onscrollby: (delta: number) => void;
	};

	let {
		total,
		viewStart,
		viewEnd,
		lineAt,
		maxScale = 0.15,
		marks = [],
		revision = 0,
		onjump,
		onscrollby
	}: Props = $props();

	/** Pixels per wheel step reported in lines, and in pages, rather than pixels. */
	const WHEEL_LINE_PX = 20;

	function wheel(event: WheelEvent) {
		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? WHEEL_LINE_PX
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? height
					: 1;
		onscrollby(event.deltaY * unit);
	}

	/** A change bar never thinner than this, so a single changed line in a long file still shows. */
	const MIN_MARK_PX = 3;
	/** The on-screen box never shrinks below this, so it stays visible and easy to grab. */
	const MIN_BOX_PX = 16;
	const MARK_WIDTH_PX = 3;
	/** Space between the change bar and the text, and after the text. */
	const GAP_PX = 3;

	const INK: Record<ChangeKind, string> = {
		add: '--color-add-ink',
		del: '--color-del-ink',
		mod: '--color-mod-ink',
		unknown: '--color-unknown-ink'
	};

	let canvas: HTMLCanvasElement | null = $state(null);
	let width = $state(0);
	let height = $state(0);

	const scale = $derived(total > 0 && height > 0 ? Math.min(height / total, maxScale) : 0);
	const box = $derived(stripBox(scale, height, viewStart, viewEnd, MIN_BOX_PX));

	// Drawn on a canvas: a long file has far more lines than the minimap has pixels, so
	// each row of pixels samples the one line under it rather than drawing them all.
	$effect(() => {
		void revision;
		if (!canvas || width === 0 || height === 0) return;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		const context = canvas.getContext('2d');
		if (!context) return;
		context.scale(ratio, ratio);
		context.clearRect(0, 0, width, height);
		if (scale === 0) return;

		const styles = getComputedStyle(canvas);
		const ink = Object.fromEntries(
			Object.entries(INK).map(([kind, token]) => [kind, styles.getPropertyValue(token)])
		) as Record<ChangeKind, string>;
		const plain = styles.getPropertyValue('--color-muted-foreground');

		for (const mark of marks) {
			context.fillStyle = ink[mark.kind];
			const markHeight = Math.max(MIN_MARK_PX, (mark.end - mark.start) * scale);
			context.fillRect(0, Math.min(mark.start * scale, height - markHeight), MARK_WIDTH_PX, markHeight);
		}

		const textLeft = MARK_WIDTH_PX + GAP_PX;
		const textWidth = width - textLeft - GAP_PX;
		const rows = Math.min(height, Math.ceil(total * scale));
		for (let row = 0; row < rows; row++) {
			const line = lineAt((row + 0.5) / scale);
			if (!line) continue;
			// A line drawn several pixels tall leaves its last pixel empty, so lines stay
			// apart instead of running together into a solid block.
			const lineBottom = line.bottom * scale;
			if (lineBottom - line.top * scale >= 2.5 && row + 1 >= lineBottom) continue;

			const cellWidth = textWidth / line.cells.length;
			const columnWidth = cellWidth / STRIP_COLUMNS;
			line.cells.forEach((cell, index) => {
				if (cell.length === 0) return;
				context.fillStyle = cell.kind ? ink[cell.kind] : plain;
				context.globalAlpha = cell.kind ? 1 : 0.45;
				const x = textLeft + index * cellWidth + cell.indent * columnWidth;
				context.fillRect(x, row, Math.max(1, (cell.length - cell.indent) * columnWidth), 1);
			});
			context.globalAlpha = 1;
		}
	});

	function jumpTo(event: PointerEvent) {
		if (scale === 0) return;
		const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
		onjump(Math.min(total, Math.max(0, (event.clientY - bounds.top) / scale)));
	}
</script>

<!-- Click to jump; hold and drag to scrub. A pointer shortcut over content that stays
     reachable by ordinary scrolling, so it is hidden from assistive technology. -->
<div
	class="relative h-full w-16 shrink-0 cursor-pointer border-l bg-card/60"
	bind:clientWidth={width}
	bind:clientHeight={height}
	role="presentation"
	aria-hidden="true"
	onpointerdown={(event) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		jumpTo(event);
	}}
	onpointermove={(event) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) jumpTo(event);
	}}
	onwheel={wheel}
>
	<canvas bind:this={canvas} class="pointer-events-none absolute inset-0 size-full"></canvas>
	<div
		class="pointer-events-none absolute inset-x-0 border border-foreground/60 bg-foreground/10"
		style:top="{box.top}px"
		style:height="{box.height}px"
	></div>
</div>
