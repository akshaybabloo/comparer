import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { PendingServiceRequest, ServiceRequest, ServiceResponse } from './shared/protocol';

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
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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

  send<T>(request: PendingServiceRequest): Promise<T> {
    const child = this.#child ?? this.#spawn();
    const id = this.#nextId++;
    const full = { ...request, id } as ServiceRequest;

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      // Messages sent before the service finishes evaluating are dropped
      // rather than queued, so hold them until it says it is listening.
      if (this.#ready) child.postMessage(full);
      else this.#queue.push(full);
    });
  }

  dispose() {
    this.#child?.kill();
    this.#child = null;
  }
}

export const serviceHost = new ServiceHost();

app.on('will-quit', () => serviceHost.dispose());
