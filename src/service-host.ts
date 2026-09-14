import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { FolderProgress } from './lib/diff-types';
import type { PendingServiceRequest, ServiceRequest, ServiceResponse } from './shared/protocol';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: FolderProgress) => void;
};

export type SendOptions = {
  /** Receives the request's progress messages, for requests that send them. */
  onProgress?: (progress: FolderProgress) => void;
  /** Asks the service to stop the request; it then rejects as cancelled. */
  signal?: AbortSignal;
};

/**
 * Owns the diff service process from the main process side, and turns its
 * message passing into promises.
 *
 * The service is forked lazily and restarted if it dies, so a crash while
 * diffing something pathological costs one comparison rather than the app.
 */
class ServiceHost {
  #child: UtilityProcess | null = null;
  #ready = false;
  #queue: ServiceRequest[] = [];
  #nextId = 1;
  #pending = new Map<number, Pending>();

  #entry() {
    // Built alongside main; see the extra entry in forge.config.ts. The `.mjs`
    // extension is load-bearing: comparer-ts instantiates its wasm with a
    // top-level await, so the service has to be an ES module.
    return path.join(__dirname, 'diff-service.mjs');
  }

  #spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.#entry(), [], {
      serviceName: 'comparer-diff',
      stdio: 'inherit',
    });
    this.#ready = false;

    child.on('message', (response: ServiceResponse) => {
      if (response.type === 'ready') {
        this.#ready = true;
        for (const request of this.#queue.splice(0)) child.postMessage(request);
        return;
      }

      const pending = this.#pending.get(response.id);
      if (!pending) return;
      if (response.type === 'progress') {
        pending.onProgress?.(response.progress);
        return;
      }
      this.#pending.delete(response.id);
      if (response.type === 'ok') pending.resolve(response.value);
      else pending.reject(new Error(response.message));
    });

    child.on('exit', () => {
      const error = new Error('Diff service stopped unexpectedly');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#child = null;
      this.#ready = false;
      this.#queue = [];
    });

    this.#child = child;
    return child;
  }

  send<T>(request: PendingServiceRequest, { onProgress, signal }: SendOptions = {}): Promise<T> {
    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Comparison cancelled'));

      // The service does the actual stopping and replies with its own error, so
      // cancelling only has to ask; the listener goes once the request settles.
      const cancel = () => this.#post({ type: 'cancel', target: id });
      signal?.addEventListener('abort', cancel, { once: true });
      const settle = () => signal?.removeEventListener('abort', cancel);

      this.#pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value as T);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        onProgress,
      });
      this.#post(request, id);
    });
  }

  #post(request: PendingServiceRequest, id = this.#nextId++) {
    const child = this.#child ?? this.#spawn();
    const full = { ...request, id } as ServiceRequest;
    // Messages sent before the service finishes evaluating are dropped
    // rather than queued, so hold them until it says it is listening.
    if (this.#ready) child.postMessage(full);
    else this.#queue.push(full);
  }

  dispose() {
    this.#child?.kill();
    this.#child = null;
  }
}

export const serviceHost = new ServiceHost();

app.on('will-quit', () => serviceHost.dispose());
