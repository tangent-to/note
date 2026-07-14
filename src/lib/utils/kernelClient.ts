/**
 * Main-thread client for the worker kernel (see workers/kernel.worker.ts).
 *
 * - `execute(code)` runs a cell in the worker; calls are queued so cells
 *   execute one at a time in submission order (the shared scope depends on
 *   ordering).
 * - `interrupt()` terminates the worker mid-execution (the only way to stop
 *   runaway JS) and respawns a fresh kernel: pending executions reject and
 *   notebook variables are cleared, like a Jupyter kernel restart.
 * - `kernelBusy` / `kernelVariables` are reactive stores for the UI (Stop
 *   button, Variables panel).
 */
import { writable } from 'svelte/store';
import type { CellOutput } from '../types/notebook';

export interface VarSummary {
  name: string;
  type: string;
  repr: string;
}

export const kernelBusy = writable(false);
export const kernelVariables = writable<VarSummary[]>([]);

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

class KernelClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  // Serialize executions: the shared scope is order-dependent.
  private execChain: Promise<unknown> = Promise.resolve();
  private running = 0;

  private spawn(): Promise<void> {
    const worker = new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    this.ready = new Promise<void>((resolveReady) => {
      worker.onmessage = (event: MessageEvent<any>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          resolveReady();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === 'error') p.reject(new Error(msg.message));
        else p.resolve(msg);
      };
      worker.onerror = (event) => {
        // A top-level worker failure (e.g. script load error) fails everything.
        const err = new Error(event.message || 'Kernel worker error');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    });
    return this.ready;
  }

  private async ensureWorker(): Promise<Worker> {
    if (!this.worker) await this.spawn();
    else await this.ready;
    return this.worker!;
  }

  private async request(type: string, payload: Record<string, any> = {}): Promise<any> {
    const worker = await this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
  }

  /** Preload common libraries (d3, Plot) into the kernel scope. */
  async setup(): Promise<void> {
    try {
      await this.request('setup');
    } catch (err) {
      console.warn('Kernel setup (common libraries) failed:', err);
    }
  }

  /** Execute a cell. Queued: one execution at a time, submission order. */
  execute(code: string): Promise<CellOutput> {
    const run = this.execChain.then(async () => {
      this.running++;
      kernelBusy.set(true);
      try {
        const msg = await this.request('exec', { code });
        if (msg.variables) kernelVariables.set(msg.variables);
        return msg.output as CellOutput;
      } finally {
        // Clamp so a reject-from-interrupt (which already reconciles the
        // counter) can never drive `running` negative and wedge kernelBusy on.
        this.running = Math.max(0, this.running - 1);
        if (this.running === 0) kernelBusy.set(false);
      }
    });
    // Keep the chain alive even when a run rejects (interrupt).
    this.execChain = run.catch(() => undefined);
    return run;
  }

  /** Push a widget value into the kernel scope (no re-run; the caller
   *  dispatches `tangent-input-change` to trigger dependents). */
  async setVariable(name: string, value: any): Promise<void> {
    await this.request('set-var', { name, value });
  }

  /** Clear the kernel scope, keeping the worker alive. */
  async reset(): Promise<void> {
    const msg = await this.request('reset');
    kernelVariables.set(msg.variables ?? []);
  }

  /**
   * Hard-stop the kernel: terminate the worker (killing any in-flight
   * execution) and start a fresh one. All notebook variables are lost.
   */
  interrupt(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = null;
    }
    const err = new Error('Interrupted: kernel restarted, notebook variables were cleared.');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.execChain = Promise.resolve();
    // Don't zero `running` here: the in-flight execute() we just rejected still
    // runs its own finally, which decrements the counter. Zeroing as well would
    // double-count and push `running` negative, permanently wedging kernelBusy.
    // The clamped decrement in that finally reconciles it back to 0.
    kernelBusy.set(false);
    kernelVariables.set([]);
    // Respawn eagerly so the next run doesn't pay the startup cost.
    void this.spawn().then(() => this.setup());
  }
}

/** Singleton kernel shared by the whole app. */
export const kernel = new KernelClient();
