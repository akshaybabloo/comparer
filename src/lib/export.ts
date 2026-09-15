import type { DiffRow } from './diff-types';

/**
 * Turns a diff's rows into files to share: a unified patch that `git apply` and
 * `patch` understand, or a standalone HTML report. Pure, so the service can write
 * either without a window, and tests can check the output exactly.
 */

/** Unchanged lines kept either side of a change, as `diff -u` does. */
export const EXPORT_CONTEXT_LINES = 3;

export type ExportFormat = 'patch' | 'html';

export type ExportLabels = { left: string; right: string };

type Span = { start: number; end: number };

/** The stretches of rows around changes, `context` unchanged rows either side, merged where they touch. */
function hunkSpans(rows: DiffRow[], context: number): Span[] {
	const spans: Span[] = [];
	rows.forEach((row, index) => {
		if (row.tag === 'equal') return;
		const start = Math.max(0, index - context);
		const end = Math.min(rows.length, index + context + 1);
		const last = spans.at(-1);
		if (last && start <= last.end) last.end = Math.max(last.end, end);
		else spans.push({ start, end });
	});
	return spans;
}

function lineText(row: DiffRow): string {
	return row.segments.map((segment) => segment.value).join('');
}

/** `-3,4`: where a hunk starts on one side and how many lines it covers. An empty side names the line before it. */
function hunkRange(rows: DiffRow[], span: Span, side: 'oldLine' | 'newLine'): string {
	let before = 0;
	for (let i = 0; i < span.start; i++) if (rows[i][side] !== null) before++;
	let count = 0;
	for (let i = span.start; i < span.end; i++) if (rows[i][side] !== null) count++;
	const start = count === 0 ? before : before + 1;
	return count === 1 ? `${start}` : `${start},${count}`;
}

/** A unified diff of the rows, empty when nothing changed. */
export function toPatch(rows: DiffRow[], labels: ExportLabels, context = EXPORT_CONTEXT_LINES): string {
	const spans = hunkSpans(rows, context);
	if (spans.length === 0) return '';
	const out = [`--- a/${labels.left}`, `+++ b/${labels.right}`];
	for (const span of spans) {
		out.push(`@@ -${hunkRange(rows, span, 'oldLine')} +${hunkRange(rows, span, 'newLine')} @@`);
		for (let i = span.start; i < span.end; i++) {
			const row = rows[i];
			const marker = row.tag === 'insert' ? '+' : row.tag === 'delete' ? '-' : ' ';
			out.push(marker + lineText(row));
			if (row.missingNewline) out.push('\\ No newline at end of file');
		}
	}
	return out.join('\n') + '\n';
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const REPORT_STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --muted: #6e7781; --line: #d0d7de;
  --add: #e6ffec; --add-strong: #abf2bc; --del: #ffebe9; --del-strong: #ff818266; --gap: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d;
  --add: #12261e; --add-strong: #1f6f3f; --del: #25171c; --del-strong: #8e1519aa; --gap: #161b22; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; overflow-wrap: anywhere; }
p { margin: 0 0 16px; color: var(--muted); }
.add-count { color: #1a7f37; } .del-count { color: #cf222e; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font: 12.5px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
td { padding: 0 8px; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
td.num { width: 1%; min-width: 3ch; text-align: right; color: var(--muted); user-select: none; white-space: nowrap; }
td.mark { width: 1ch; padding: 0 4px; user-select: none; }
tr.insert td { background: var(--add); } tr.delete td { background: var(--del); }
tr.insert em { background: var(--add-strong); font-style: normal; } tr.delete em { background: var(--del-strong); font-style: normal; }
tr.gap td { background: var(--gap); color: var(--muted); text-align: center; font-family: system-ui, sans-serif; font-size: 12px; }
.note { color: var(--muted); font-style: italic; }
`;

/** A standalone HTML page showing the changes with `context` lines around them, readable without the app. */
export function toHtmlReport(rows: DiffRow[], labels: ExportLabels, context = EXPORT_CONTEXT_LINES): string {
	const added = rows.filter((row) => row.tag === 'insert').length;
	const removed = rows.filter((row) => row.tag === 'delete').length;
	const title = `${labels.left} → ${labels.right}`;
	const body: string[] = [];
	let previousEnd = 0;

	const gap = (count: number) =>
		body.push(`<tr class="gap"><td colspan="4">${count} unchanged ${count === 1 ? 'line' : 'lines'}</td></tr>`);

	for (const span of hunkSpans(rows, context)) {
		if (span.start > previousEnd) gap(span.start - previousEnd);
		for (let i = span.start; i < span.end; i++) {
			const row = rows[i];
			const text = row.segments
				.map((segment) => (segment.emphasized ? `<em>${escapeHtml(segment.value)}</em>` : escapeHtml(segment.value)))
				.join('');
			const note = row.missingNewline ? ' <span class="note">⏎ no newline at end of file</span>' : '';
			const marker = row.tag === 'insert' ? '+' : row.tag === 'delete' ? '−' : '';
			body.push(
				`<tr class="${row.tag}"><td class="num">${row.oldLine ?? ''}</td><td class="num">${row.newLine ?? ''}</td>` +
					`<td class="mark">${marker}</td><td>${text}${note}</td></tr>`
			);
		}
		previousEnd = span.end;
	}
	if (body.length > 0 && rows.length > previousEnd) gap(rows.length - previousEnd);

	const summary =
		added === 0 && removed === 0
			? 'The two files are identical.'
			: `<span class="add-count">+${added}</span> <span class="del-count">−${removed}</span> lines`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${summary}</p>
${body.length > 0 ? `<div class="scroll"><table>\n${body.join('\n')}\n</table></div>` : ''}
</body>
</html>
`;
}
