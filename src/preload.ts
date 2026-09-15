import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
	Chunk,
	ComparerBridge,
	DocumentId,
	DocumentInfo,
	FolderEntryDocuments,
	LaunchItem,
	OpenedInfo,
	PickKind
} from './shared/protocol';
import type { DiffResult, FolderDiffResult, FolderProgress, ImageDiffResult } from './lib/diff-types';
import type { LineChunk } from './lib/line-alignment';
import type { ExportLabels } from './lib/export';
import type { LineRange } from './lib/text-edit';
import type { RecentComparison } from './shared/launch';

/** Tags each folder comparison, so its progress is not mistaken for another's. */
let nextFolderDiffToken = 1;

/**
 * `ipcRenderer.invoke`, minus the wrapping Electron adds to a handler's error:
 * a failure otherwise reaches the renderer as "Error invoking remote method
 * 'comparer:diff': Error: …", when only the part after it means anything to
 * someone using the app.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	try {
		return await ipcRenderer.invoke(channel, ...args);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		throw new Error(error.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
	}
}

/**
 * The renderer's only route out of its sandbox.
 *
 * Every call is scoped to something the user has already chosen: `openDroppedFile`
 * takes a `File` from a real drop event and resolves it here — page code cannot
 * fabricate one, and there is deliberately no `readFile(path)` to abuse. After
 * that, documents are addressed by opaque id.
 *
 * `webUtils.getPathForFile` replaced the non-standard `File.path` property
 * Electron used to add, and is only reachable from a preload.
 */
const bridge: ComparerBridge = {
	// A dropped folder arrives as a File too, and resolves to its path the same way.
	openDroppedFile: async (file: File): Promise<OpenedInfo> => {
		// Only a File that came from a real OS drop has a path behind it. Anything
		// else — a synthetic File, or one from a source with no file backing it —
		// returns an empty string here, so fall back to sending the contents
		// rather than asking main to open "".
		const path = webUtils.getPathForFile(file);
		if (path) return invoke('comparer:open', path);

		const text = await file.text();
		return invoke('comparer:adopt', null, text, file.name || 'dropped file');
	},

	pickFile: (kind?: PickKind): Promise<OpenedInfo | null> => invoke('comparer:pick', kind),

	pickFolder: (): Promise<OpenedInfo | null> => invoke('comparer:pick-folder'),

	adoptText: (docId: DocumentId | null, text: string, name: string): Promise<DocumentInfo> =>
		invoke('comparer:adopt', docId, text, name),

	readChunk: (docId: DocumentId, from: number, maxBytes: number): Promise<Chunk> =>
		invoke('comparer:chunk', docId, from, maxBytes),

	diff: (left: DocumentId | null, right: DocumentId | null): Promise<DiffResult> =>
		invoke('comparer:diff', left, right),

	diffFolders: async (
		left: DocumentId,
		right: DocumentId,
		onProgress?: (progress: FolderProgress) => void
	): Promise<FolderDiffResult> => {
		const token = nextFolderDiffToken++;
		const listener = (_event: IpcRendererEvent, from: number, progress: FolderProgress) => {
			if (from === token) onProgress?.(progress);
		};
		ipcRenderer.on('comparer:folder-progress', listener);
		try {
			return await invoke('comparer:diff-folders', left, right, token);
		} finally {
			ipcRenderer.removeListener('comparer:folder-progress', listener);
		}
	},

	cancelFolderDiff: (): Promise<void> => invoke('comparer:cancel-folder-diff'),

	openFolderEntry: (left: DocumentId, right: DocumentId, path: string): Promise<FolderEntryDocuments> =>
		invoke('comparer:open-folder-entry', left, right, path),

	lineChunks: (left: DocumentId, right: DocumentId): Promise<LineChunk[]> =>
		invoke('comparer:line-chunks', left, right),

	readImage: (docId: DocumentId): Promise<Uint8Array> => invoke('comparer:read-image', docId),

	diffImages: (left: DocumentId, right: DocumentId, tolerance: number): Promise<ImageDiffResult> =>
		invoke('comparer:diff-images', left, right, tolerance),

	copyLines: (target: DocumentId, source: DocumentId, into: LineRange, from: LineRange): Promise<DocumentInfo> =>
		invoke('comparer:copy-lines', target, source, into, from),

	save: (docId: DocumentId, saveAs?: boolean): Promise<DocumentInfo | null> => invoke('comparer:save', docId, saveAs),

	exportDiff: (left: DocumentId | null, right: DocumentId | null, labels: ExportLabels): Promise<string | null> =>
		invoke('comparer:export-diff', left, right, labels),

	launchItems: (): Promise<LaunchItem[]> => invoke('comparer:launch-items'),

	recentComparisons: (): Promise<RecentComparison[]> => invoke('comparer:recent'),

	rememberComparison: (left: DocumentId, right: DocumentId): Promise<RecentComparison[]> =>
		invoke('comparer:remember', left, right),

	openRecent: (id: string): Promise<LaunchItem[]> => invoke('comparer:open-recent', id),

	forgetRecent: (id: string): Promise<RecentComparison[]> => invoke('comparer:forget-recent', id),

	clearRecent: (): Promise<void> => invoke('comparer:clear-recent'),

	setLaser: (on: boolean): Promise<void> => invoke('comparer:set-laser', on),

	platform: process.platform,

	windowSquared: (): Promise<boolean> => invoke('comparer:window-squared'),

	onWindowSquared: (listener: (squared: boolean) => void) => {
		const handler = (_event: IpcRendererEvent, squared: boolean) => listener(squared);
		ipcRenderer.on('comparer:window-squared', handler);
		return () => ipcRenderer.removeListener('comparer:window-squared', handler);
	},

	close: (docId: DocumentId): Promise<void> => invoke('comparer:close', docId)
};

contextBridge.exposeInMainWorld('comparer', bridge);
