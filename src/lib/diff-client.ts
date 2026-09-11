import type { DiffRequest, DiffResponse, DiffResult } from './diff-types';

export type DiffOptions = {
  context?: number;
  maxRows?: number;
};

const DEFAULTS = { context: 3, maxRows: 200_000 };

/** Thrown on the losing side when a newer comparison supersedes an older one. */
export class DiffCancelled extends Error {
  constructor() {
    super('Diff superseded by a newer comparison');
    this.name = 'DiffCancelled';
  }
}

/**
 * Owns the diff worker and guarantees only one comparison is in flight.
 *
 * The worker cannot be asked to stop politely: the WebAssembly call blocks its
 * event loop, so a `cancel` message would not be read until the work it is
 * meant to cancel had already finished. Terminating is the only way to reclaim
 * the thread, so a superseded run kills the worker and the next run spawns a
 * fresh one.
 */
export class DiffRunner {
  #worker: Worker | null = null;
  #ready = false;
  /** Held until the worker reports ready — see `#spawn`. */
  #queued: DiffRequest | null = null;
  #nextId = 1;
  #pending: {
    id: number;
    resolve: (result: DiffResult) => void;
    reject: (error: Error) => void;
  } | null = null;

  #spawn(): Worker {
    const worker = new Worker(new URL('./diff.worker.ts', import.meta.url), {
      type: 'module',
      name: 'comparer-diff',
    });
    this.#ready = false;

    worker.onmessage = (event: MessageEvent<DiffResponse>) => {
      const response = event.data;

      // A request posted before the worker module finished evaluating is
      // silently dropped rather than queued, so nothing is sent until the
      // worker says it is listening.
      if (response.type === 'ready') {
        this.#ready = true;
        if (this.#queued) {
          worker.postMessage(this.#queued);
          this.#queued = null;
        }
        return;
      }

      const pending = this.#pending;
      // A late reply from a run we already gave up on.
      if (!pending || pending.id !== response.id) return;

      this.#pending = null;
      if (response.type === 'result') pending.resolve(response.result);
      else pending.reject(new Error(response.message));
    };

    worker.onerror = (event) => {
      const pending = this.#pending;
      this.#pending = null;
      // The worker may be in an unusable state; drop it and start clean.
      this.#teardown();
      pending?.reject(new Error(event.message || 'Diff worker failed'));
    };

    this.#worker = worker;
    return worker;
  }

  #teardown() {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = false;
    this.#queued = null;
  }

  run(oldText: string, newText: string, options: DiffOptions = {}): Promise<DiffResult> {
    if (this.#pending) {
      const superseded = this.#pending;
      this.#pending = null;
      this.#teardown();
      superseded.reject(new DiffCancelled());
    }

    const worker = this.#worker ?? this.#spawn();
    const id = this.#nextId++;

    return new Promise<DiffResult>((resolve, reject) => {
      this.#pending = { id, resolve, reject };
      const request: DiffRequest = {
        type: 'diff',
        id,
        oldText,
        newText,
        context: options.context ?? DEFAULTS.context,
        maxRows: options.maxRows ?? DEFAULTS.maxRows,
      };

      if (this.#ready) worker.postMessage(request);
      else this.#queued = request;
    });
  }

  dispose() {
    this.#pending?.reject(new DiffCancelled());
    this.#pending = null;
    this.#teardown();
  }
}
