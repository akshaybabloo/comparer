import { isAbsolute, resolve } from 'node:path';

/**
 * The operands of `comparer left right`, resolved against the directory the app was
 * started from, with Chromium and Electron flags left out.
 *
 * A development run starts Electron as `electron [flags] .`, where `.` is the app
 * rather than something to compare, so it is only skipped when not packaged.
 */
export function resolvePaths(args: string[], options: { packaged: boolean; appPath: string; cwd: string }): string[] {
	return args
		.filter((arg) => !arg.startsWith('-'))
		.filter((arg) => options.packaged || (arg !== '.' && resolve(options.cwd, arg) !== resolve(options.appPath)))
		.map((arg) => (isAbsolute(arg) ? arg : resolve(options.cwd, arg)))
		.slice(0, 2);
}

/** A comparison opened before, remembered by the paths on each side. */
export type RecentComparison = {
	id: string;
	kind: 'file' | 'folder' | 'image';
	left: string;
	right: string;
	/** When it was last compared, in milliseconds since the epoch. */
	at: number;
};

export const RECENT_LIMIT = 10;

/** Puts a comparison at the top of the list, moving it there if it is already in it, and keeps the newest few. */
export function addRecent(
	list: RecentComparison[],
	entry: Omit<RecentComparison, 'id'>,
	limit = RECENT_LIMIT
): RecentComparison[] {
	const id = `${entry.kind}:${entry.left}\n${entry.right}`;
	return [{ ...entry, id }, ...list.filter((item) => item.id !== id)].slice(0, limit);
}

/** The remembered list as read back from disk, dropping anything that is not a well-formed entry. */
export function parseRecent(json: string): RecentComparison[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is RecentComparison =>
			typeof item === 'object' &&
			item !== null &&
			typeof item.id === 'string' &&
			['file', 'folder', 'image'].includes(item.kind) &&
			typeof item.left === 'string' &&
			typeof item.right === 'string' &&
			typeof item.at === 'number'
	);
}
