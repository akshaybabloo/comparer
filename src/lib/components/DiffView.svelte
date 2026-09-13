<script lang="ts">
  import { formatCount } from '$lib/format';
  import type { DiffResult, DiffRow } from '$lib/diff-types';
  import {
    columnsOf,
    hasTabs,
    renderSegments,
    sliceByColumns,
    TAB_SIZE,
    toSplitRows,
    toUnifiedRows,
    type RenderedPart,
  } from '$lib/diff-view-model';

  type Props = {
    result: DiffResult;
    mode: 'unified' | 'split';
    /** Wrap long lines instead of scrolling them horizontally. */
    wrap: boolean;
  };

  let { result, mode, wrap }: Props = $props();

  /** Height of a single (unwrapped) line, matching `leading-5`. */
  const LINE_HEIGHT = 20;
  /** Rows rendered beyond the viewport, so fast scrolling does not show gaps. */
  const OVERSCAN = 8;
  /** Combined width of the line-number gutters and the +/- marker column. */
  const UNIFIED_GUTTER_PX = 14 * 4 + 14 * 4 + 16;
  const SPLIT_GUTTER_PX = 14 * 4;

  const rows = $derived(mode === 'split' ? toSplitRows(result.hunks) : toUnifiedRows(result.hunks));

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
    const firstLine = Math.min(
      lines,
      Math.max(0, Math.floor((scrollTop - rowTop) / LINE_HEIGHT) - OVERSCAN),
    );
    const lastLine = Math.max(
      firstLine,
      Math.min(lines, Math.ceil((scrollTop + viewportHeight - rowTop) / LINE_HEIGHT) + OVERSCAN),
    );

    return {
      top: firstLine * LINE_HEIGHT,
      parts:
        lastLine > firstLine
          ? sliceByColumns(row, firstLine * columnsPerLine, lastLine * columnsPerLine)
          : [],
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
    panned && charWidth > 0 ? Math.max(0, (widestColumns + NOTE_COLUMNS) * charWidth - halfTextPx) : 0,
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
    const lastColumn = Math.min(
      columns,
      Math.ceil((panX + halfTextPx) / charWidth) + PAN_OVERSCAN_COLUMNS,
    );
    return {
      left: firstColumn * charWidth,
      parts: lastColumn > firstColumn ? sliceByColumns(row, firstColumn, lastColumn) : [],
      trailing: lastColumn >= columns,
    };
  }

  const firstVisible = $derived(Math.max(0, indexAt(scrollTop) - OVERSCAN));
  const lastVisible = $derived(Math.min(rows.length, indexAt(scrollTop + viewportHeight) + 1 + OVERSCAN));
  const visible = $derived(rows.slice(firstVisible, lastVisible));
  const offsetY = $derived(offsets[firstVisible] ?? 0);

  // A new result means a new document: start at the top rather than halfway
  // down a diff the user has not seen.
  $effect(() => {
    void result;
    void mode;
    if (viewport) {
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
    }
    scrollTop = 0;
    scrollLeft = 0;
  });

  function onScroll(event: Event) {
    const el = event.currentTarget as HTMLElement;
    scrollTop = el.scrollTop;
    scrollLeft = el.scrollLeft;
  }

  function gutterClass(row: DiffRow | null) {
    if (!row) return 'bg-background';
    if (row.tag === 'insert') return 'bg-add-bg text-add-gutter';
    if (row.tag === 'delete') return 'bg-del-bg text-del-gutter';
    return 'bg-background text-muted-foreground';
  }

  function bodyClass(row: DiffRow | null) {
    if (!row) return 'bg-muted/25';
    if (row.tag === 'insert') return 'bg-add-bg text-add-ink';
    if (row.tag === 'delete') return 'bg-del-bg text-del-ink';
    return 'text-foreground';
  }

  function marker(row: DiffRow | null) {
    if (!row) return '';
    if (row.tag === 'insert') return '+';
    if (row.tag === 'delete') return '−';
    return ' ';
  }

  // When wrapping, the cell must be allowed to shrink below its content
  // (`min-w-0`) so the text breaks. When not wrapping, it must NOT shrink —
  // otherwise a long line is clipped instead of widening the row into a
  // horizontal scroll.
  const textClass = $derived(
    wrap ? 'min-w-0 flex-1 whitespace-pre-wrap break-all' : 'flex-1 whitespace-pre',
  );
</script>

<!-- Off-screen probe: 100 characters of the row font, for the width measurement. -->
<span
  aria-hidden="true"
  class="pointer-events-none invisible absolute font-mono text-[12.5px] whitespace-pre"
  {@attach probe}>0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000</span
>

{#snippet inlineParts(row: DiffRow, parts: RenderedPart[], trailing: boolean)}
  {#each parts as part, index (index)}
    {#if part.emphasized}
      <!-- The words that actually changed within a changed line. -->
      <span class={row.tag === 'insert' ? 'bg-add-bg-strong rounded-xs' : 'bg-del-bg-strong rounded-xs'}
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
{#snippet cell(row: DiffRow | null, index: number, extra: string)}
  {#if panned}
    <!-- Fixed half width; the text moves inside it rather than widening the row. -->
    <span class="{bodyClass(row)} min-w-0 flex-1 overflow-hidden whitespace-pre {extra}">
      {#if row}
        {@const pan = panSliceFor(row)}
        <span class="block w-max" style:transform="translateX({pan.left - panX}px)">
          {@render inlineParts(row, pan.parts, pan.trailing)}
        </span>
      {/if}
    </span>
  {:else}
    {@render wholeCell(row, index, extra)}
  {/if}
{/snippet}

{#snippet wholeCell(row: DiffRow | null, index: number, extra: string)}
  {@const slice = row ? sliceFor(index, row) : null}
  <span
    class="{bodyClass(row)} {textClass} {extra} {slice ? 'relative block overflow-hidden' : ''}"
    style:height={slice ? `${heightOf(index)}px` : undefined}
  >
    {#if row}
      {#if slice}
        <span class="absolute inset-x-0 pr-4" style:top="{slice.top}px">
          {@render inlineParts(row, slice.parts, false)}
        </span>
      {:else}
        {@render inlineParts(row, renderSegments(row).parts, true)}
      {/if}
    {/if}
  </span>
{/snippet}

{#if result.identical}
  <div class="text-muted-foreground grid h-full place-items-center text-center">
    <div class="space-y-1">
      <p class="text-foreground text-sm">The two files are identical</p>
      <p class="text-xs">No differences to show.</p>
    </div>
  </div>
{:else}
  <div
    bind:this={viewport}
    bind:clientHeight={viewportHeight}
    bind:clientWidth={viewportWidth}
    onscroll={onScroll}
    style:tab-size={TAB_SIZE}
    class="h-full overflow-auto font-mono text-[12.5px] leading-5 {wrap
      ? 'overflow-x-hidden'
      : ''}"
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
              class="bg-muted/40 text-muted-foreground flex items-center gap-2 px-3 select-none"
              style:height="{LINE_HEIGHT}px"
            >
              <span class="h-px flex-1 bg-current opacity-20"></span>
              <span class="text-[11px] tabular-nums"
                >{formatCount(item.count)} unchanged {item.count === 1 ? 'line' : 'lines'}</span
              >
              <span class="h-px flex-1 bg-current opacity-20"></span>
            </div>
          {:else if item.kind === 'row'}
            <div class="flex">
              <span
                class="{gutterClass(
                  item.row,
                )} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
              >
                {item.row.oldLine ?? ''}
              </span>
              <span
                class="{gutterClass(
                  item.row,
                )} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
              >
                {item.row.newLine ?? ''}
              </span>
              <span class="{bodyClass(item.row)} w-4 shrink-0 text-center select-none">
                {marker(item.row)}
              </span>
              {@render cell(item.row, index, 'pr-4')}
            </div>
          {:else}
            <div class="flex">
              <!-- Left / original -->
              <span
                class="{gutterClass(
                  item.left,
                )} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
              >
                {item.left?.oldLine ?? ''}
              </span>
              {@render cell(item.left, index, 'border-r pr-4')}

              <!-- Right / changed -->
              <span
                class="{gutterClass(
                  item.right,
                )} w-14 shrink-0 pr-2 text-right tabular-nums opacity-70 select-none"
              >
                {item.right?.newLine ?? ''}
              </span>
              {@render cell(item.right, index, 'pr-4')}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}
