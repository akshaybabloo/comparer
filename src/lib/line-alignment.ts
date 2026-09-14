/**
 * How the lines of two texts correspond, and the arithmetic that keeps two editors level
 * as they scroll. The change marks shared by the minimaps are typed here too.
 *
 * Only the changed stretches are listed. Everything between them is equal on both
 * sides, so a line there maps across by a constant offset.
 */

/** Lines that differ between the two texts, as zero-based ranges with exclusive ends. */
export type LineChunk = { leftStart: number; leftEnd: number; rightStart: number; rightEnd: number };

export type Side = 'left' | 'right';

export type ChangeKind = 'add' | 'del' | 'mod' | 'unknown';

/**
 * The text with whitespace trimmed from both ends of every line, keeping the line count,
 * so a diff of two such texts still numbers its lines like the originals.
 *
 * Aligning the editors ignores that whitespace: a re-indented file otherwise has every
 * line changed, and the few that happen to match — a line two levels deep on one side
 * against one level deep on the other — pull the two sides wildly out of step.
 */
export function trimLines(text: string): string {
	return text
		.split('\n')
		.map((line) => line.trim())
		.join('\n');
}

/** A run of something changed, in whatever unit its caller measures in (lines, rows, pixels). */
export type ChangeMark = { start: number; end: number; kind: ChangeKind };

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

function range(chunk: LineChunk, side: Side): [number, number] {
	return side === 'left' ? [chunk.leftStart, chunk.leftEnd] : [chunk.rightStart, chunk.rightEnd];
}

/**
 * Folds a line diff into its changed stretches: every run of consecutive deleted and
 * inserted lines becomes one chunk.
 */
export function chunksFromLines(lines: Iterable<{ tag: string }>): LineChunk[] {
	const chunks: LineChunk[] = [];
	let left = 0;
	let right = 0;
	let open: LineChunk | null = null;

	for (const line of lines) {
		if (line.tag === 'equal') {
			open = null;
			left++;
			right++;
			continue;
		}
		if (!open) {
			open = { leftStart: left, leftEnd: left, rightStart: right, rightEnd: right };
			chunks.push(open);
		}
		if (line.tag === 'delete') open.leftEnd = ++left;
		else open.rightEnd = ++right;
	}
	return chunks;
}

/**
 * The line on the other side matching `line` on `from`, both fractional so scrolling
 * stays smooth within a line.
 *
 * In an equal stretch that is a constant offset. Inside a changed chunk the position
 * moves proportionally across the other side's chunk, so ten deleted lines on the left
 * sweep once across whatever replaced them on the right; where the other side has no
 * lines at all, it waits at that point.
 */
export function mapLine(chunks: readonly LineChunk[], line: number, from: Side): number {
	const to = other(from);
	// The last chunk starting at or before the line.
	let low = 0;
	let high = chunks.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (range(chunks[mid], from)[0] <= line) low = mid + 1;
		else high = mid;
	}
	if (low === 0) return line;

	const chunk = chunks[low - 1];
	const [fromStart, fromEnd] = range(chunk, from);
	const [toStart, toEnd] = range(chunk, to);
	if (line >= fromEnd) return toEnd + (line - fromEnd);
	return toStart + ((line - fromStart) / (fromEnd - fromStart)) * (toEnd - toStart);
}
