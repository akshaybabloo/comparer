import type { DiffResult, FolderDiffResult, FolderProgress, ImageDiffResult } from '../lib/diff-types';
import type { LineChunk } from '../lib/line-alignment';
import type { ExportFormat, ExportLabels } from '../lib/export';
import type { LineRange } from '../lib/text-edit';
import type { RecentComparison } from './launch';

/**
 * The contract between the renderer, the main process and the diff service.
 *
 * Deliberately narrow: the renderer can open a file, image or folder the user dropped
 * or picked, read a slice of a document or the bytes of an image it has opened, and
 * diff two documents, two images or two folders. There is no general "read this file"
 * call, because that would hand any code running in the renderer the ability to read
 * the whole filesystem.
 */

/** Identifies a document held by the service. Opaque to the renderer. */
export type DocumentId = string;

export type DocumentInfo = {
	kind: 'file';
	id: DocumentId;
	name: string;
	/** Absolute path on disk, or null for text that never came from a file. */
	path: string | null;
	/** Bytes on disk, or UTF-16 length for text typed into the app. */
	size: number;
	lineCount: number;
};

/** A folder the user dropped or picked. Its contents stay in the service. */
export type FolderInfo = {
	kind: 'folder';
	id: DocumentId;
	name: string;
	/** Absolute path on disk. */
	path: string;
};

/**
 * An image the user dropped or picked, recognised by its contents rather than its
 * name. Its bytes stay in the service; the renderer reads them to preview it.
 */
export type ImageInfo = {
	kind: 'image';
	id: DocumentId;
	name: string;
	/** Absolute path on disk. */
	path: string;
	/** Bytes on disk. */
	size: number;
};

/** What opening a path produces: a text document, an image, or a folder. */
export type OpenedInfo = DocumentInfo | ImageInfo | FolderInfo;

/** A path given on the command line or remembered from before, opened, or why it could not be. */
export type LaunchItem = { path: string; opened: OpenedInfo } | { path: string; error: string };

/** What a native file picker offers: any file, or only the image formats that can be compared. */
export type PickKind = 'file' | 'image';

/**
 * One entry of a folder comparison, opened on both sides so it can be diffed
 * like any two files. Binary files are reported rather than opened, since a
 * text diff of them would be noise.
 */
export type FolderEntryDocuments = { kind: 'text'; left: DocumentInfo; right: DocumentInfo } | { kind: 'binary' };

export type Chunk = {
	text: string;
	/** Offset this chunk starts at, in UTF-16 code units. */
	from: number;
	/** Offset just past the end of this chunk. */
	to: number;
	/** Nothing follows `to`. */
	atEnd: boolean;
};

/** Requests sent from main into the service. */
export type ServiceRequest =
	| { type: 'open'; id: number; path: string }
	| { type: 'adopt'; id: number; docId: DocumentId; text: string; name: string }
	| { type: 'chunk'; id: number; docId: DocumentId; from: number; maxBytes: number }
	| { type: 'diff'; id: number; left: DocumentId | null; right: DocumentId | null; context: number; maxRows: number }
	| { type: 'diffFolders'; id: number; left: DocumentId; right: DocumentId }
	| { type: 'openFolderEntry'; id: number; left: DocumentId; right: DocumentId; path: string }
	| { type: 'lineChunks'; id: number; left: DocumentId; right: DocumentId }
	| { type: 'replaceLines'; id: number; target: DocumentId; source: DocumentId; into: LineRange; from: LineRange }
	| { type: 'describe'; id: number; docId: DocumentId }
	| { type: 'pathOf'; id: number; docId: DocumentId }
	| {
			type: 'exportDiff';
			id: number;
			left: DocumentId | null;
			right: DocumentId | null;
			format: ExportFormat;
			labels: ExportLabels;
			path: string;
	  }
	| { type: 'save'; id: number; docId: DocumentId; path: string }
	| { type: 'readImage'; id: number; docId: DocumentId }
	| { type: 'diffImages'; id: number; left: DocumentId; right: DocumentId; tolerance: number }
	/** Stops the in-flight request with id `target`, which then fails as cancelled. */
	| { type: 'cancel'; id: number; target: number }
	| { type: 'close'; id: number; docId: DocumentId };

/**
 * `Omit` over a union collapses it to the keys every member shares, which for
 * `ServiceRequest` is just `type`. Distributing keeps each variant intact.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PendingServiceRequest = DistributiveOmit<ServiceRequest, 'id'>;

export type ServiceResponse =
	| { type: 'ready' }
	| { type: 'ok'; id: number; value: unknown }
	/** Sent any number of times before a long request's `ok` or `error`. */
	| { type: 'progress'; id: number; progress: FolderProgress }
	| { type: 'error'; id: number; message: string };

/** The API the preload exposes on `window.comparer`. */
export type ComparerBridge = {
	/** Resolves a dropped File, which may be a folder, to its path and opens it in the service. */
	openDroppedFile: (file: File) => Promise<OpenedInfo>;
	/** Shows the native file picker, limited to images for `'image'`, and opens the choice; null if cancelled. */
	pickFile: (kind?: PickKind) => Promise<OpenedInfo | null>;
	/** Shows the native folder picker and opens the choice; null if cancelled. */
	pickFolder: () => Promise<OpenedInfo | null>;
	/** Replaces a document's contents with text the user typed or edited. */
	adoptText: (docId: DocumentId | null, text: string, name: string) => Promise<DocumentInfo>;
	readChunk: (docId: DocumentId, from: number, maxBytes: number) => Promise<Chunk>;
	diff: (left: DocumentId | null, right: DocumentId | null) => Promise<DiffResult>;
	/**
	 * Compares two opened folders. A window runs one folder comparison at a time,
	 * so starting another cancels the one already running.
	 */
	diffFolders: (
		left: DocumentId,
		right: DocumentId,
		onProgress?: (progress: FolderProgress) => void
	) => Promise<FolderDiffResult>;
	/** Stops this window's running folder comparison, which then rejects. */
	cancelFolderDiff: () => Promise<void>;
	/**
	 * Opens the file at `path` — relative, as in a folder comparison's tree —
	 * inside both opened folders. Only paths that stay inside those folders open.
	 */
	openFolderEntry: (left: DocumentId, right: DocumentId, path: string) => Promise<FolderEntryDocuments>;
	/** The bytes of an opened image, for previewing it. */
	/**
	 * How the lines of two documents line up, for keeping the editors level as they
	 * scroll. Lighter than `diff`: no word-level pass, and only the changed stretches
	 * come back.
	 */
	lineChunks: (left: DocumentId, right: DocumentId) => Promise<LineChunk[]>;
	readImage: (docId: DocumentId) => Promise<Uint8Array>;
	/**
	 * Compares two opened images. Both are decoded once and kept, so calling this again
	 * with another tolerance only re-runs the comparison.
	 */
	diffImages: (left: DocumentId, right: DocumentId, tolerance: number) => Promise<ImageDiffResult>;
	/**
	 * Replaces lines `into` of document `target` with lines `from` of document `source`,
	 * for copying a change from one side of a diff to the other. Nothing is written to disk.
	 */
	copyLines: (target: DocumentId, source: DocumentId, into: LineRange, from: LineRange) => Promise<DocumentInfo>;
	/**
	 * Writes a document to the file it came from, or to one chosen in a save dialog when
	 * it has none or `saveAs` is set. Null if the dialog was cancelled.
	 */
	save: (docId: DocumentId, saveAs?: boolean) => Promise<DocumentInfo | null>;
	/**
	 * Writes the diff of two documents to a file chosen in a save dialog: a unified
	 * `.patch`, or an `.html` report. Resolves to where it was written, or null if cancelled.
	 */
	exportDiff: (left: DocumentId | null, right: DocumentId | null, labels: ExportLabels) => Promise<string | null>;
	/** The paths the app was started with — `comparer left right` — opened. Only the first call gets them. */
	launchItems: () => Promise<LaunchItem[]>;
	/** Comparisons made before, newest first. */
	recentComparisons: () => Promise<RecentComparison[]>;
	/** Remembers two opened documents, images or folders as a recent comparison, if both came from disk. */
	rememberComparison: (left: DocumentId, right: DocumentId) => Promise<RecentComparison[]>;
	/** Opens both sides of a recent comparison again. */
	openRecent: (id: string) => Promise<LaunchItem[]>;
	/** Takes one comparison off the recent list, returning what is left. */
	forgetRecent: (id: string) => Promise<RecentComparison[]>;
	clearRecent: () => Promise<void>;
	/**
	 * Colours the strip the system draws the window controls in to match the laser border,
	 * or back to the title bar's colour, where the platform lets the app choose it.
	 */
	setLaser: (on: boolean) => Promise<void>;
	/** The operating system, as Node names it: `linux`, `darwin` or `win32`. */
	platform: string;
	/** Whether the window has square corners right now: maximised or full screen. */
	windowSquared: () => Promise<boolean>;
	/** Calls back whenever the window gains or loses square corners; returns a function that stops it. */
	onWindowSquared: (listener: (squared: boolean) => void) => () => void;
	close: (docId: DocumentId) => Promise<void>;
};

declare global {
	interface Window {
		comparer: ComparerBridge;
	}
}
