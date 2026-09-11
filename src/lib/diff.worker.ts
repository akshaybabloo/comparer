/// <reference lib="webworker" />
import { toHunks, toRows } from './diff-hunks';
import type { DiffRequest, DiffResponse, DiffResult } from './diff-types';

/**
 * The diff runs here rather than on the main thread because the WebAssembly
 * call is synchronous and blocking: on a large pair of files it would freeze
 * the window for as long as it takes.
 */

function reply(response: DiffResponse) {
  self.postMessage(response);
}

function runDiff(request: DiffRequest): DiffResult {
  const startedAt = performance.now();
  const rows = toRows(request.oldText, request.newText);
  const { hunks, added, removed, kept, truncated } = toHunks(rows, request.context, request.maxRows);

  return {
    hunks,
    stats: { added, removed, rows: kept },
    identical: added === 0 && removed === 0,
    truncated,
    elapsedMs: performance.now() - startedAt,
  };
}

self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const request = event.data;
  if (request?.type !== 'diff') return;

  try {
    reply({ type: 'result', id: request.id, result: runDiff(request) });
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

// Announce readiness rather than relying on messages posted before this module
// finished evaluating being queued for us: under Vite's dev server that first
// message is dropped, and the caller waits forever for a reply that never comes.
reply({ type: 'ready' });
