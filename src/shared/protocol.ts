import type { DiffResult } from '../lib/diff-types';

/**
 * The contract between the renderer, the main process and the diff service.
 *
 * Deliberately narrow: the renderer can open a file the user dropped or picked, read a
 * slice of a document it has opened, and diff two of them. There is no general
 * "read this file" call, because that would hand any code running in the
 * renderer the ability to read the whole filesystem.
 */

/** Identifies a document held by the service. Opaque to the renderer. */
export type DocumentId = string;

export type DocumentInfo = {
  id: DocumentId;
  name: string;
  /** Absolute path on disk, or null for text that never came from a file. */
  path: string | null;
  /** Bytes on disk, or UTF-16 length for text typed into the app. */
  size: number;
  lineCount: number;
};

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
  | { type: 'error'; id: number; message: string };

/** The API the preload exposes on `window.comparer`. */
export type ComparerBridge = {
  /** Resolves a dropped File to its path and opens it in the service. */
  openDroppedFile: (file: File) => Promise<DocumentInfo>;
  /** Shows the native file picker and opens the choice; null if cancelled. */
  pickFile: () => Promise<DocumentInfo | null>;
  /** Replaces a document's contents with text the user typed or edited. */
  adoptText: (docId: DocumentId | null, text: string, name: string) => Promise<DocumentInfo>;
  readChunk: (docId: DocumentId, from: number, maxBytes: number) => Promise<Chunk>;
  diff: (left: DocumentId | null, right: DocumentId | null) => Promise<DiffResult>;
  close: (docId: DocumentId) => Promise<void>;
};

declare global {
  interface Window {
    comparer: ComparerBridge;
  }
}
