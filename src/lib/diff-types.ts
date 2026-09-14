import type { FolderDiff } from 'comparer-ts';

export type DiffTag = 'equal' | 'delete' | 'insert';

export type DiffSegment = {
	emphasized: boolean;
	value: string;
};

export type DiffRow = {
	tag: DiffTag;
	/** 1-based line number in the left document, or null for inserted lines. */
	oldLine: number | null;
	/** 1-based line number in the right document, or null for deleted lines. */
	newLine: number | null;
	segments: DiffSegment[];
	/** The source line had no trailing newline. */
	missingNewline: boolean;
};

/**
 * A run of rows around one or more changes. Equal stretches between hunks are
 * dropped, which is what keeps a 100k-line file with three edits small.
 */
export type DiffHunk = {
	rows: DiffRow[];
	/** Equal lines collapsed between the previous hunk and this one. */
	collapsedBefore: number;
};

export type DiffStats = {
	added: number;
	removed: number;
	/** Rows actually kept across all hunks. */
	rows: number;
};

export type DiffResult = {
	hunks: DiffHunk[];
	stats: DiffStats;
	identical: boolean;
	/** Set when the diff was cut short because it exceeded `maxRows`. */
	truncated: boolean;
	elapsedMs: number;
};

export type FolderDiffResult = FolderDiff & {
	elapsedMs: number;
};

export type ImageSize = { width: number; height: number };

/**
 * Two images compared pixel by pixel, or found to be different sizes, which
 * cannot be compared pixel by pixel but can still be looked at side by side.
 */
export type ImageDiffResult =
	| {
			kind: 'compared';
			size: ImageSize;
			/** The tolerance this result was computed at, from 0 to 100. */
			tolerance: number;
			differentPixels: number;
			totalPixels: number;
			/** `differentPixels` as a percentage of `totalPixels`. */
			percent: number;
			identical: boolean;
			/** Differing pixels red, the rest of the left image faded to grey, as PNG. */
			diffPng: Uint8Array;
			elapsedMs: number;
	  }
	| { kind: 'sizeMismatch'; left: ImageSize; right: ImageSize; elapsedMs: number };

/** How far a folder comparison has got, reported while it runs. */
export type FolderProgress =
	/** Listing both folders; `entries` counts every entry found so far. */
	| { phase: 'list'; entries: number }
	/** Hashing files whose sizes match; `done` and `total` count files. */
	| { phase: 'hash'; done: number; total: number; bytes: number };

export type DiffRequest = {
	type: 'diff';
	id: number;
	oldText: string;
	newText: string;
	/** Equal lines to keep either side of a change. */
	context: number;
	/** Stop after this many kept rows, to keep a pathological diff renderable. */
	maxRows: number;
};

export type DiffResponse =
	/** Sent once, after the worker has installed its message handler. */
	| { type: 'ready' }
	| { type: 'result'; id: number; result: DiffResult }
	| { type: 'error'; id: number; message: string };
