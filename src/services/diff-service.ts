import { compareFolders } from 'comparer-ts';
import { createReadStream } from 'node:fs';
import { open as openHandle, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { toHunks, toRows } from '../lib/diff-hunks';
import type { DiffResult, FolderDiffResult, FolderProgress } from '../lib/diff-types';
import type {
  Chunk,
  DocumentId,
  DocumentInfo,
  FolderEntryDocuments,
  FolderInfo,
  OpenedInfo,
  ServiceRequest,
  ServiceResponse,
} from '../shared/protocol';
import { describe, listFolder } from './folder-listing';

/**
 * Runs in an Electron `utilityProcess`: a Node context with no Content
 * Security Policy, which is why the WebAssembly diff engine lives here rather
 * than in the renderer. It is a separate process from main so a multi-second
 * diff cannot block the event loop that serves the windows.
 *
 * It owns the text of every open document. The renderer holds only ids and
 * whatever slice it is currently showing, so comparing two 10 MB files never
 * moves 20 MB across a process boundary. Folders are held the same way: the
 * renderer gets an id, and only the service ever walks or reads what is inside.
 */

type Document = {
  id: DocumentId;
  name: string;
  path: string | null;
  text: string;
  size: number;
  /** Offset of the start of each line, so a range can be sliced without a scan. */
  lineStarts: number[];
};

const documents = new Map<DocumentId, Document>();
const folders = new Map<DocumentId, FolderInfo>();
let nextDocId = 1;

/** Aborts each cancellable request still running, keyed by request id. */
const running = new Map<number, AbortController>();

/**
 * Files up to this size are hashed from a single read; larger ones stream in
 * chunks of this size, so memory stays bounded. Opening a stream costs far
 * more than the read itself for a small file, and most files in a source tree
 * or `node_modules` are small, so this roughly halves a whole comparison.
 */
const HASH_CHUNK_BYTES = 1024 * 1024;
/** Files hashed at once. Reads wait on disk, so this is I/O rather than CPU parallelism. */
const HASH_CONCURRENCY = 8;
/** Minimum gap between progress messages, so a fast walk does not flood main. */
const PROGRESS_INTERVAL_MS = 100;
/** How much of a file is checked for a NUL byte, as git does, to call it binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Index every line start once, so later range reads are two lookups. */
function indexLines(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  // A trailing newline opens a final empty line, which editors do count.
  return starts;
}

function store(
  id: DocumentId,
  name: string,
  path: string | null,
  text: string,
  size: number,
): DocumentInfo {
  const document: Document = { id, name, path, text, size, lineStarts: indexLines(text) };
  documents.set(id, document);
  return { kind: 'file', id, name, path, size, lineCount: document.lineStarts.length };
}

function get(docId: DocumentId): Document {
  const document = documents.get(docId);
  if (!document) throw new Error(`Unknown document ${docId}`);
  return document;
}

/**
 * Opens whatever is at `path`. A folder is only registered here; nothing inside
 * it is read until it is compared. `stat` follows symlinks, so a link to a
 * folder opens as that folder.
 */
async function open(path: string): Promise<OpenedInfo> {
  if ((await stat(path)).isDirectory()) {
    const folder: FolderInfo = { kind: 'folder', id: `folder${nextDocId++}`, name: basename(path), path };
    folders.set(folder.id, folder);
    return folder;
  }
  return openFile(path);
}

async function openFile(path: string): Promise<DocumentInfo> {
  const text = await readFile(path, 'utf8');
  return store(`doc${nextDocId++}`, basename(path), path, text, text.length);
}

function getFolder(folderId: DocumentId): FolderInfo {
  const folder = folders.get(folderId);
  if (!folder) throw new Error(`Unknown folder ${folderId}`);
  return folder;
}

/**
 * Resolves `path` inside a folder the user opened, refusing anything that ends
 * up outside it.
 *
 * This is the one place a path chosen by renderer code reaches the disk, so the
 * check runs on the fully resolved path: rejecting `..` alone would still let a
 * symlink inside the folder lead anywhere on the filesystem.
 */
async function resolveInside(folder: FolderInfo, path: string): Promise<string> {
  const segments = path.split('/');
  if (
    isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    (process.platform === 'win32' && /[\\:]/.test(path))
  ) {
    throw new Error(`Not a path inside the folder: ${path}`);
  }

  const root = await realpath(folder.path);
  const resolved = await realpath(join(root, ...segments));
  if (!resolved.startsWith(root + sep)) throw new Error(`${path} leads outside ${folder.name}`);
  if (!(await stat(resolved)).isFile()) throw new Error(`${path} is not a file in ${folder.name}`);
  return resolved;
}

async function isBinary(path: string): Promise<boolean> {
  const handle = await openHandle(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(BINARY_SNIFF_BYTES), 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function openFolderEntry(left: DocumentId, right: DocumentId, path: string): Promise<FolderEntryDocuments> {
  const files = await Promise.all([resolveInside(getFolder(left), path), resolveInside(getFolder(right), path)]);
  const binary = await Promise.all(files.map(isBinary));
  if (binary.some(Boolean)) return { kind: 'binary' };

  const [leftDocument, rightDocument] = await Promise.all(files.map(openFile));
  return { kind: 'text', left: leftDocument, right: rightDocument };
}

function adopt(docId: DocumentId | null, text: string, name: string): DocumentInfo {
  const existing = docId ? documents.get(docId) : undefined;
  const id = existing ? existing.id : `doc${nextDocId++}`;
  // An edited file is still that file, so it keeps the path it was opened from.
  return store(id, name, existing?.path ?? null, text, text.length);
}

/**
 * Slices by byte offset rather than by line.
 *
 * Chunking by lines is useless for the files that most need chunking: a log or
 * a minified bundle with no newlines is a single line, so "the first N lines"
 * is the entire document. The cut is snapped back to the nearest line break
 * when one is close, so ordinary files still break cleanly.
 */
function chunk(docId: DocumentId, from: number, maxBytes: number): Chunk {
  const document = get(docId);
  const length = document.text.length;
  const start = Math.max(0, Math.min(from, length));
  let end = Math.min(length, start + Math.max(1, maxBytes));

  if (end < length) {
    const lastBreak = document.text.lastIndexOf('\n', end - 1);
    // Only snap when the break is within the last 10% of the chunk, so a very
    // long line is not whittled down to nothing.
    if (lastBreak > start && end - lastBreak < maxBytes * 0.1) end = lastBreak + 1;
  }

  return { text: document.text.slice(start, end), from: start, to: end, atEnd: end >= length };
}

function diff(
  left: DocumentId | null,
  right: DocumentId | null,
  context: number,
  maxRows: number,
): DiffResult {
  const startedAt = performance.now();
  const oldText = left ? get(left).text : '';
  const newText = right ? get(right).text : '';

  const rows = toRows(oldText, newText);
  const { hunks, added, removed, kept, truncated } = toHunks(rows, context, maxRows);

  return {
    hunks,
    stats: { added, removed, rows: kept },
    identical: added === 0 && removed === 0,
    truncated,
    elapsedMs: performance.now() - startedAt,
  };
}

async function* readWhole(file: string, signal: AbortSignal) {
  yield await readFile(file, { signal });
}

/** Calls `send` at most once per `PROGRESS_INTERVAL_MS`, starting with the first call. */
function throttle(send: (progress: FolderProgress) => void) {
  let last = -Infinity;
  return (progress: FolderProgress) => {
    const now = performance.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    send(progress);
  };
}

/**
 * Lists both folders in full, then has comparer-ts hash the files it cannot
 * settle from the listings alone.
 */
async function diffFolders(requestId: number, left: DocumentId, right: DocumentId): Promise<FolderDiffResult> {
  const startedAt = performance.now();
  const roots = { left: getFolder(left).path, right: getFolder(right).path };
  const controller = new AbortController();
  const { signal } = controller;
  running.set(requestId, controller);
  const report = throttle((progress) => reply({ type: 'progress', id: requestId, progress }));

  try {
    let entries = 0;
    const counted = (count: number) => {
      entries += count;
      report({ phase: 'list', entries });
    };
    const [leftEntries, rightEntries] = await Promise.all([
      listFolder(roots.left, signal, counted),
      listFolder(roots.right, signal, counted),
    ]);

    const sizes = {
      left: new Map(leftEntries.map((entry) => [entry.path, entry.size])),
      right: new Map(rightEntries.map((entry) => [entry.path, entry.size])),
    };
    const read = (side: 'left' | 'right', path: string) => {
      const file = join(roots[side], path);
      return (sizes[side].get(path) ?? Infinity) <= HASH_CHUNK_BYTES
        ? readWhole(file, signal)
        : createReadStream(file, { highWaterMark: HASH_CHUNK_BYTES, signal });
    };

    const diff = await compareFolders(leftEntries, rightEntries, read, {
      signal,
      concurrency: HASH_CONCURRENCY,
      onProgress: (progress) => report({ phase: 'hash', ...progress }),
    });

    return { ...diff, elapsedMs: performance.now() - startedAt };
  } catch (error) {
    // Whatever was in flight when the abort landed surfaces as its own error,
    // such as a stream's AbortError; report the cancellation instead.
    if (signal.aborted) throw new Error('Comparison cancelled');
    throw error;
  } finally {
    running.delete(requestId);
  }
}

async function handle(request: ServiceRequest): Promise<unknown> {
  switch (request.type) {
    case 'open':
      return open(request.path);
    case 'adopt':
      return adopt(request.docId, request.text, request.name);
    case 'chunk':
      return chunk(request.docId, request.from, request.maxBytes);
    case 'diff':
      return diff(request.left, request.right, request.context, request.maxRows);
    case 'diffFolders':
      return diffFolders(request.id, request.left, request.right);
    case 'openFolderEntry':
      return openFolderEntry(request.left, request.right, request.path);
    case 'cancel':
      running.get(request.target)?.abort();
      return null;
    case 'close':
      documents.delete(request.docId);
      folders.delete(request.docId);
      return null;
  }
}

const reply = (response: ServiceResponse) => process.parentPort.postMessage(response);

process.parentPort.on('message', (event) => {
  const request = event.data as ServiceRequest;
  void handle(request).then(
    (value) => reply({ type: 'ok', id: request.id, value }),
    (error: unknown) =>
      reply({
        type: 'error',
        id: request.id,
        message: describe(error),
      }),
  );
});

// Announce readiness rather than relying on messages sent before this module
// finished evaluating being queued.
reply({ type: 'ready' });
