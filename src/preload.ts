import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Chunk, ComparerBridge, DocumentId, DocumentInfo } from './shared/protocol';
import type { DiffResult } from './lib/diff-types';

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
  openDroppedFile: async (file: File): Promise<DocumentInfo> => {
    // Only a File that came from a real OS drop has a path behind it. Anything
    // else — a synthetic File, or one from a source with no file backing it —
    // returns an empty string here, so fall back to sending the contents
    // rather than asking main to open "".
    const path = webUtils.getPathForFile(file);
    if (path) return ipcRenderer.invoke('comparer:open', path);

    const text = await file.text();
    return ipcRenderer.invoke('comparer:adopt', null, text, file.name || 'dropped file');
  },

  adoptText: (docId: DocumentId | null, text: string, name: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke('comparer:adopt', docId, text, name),

  readChunk: (docId: DocumentId, from: number, maxBytes: number): Promise<Chunk> =>
    ipcRenderer.invoke('comparer:chunk', docId, from, maxBytes),

  diff: (left: DocumentId | null, right: DocumentId | null): Promise<DiffResult> =>
    ipcRenderer.invoke('comparer:diff', left, right),

  close: (docId: DocumentId): Promise<void> => ipcRenderer.invoke('comparer:close', docId),
};

contextBridge.exposeInMainWorld('comparer', bridge);
