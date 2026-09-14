import type { EntryKind, FsEntry } from 'comparer-ts';
import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directories read at once. Each one also stats its entries in parallel, so
 * the real fan-out into libuv's thread pool is this times `STAT_BATCH`.
 */
const DIRECTORY_CONCURRENCY = 8;
const STAT_BATCH = 64;

/**
 * Lists every entry under `root` — hidden files, `.git`, `node_modules` and
 * special files included — as the flat, `/`-separated listing comparer-ts
 * compares.
 *
 * Symlinks are recorded with their target but never followed, which keeps a
 * link cycle from looping and a linked folder from being listed twice. An entry
 * that cannot be stat'ed, or a folder that cannot be listed, is still reported,
 * carrying an `error`, rather than silently dropped.
 *
 * Only a root that cannot be listed at all fails the call.
 */
export async function listFolder(
	root: string,
	signal: AbortSignal,
	onEntries: (count: number) => void
): Promise<FsEntry[]> {
	const entries: FsEntry[] = [];
	// The root has no entry of its own, so a failure to list it has nowhere to be
	// recorded and fails the whole listing instead.
	const pending: Array<{ path: string; entry: FsEntry | null }> = [{ path: '', entry: null }];
	let active = 0;

	await new Promise<void>((resolve, reject) => {
		let failed = false;
		const fail = (error: unknown) => {
			failed = true;
			reject(error);
		};

		const pump = () => {
			if (failed) return;
			if (signal.aborted) return fail(signal.reason);
			if (pending.length === 0 && active === 0) return resolve();

			while (active < DIRECTORY_CONCURRENCY && pending.length > 0) {
				const folder = pending.pop()!;
				active++;
				readFolder(root, folder.path, signal)
					.then(
						(children) => {
							entries.push(...children);
							onEntries(children.length);
							for (const child of children) {
								if (child.kind === 'dir' && !child.error) pending.push({ path: child.path, entry: child });
							}
						},
						(error: unknown) => {
							if (folder.entry && !signal.aborted) folder.entry.error = describe(error);
							else fail(error);
						}
					)
					.finally(() => {
						active--;
						pump();
					});
			}
		};

		pump();
	});

	return entries;
}

async function readFolder(root: string, path: string, signal: AbortSignal): Promise<FsEntry[]> {
	const dirents = await readdir(join(root, path), { withFileTypes: true });
	const children: FsEntry[] = [];

	for (let i = 0; i < dirents.length; i += STAT_BATCH) {
		signal.throwIfAborted();
		const batch = dirents.slice(i, i + STAT_BATCH);
		children.push(
			...(await Promise.all(
				batch.map((dirent) => describeEntry(root, path ? `${path}/${dirent.name}` : dirent.name, dirent))
			))
		);
	}

	return children;
}

async function describeEntry(root: string, path: string, dirent: Dirent): Promise<FsEntry> {
	const absolute = join(root, path);
	let stats: BigIntStats;
	try {
		stats = await lstat(absolute, { bigint: true });
	} catch (error) {
		// Keep whatever the directory listing already said about the entry, so it
		// still shows up in the tree with the right icon.
		return {
			path,
			kind: kindOf(dirent),
			size: 0,
			mode: 0,
			uid: 0,
			gid: 0,
			mtime_ns: '0',
			error: describe(error)
		};
	}

	const kind = kindOf(stats);
	const entry: FsEntry = {
		path,
		kind,
		size: Number(stats.size),
		mode: Number(stats.mode),
		uid: Number(stats.uid),
		gid: Number(stats.gid),
		mtime_ns: stats.mtimeNs.toString()
	};

	if (kind === 'symlink') {
		try {
			entry.link_target = await readlink(absolute);
		} catch (error) {
			entry.error = describe(error);
		}
	}

	return entry;
}

function kindOf(info: Pick<Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>): EntryKind {
	if (info.isSymbolicLink()) return 'symlink';
	if (info.isDirectory()) return 'dir';
	if (info.isFile()) return 'file';
	return 'other';
}

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
