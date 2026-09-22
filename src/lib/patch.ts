/**
 * Reading a unified diff back into the two texts it describes, so a patch can be
 * compared with the same side-by-side view as two files.
 *
 * Only what the hunks quote can be recovered: a patch carries the changed lines and a
 * few lines of context, not the whole file. The stretches between hunks are simply not
 * there, so the reconstruction is the hunks one after another, and its line numbers are
 * the patch's own rather than the original file's. Nothing is invented to fill the gaps
 * — a marker line would show up in the diff as content, and would be saved as content
 * if the text were exported.
 *
 * Understands the unified format as `diff -u`, `git diff` and `patch` files write it.
 * Combined diffs from a merge (`@@@`) are not hunks of two texts and are skipped.
 */

/**
 * A hunk header: `@@ -1,4 +1,6 @@`, with the counts optional as they are for a single
 * line. The counts are what say where the hunk ends, which matters for a patch quoted in
 * an email or an issue: the blank line after it is prose, not an empty context line.
 */
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** `--- a/src/main.ts` or `+++ b/src/main.ts`, with a `diff -u` timestamp after a tab. */
const OLD_NAME = /^--- (.*)$/;
const NEW_NAME = /^\+\+\+ (.*)$/;

const GIT_HEADER = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;
const BINARY = /^(?:Binary files .* differ|GIT binary patch)/;

/** What a patch says about one file. */
export type PatchFile = {
	/** The path the patch names, without git's `a/` or `b/` prefix. */
	name: string;
	/**
	 * What each side was called. Usually the same name twice, but a `diff -u` of two
	 * unrelated files names both, and so does a rename — and then labelling both sides
	 * with one of the names is simply wrong. `/dev/null` is not a name, so a side that
	 * did not exist borrows the other's.
	 */
	beforeName: string;
	afterName: string;
	/** The lines the hunks quote, hunk after hunk, as the file was and as it became. */
	before: string;
	after: string;
	/** A change the patch describes but does not quote, so there is nothing to show. */
	binary: boolean;
};

/** Drops git's `a/`, `b/` prefix, a `diff -u` timestamp, and the quotes git adds to an odd name. */
function cleanName(raw: string): string {
	const name = raw
		.split('\t')[0]
		.trim()
		.replace(/^"(.*)"$/, '$1');
	return name.replace(/^[ab]\//, '');
}

/** The name to show for a file, preferring where it ended up over where it came from. */
function nameOf(oldName: string | null, newName: string | null, fromHeader: string | null): string {
	for (const candidate of [newName, oldName, fromHeader]) {
		if (candidate && candidate !== '/dev/null') return candidate;
	}
	return 'patch';
}

type Building = {
	oldName: string | null;
	newName: string | null;
	fromHeader: string | null;
	before: string[];
	after: string[];
	binary: boolean;
	/** The last line of a side had no terminator, as `\ No newline at end of file` says. */
	beforeEndsBare: boolean;
	afterEndsBare: boolean;
	/** Inside a hunk, so a line starting with `-` is a removal rather than a header. */
	inHunk: boolean;
	/** Lines of each side the hunk header still promises. */
	oldLeft: number;
	newLeft: number;
};

function start(): Building {
	return {
		oldName: null,
		newName: null,
		fromHeader: null,
		before: [],
		after: [],
		binary: false,
		beforeEndsBare: false,
		afterEndsBare: false,
		inHunk: false,
		oldLeft: 0,
		newLeft: 0
	};
}

/** Nothing has been read for this file yet, so there is no file. */
function isEmpty(file: Building): boolean {
	return !file.binary && file.before.length === 0 && file.after.length === 0;
}

function join(lines: string[], endsBare: boolean): string {
	if (lines.length === 0) return '';
	return lines.join('\n') + (endsBare ? '' : '\n');
}

function finish(file: Building, into: PatchFile[]): void {
	if (isEmpty(file)) return;
	const name = nameOf(file.oldName, file.newName, file.fromHeader);
	const sideName = (side: string | null) => (side && side !== '/dev/null' ? side : name);
	into.push({
		name,
		beforeName: sideName(file.oldName),
		afterName: sideName(file.newName),
		before: join(file.before, file.beforeEndsBare),
		after: join(file.after, file.afterEndsBare),
		binary: file.binary
	});
}

/**
 * Every file a patch describes, in the order it describes them. Text that holds no diff
 * at all gives an empty list, which is how the caller can tell it apart from a patch.
 */
export function parsePatch(text: string): PatchFile[] {
	const files: PatchFile[] = [];
	let file = start();
	// `\` is a marker about the line before it, so which side it belongs to depends on
	// what that line was.
	let lastSide: 'before' | 'after' | 'both' | null = null;

	const lines = text.split('\n');
	// A text ending in a newline splits with an empty last element, which is the end of
	// the text rather than an empty context line.
	if (lines.at(-1) === '') lines.pop();

	for (const raw of lines) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

		const git = GIT_HEADER.exec(line);
		if (git) {
			finish(file, files);
			file = start();
			file.fromHeader = cleanName(git[2] || git[1]);
			lastSide = null;
			continue;
		}

		if (BINARY.test(line)) {
			file.binary = true;
			file.inHunk = false;
			continue;
		}

		// A name header starts a new file unless it is this file's own, which is the pair
		// that came right before its hunks.
		const oldName = OLD_NAME.exec(line);
		if (oldName && !file.inHunk) {
			// A second `---` means a new file: patches from `diff -u` are often just
			// concatenated, with no `diff --git` line to separate them.
			if (file.oldName !== null || !isEmpty(file)) {
				finish(file, files);
				file = start();
				lastSide = null;
			}
			file.oldName = cleanName(oldName[1]);
			continue;
		}

		const newName = NEW_NAME.exec(line);
		if (newName && !file.inHunk) {
			file.newName = cleanName(newName[1]);
			continue;
		}

		const hunk = HUNK.exec(line);
		if (hunk) {
			file.inHunk = true;
			// A header without a count covers exactly one line.
			file.oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			file.newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			lastSide = null;
			continue;
		}

		// `\ No newline at end of file` is a note about the line before it rather than a
		// line of either text, so it is not counted and can follow the hunk's last line.
		if (line.startsWith('\\') && lastSide !== null) {
			if (lastSide === 'before' || lastSide === 'both') file.beforeEndsBare = true;
			if (lastSide === 'after' || lastSide === 'both') file.afterEndsBare = true;
			continue;
		}

		if (!file.inHunk) continue;

		if (line.startsWith('-')) {
			file.before.push(line.slice(1));
			file.oldLeft--;
			lastSide = 'before';
		} else if (line.startsWith('+')) {
			file.after.push(line.slice(1));
			file.newLeft--;
			lastSide = 'after';
		} else if (line.startsWith(' ') || line === '') {
			// A context line is in both texts. Some tools write an empty context line as a
			// bare empty line rather than a single space.
			const content = line.slice(1);
			file.before.push(content);
			file.after.push(content);
			file.oldLeft--;
			file.newLeft--;
			lastSide = 'both';
		} else {
			// Anything else ends the hunk: a git trailer, a mode line, or prose around the
			// patch in an email or an issue.
			file.inHunk = false;
			continue;
		}

		// The header said how long the hunk is; past that, what follows is not the hunk's,
		// however much it looks like a context line.
		if (file.oldLeft <= 0 && file.newLeft <= 0) file.inHunk = false;
	}

	finish(file, files);
	return files;
}

/** How many other names to spell out before falling back to counting them. */
const NAMES_LISTED = 3;

/**
 * What is worth saying about a patch beyond the file on screen: which one is shown, and
 * what else the patch changes. Empty when the patch describes only that file.
 */
export function patchNote(files: PatchFile[], shown: PatchFile): string {
	const others = files.filter((file) => file !== shown);
	if (others.length === 0) return '';

	const names = others.map((file) => (file.binary ? `${file.name} (binary)` : file.name));
	const listed = names.slice(0, NAMES_LISTED).join(', ');
	const rest = names.length - NAMES_LISTED;
	const all = rest > 0 ? `${listed} and ${rest} more` : listed;
	return `Showing ${shown.name}; the patch also changes ${all}.`;
}
