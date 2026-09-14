import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
	Chunk,
	ComparerBridge,
	DocumentId,
	DocumentInfo,
	FolderEntryDocuments,
	OpenedInfo,
	PickKind
} from './shared/protocol';
import type { DiffResult, FolderDiffResult, FolderProgress, ImageDiffResult } from './lib/diff-types';

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

	readImage: (docId: DocumentId): Promise<Uint8Array> => invoke('comparer:read-image', docId),

	diffImages: (left: DocumentId, right: DocumentId, tolerance: number): Promise<ImageDiffResult> =>
		invoke('comparer:diff-images', left, right, tolerance),

	close: (docId: DocumentId): Promise<void> => invoke('comparer:close', docId)
};

contextBridge.exposeInMainWorld('comparer', bridge);
