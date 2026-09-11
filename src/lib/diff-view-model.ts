import type { DiffHunk, DiffRow, DiffSegment } from './diff-types';

export type VisualRow =
  /** Stands in for equal lines omitted between two hunks. */
  | { kind: 'collapsed'; key: string; count: number }
  /** Unified: one source line. */
  | { kind: 'row'; key: string; row: DiffRow }
  /** Split: the same line on both sides, either of which may be absent. */
  | { kind: 'pair'; key: string; left: DiffRow | null; right: DiffRow | null };

/** Must match the `tab-size` the rows are rendered with. */
export const TAB_SIZE = 4;

export type RenderedPart = { kind: 'text'; emphasized: boolean; value: string };

export type RenderedLine = {
  parts: RenderedPart[];
};

/**
 * How many monospace columns a row occupies once tabs are expanded.
 *
 * The font is monospace, so this is enough to work out how many lines a row
 * wraps to without measuring anything in the DOM — which matters because the
 * height of every row has to be known to virtualise the list, including the
 * ones currently scrolled out of view.
 */
export function columnsOf(row: DiffRow | null): number {
  if (!row) return 0;
  let columns = 0;
  for (const segment of row.segments) {
    const value = segment.value;
    // The per-character walk is only needed when tabs are present; otherwise
    // the length is the column count, which keeps this cheap across 100k rows.
    if (value.includes('\t')) {
      for (const char of value) {
        columns += char === '\t' ? TAB_SIZE - (columns % TAB_SIZE) : 1;
      }
    } else {
      columns += value.length;
    }
  }
  return columns;
}

/** Every segment of the row, in full — nothing is clipped or hidden. */
export function renderSegments(row: DiffRow): RenderedLine {
  return {
    parts: row.segments.map((segment) => ({
      kind: 'text' as const,
      emphasized: segment.emphasized,
      value: segment.value,
    })),
  };
}

/** One row per source line, deletions immediately before their insertions. */
export function toUnifiedRows(hunks: DiffHunk[]): VisualRow[] {
  const out: VisualRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    if (hunk.collapsedBefore > 0) {
      out.push({ kind: 'collapsed', key: `c${hunkIndex}`, count: hunk.collapsedBefore });
    }
    hunk.rows.forEach((row, rowIndex) => {
      out.push({ kind: 'row', key: `${hunkIndex}:${rowIndex}`, row });
    });
  });
  return out;
}

/**
 * Two columns. Consecutive deletions and insertions are zipped so an edited
 * line sits opposite the line it replaced; an unmatched surplus on either side
 * gets a blank cell facing it.
 */
export function toSplitRows(hunks: DiffHunk[]): VisualRow[] {
  const out: VisualRow[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunk.collapsedBefore > 0) {
      out.push({ kind: 'collapsed', key: `c${hunkIndex}`, count: hunk.collapsedBefore });
    }

    const rows = hunk.rows;
    let i = 0;
    let pairIndex = 0;

    while (i < rows.length) {
      if (rows[i].tag === 'equal') {
        out.push({
          kind: 'pair',
          key: `${hunkIndex}:${pairIndex++}`,
          left: rows[i],
          right: rows[i],
        });
        i++;
        continue;
      }

      // Gather the whole delete/insert block, then zip the two sides.
      const deletions: DiffRow[] = [];
      const insertions: DiffRow[] = [];
      while (i < rows.length && rows[i].tag !== 'equal') {
        if (rows[i].tag === 'delete') deletions.push(rows[i]);
        else insertions.push(rows[i]);
        i++;
      }

      const height = Math.max(deletions.length, insertions.length);
      for (let j = 0; j < height; j++) {
        out.push({
          kind: 'pair',
          key: `${hunkIndex}:${pairIndex++}`,
          left: deletions[j] ?? null,
          right: insertions[j] ?? null,
        });
      }
    }
  });

  return out;
}
