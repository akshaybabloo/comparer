import { generateInlineDiff } from 'comparer-ts';
import type { DiffHunk, DiffRow, DiffTag } from './diff-types';

/**
 * Pure diff shaping, kept out of `diff.worker.ts` so it can be exercised
 * without a worker environment.
 */

export function toRows(oldText: string, newText: string): DiffRow[] {
  return generateInlineDiff(oldText, newText).map((line) => ({
    tag: line.tag as DiffTag,
    // comparer-ts reports 0-based indices; editors count from 1.
    oldLine: line.old_line === null ? null : line.old_line + 1,
    newLine: line.new_line === null ? null : line.new_line + 1,
    segments: line.segments,
    missingNewline: line.missing_newline,
  }));
}

/**
 * Keeps only the rows near a change, plus `context` equal lines either side,
 * and records how many equal lines were dropped between each kept run. This is
 * what stops a 100k-line file with three edits from shipping 100k rows to the
 * renderer.
 */
export function toHunks(rows: DiffRow[], context: number, maxRows: number) {
  const changed: number[] = [];
  let added = 0;
  let removed = 0;

  for (let i = 0; i < rows.length; i++) {
    const tag = rows[i].tag;
    if (tag === 'equal') continue;
    changed.push(i);
    if (tag === 'insert') added++;
    else removed++;
  }

  if (changed.length === 0) {
    return { hunks: [] as DiffHunk[], added, removed, kept: 0, truncated: false };
  }

  // Merge the context windows around each change into non-overlapping ranges.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    // `<= last.end + 1` merges ranges that merely touch, so two nearby edits do
    // not leave a one-line island stranded between them.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const hunks: DiffHunk[] = [];
  let kept = 0;
  let truncated = false;
  let previousEnd = -1;

  for (const range of ranges) {
    if (kept >= maxRows) {
      truncated = true;
      break;
    }
    let end = range.end;
    if (kept + (end - range.start + 1) > maxRows) {
      end = range.start + (maxRows - kept) - 1;
      truncated = true;
    }

    hunks.push({
      rows: rows.slice(range.start, end + 1),
      collapsedBefore: range.start - previousEnd - 1,
    });
    kept += end - range.start + 1;
    previousEnd = end;
  }

  return { hunks, added, removed, kept, truncated };
}
