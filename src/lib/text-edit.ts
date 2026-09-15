/**
 * Line-level text edits for copying a change from one side of a diff to the
 * other. Pure, so the service applies them and tests can exercise them directly.
 */

/** Lines `from` up to, but not including, `to`, counted from 0. Empty when they are equal. */
export type LineRange = { from: number; to: number };

/** Where one change sits on each side: the lines it covers on the left and on the right. */
export type ChangeRange = { left: LineRange; right: LineRange };

/** Offset of the start of a 0-based line, or the end of the text for a line past the last. */
function offsetOfLine(text: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const next = text.indexOf('\n', offset);
		if (next < 0) return text.length;
		offset = next + 1;
	}
	return offset;
}

/** The line ending a text already uses, so copied lines match it. */
function lineEnding(text: string): string {
	const first = text.indexOf('\n');
	return first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Replaces the lines `into` of `target` with the lines `from` of `source`.
 *
 * The copied lines take on the target's line ending, and the target keeps
 * whether it ends in a newline, so copying a change never adds a stray
 * difference of its own.
 */
export function replaceLines(target: string, source: string, into: LineRange, from: LineRange): string {
	const eol = lineEnding(target);
	let lines = source.slice(offsetOfLine(source, from.from), offsetOfLine(source, from.to)).replace(/\r?\n/g, eol);
	const start = offsetOfLine(target, into.from);
	const end = offsetOfLine(target, into.to);
	const atEnd = end >= target.length;
	const endsInNewline = target.length === 0 || target.endsWith('\n');

	if (lines && !lines.endsWith('\n') && !atEnd) lines += eol;
	// Adding after a last line that has no newline: that line needs one first.
	if (lines && start >= target.length && start > 0 && !target.endsWith('\n')) lines = eol + lines;

	let result = target.slice(0, start) + lines + target.slice(end);
	// Keep the target's final newline, or its absence, as it was.
	if (atEnd && !endsInNewline && result.endsWith('\n')) result = result.slice(0, result.endsWith('\r\n') ? -2 : -1);
	return result;
}
