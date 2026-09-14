import type { DiffResult, FolderDiffResult, FolderProgress } from '../lib/diff-types';

/**
 * The contract between the renderer, the main process and the diff service.
 *
 * Deliberately narrow: the renderer can open a file or folder the user dropped or
 * picked, read a slice of a document it has opened, and diff two documents or two
 * folders. There is no general "read this file" call, because that would hand any
 * code running in the renderer the ability to read the whole filesystem.
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

/** What opening a path produces: a document for a file, or a folder. */
export type OpenedInfo = DocumentInfo | FolderInfo;

/**
 * One entry of a folder comparison, opened on both sides so it can be diffed
 * like any two files. Binary files are reported rather than opened, since a
 * text diff of them would be noise.
 */
export type FolderEntryDocuments =
  | { kind: 'text'; left: DocumentInfo; right: DocumentInfo }
  | { kind: 'binary' };

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
  /** Shows the native file picker and opens the choice; null if cancelled. */
  pickFile: () => Promise<OpenedInfo | null>;
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
    onProgress?: (progress: FolderProgress) => void,
  ) => Promise<FolderDiffResult>;
  /** Stops this window's running folder comparison, which then rejects. */
  cancelFolderDiff: () => Promise<void>;
  /**
   * Opens the file at `path` — relative, as in a folder comparison's tree —
   * inside both opened folders. Only paths that stay inside those folders open.
   */
  openFolderEntry: (left: DocumentId, right: DocumentId, path: string) => Promise<FolderEntryDocuments>;
  close: (docId: DocumentId) => Promise<void>;
};

declare global {
  interface Window {
    comparer: ComparerBridge;
  }
}
