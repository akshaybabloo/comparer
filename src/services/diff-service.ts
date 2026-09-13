import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { toHunks, toRows } from '../lib/diff-hunks';
import type { DiffResult } from '../lib/diff-types';
import type { Chunk, DocumentId, DocumentInfo, ServiceRequest, ServiceResponse } from '../shared/protocol';

/**
 * Runs in an Electron `utilityProcess`: a Node context with no Content
 * Security Policy, which is why the WebAssembly diff engine lives here rather
 * than in the renderer. It is a separate process from main so a multi-second
 * diff cannot block the event loop that serves the windows.
 *
 * It owns the text of every open document. The renderer holds only ids and
 * whatever slice it is currently showing, so comparing two 10 MB files never
 * moves 20 MB across a process boundary.
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
let nextDocId = 1;

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
  return { id, name, path, size, lineCount: document.lineStarts.length };
}

function get(docId: DocumentId): Document {
  const document = documents.get(docId);
  if (!document) throw new Error(`Unknown document ${docId}`);
  return document;
}

async function open(path: string): Promise<DocumentInfo> {
  const text = await readFile(path, 'utf8');
  return store(`doc${nextDocId++}`, basename(path), path, text, text.length);
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
    case 'close':
      documents.delete(request.docId);
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
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});

// Announce readiness rather than relying on messages sent before this module
// finished evaluating being queued.
reply({ type: 'ready' });
