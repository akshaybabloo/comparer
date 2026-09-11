/// <reference lib="webworker" />
import { generateInlineDiff } from 'comparer-ts';
import type { DiffHunk, DiffRequest, DiffResponse, DiffResult, DiffRow, DiffTag } from './diff-types';

/**
 * The diff runs here rather than on the main thread because the WebAssembly
 * call is synchronous and blocking: on a large pair of files it would freeze
 * the window for as long as it takes.
 */

function toRows(oldText: string, newText: string): DiffRow[] {
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
 * and records how many equal lines were dropped between each kept run.
 */
function toHunks(rows: DiffRow[], context: number, maxRows: number) {
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
    // `<= last.end + 1` merges ranges that touch, so two nearby edits do not
    // produce a one-line island between them.
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

function runDiff(request: DiffRequest): DiffResult {
  const startedAt = performance.now();
  const rows = toRows(request.oldText, request.newText);
  const { hunks, added, removed, kept, truncated } = toHunks(rows, request.context, request.maxRows);

  return {
    hunks,
    stats: { added, removed, rows: kept },
    identical: added === 0 && removed === 0,
    truncated,
    elapsedMs: performance.now() - startedAt,
  };
}

self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const request = event.data;
  if (request?.type !== 'diff') return;

  const reply = (response: DiffResponse) => self.postMessage(response);

  try {
    reply({ type: 'result', id: request.id, result: runDiff(request) });
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
