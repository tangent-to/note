/**
 * Main-thread clients for the worker kernel (see workers/kernel.worker.ts),
 * one per open notebook.
 *
 * - `execute(code)` runs a cell in the worker; calls are queued so cells
 *   execute one at a time in submission order (the shared scope depends on
 *   ordering).
 * - `interrupt()` terminates the worker mid-execution (the only way to stop
 *   runaway JS) and respawns a fresh kernel: pending executions reject and
 *   notebook variables are cleared, like a Jupyter kernel restart.
 * - `kernelBusy` / `kernelVariables` are reactive stores for the UI (Stop
 *   button, Variables panel).
 *
 * Each notebook gets its own client, and so its own worker and its own scope:
 * a shared one meant opening a second notebook inherited the first one's
 * variables, and that stopping a runaway cell in one wiped the other's state.
 * Workers are spawned lazily on first use, so a notebook you only read costs
 * nothing.
 *
 * `kernel`, `kernelBusy` and `kernelVariables` are proxies onto whichever
 * client is active, so every call site reads as it did when there was one.
 * A run already in flight keeps its own client — the promise was bound to it —
 * so switching notebooks mid-run does not redirect it.
 */
import { writable } from 'svelte/store';
import type { CellOutput } from '../types/notebook';

export interface VarSummary {
  name: string;
  type: string;
  repr: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class KernelClient {
  /** This notebook's own busy flag and variable list. */
  readonly busy = writable(false);
  readonly variables = writable<VarSummary[]>([]);

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
      this.busy.set(true);
      try {
        const msg = await this.request('exec', { code });
        if (msg.variables) this.variables.set(msg.variables);
        return msg.output as CellOutput;
      } finally {
        // Clamp so a reject-from-interrupt (which already reconciles the
        // counter) can never drive `running` negative and wedge kernelBusy on.
        this.running = Math.max(0, this.running - 1);
        if (this.running === 0) this.busy.set(false);
      }
    });
    // Keep the chain alive even when a run rejects (interrupt).
    this.execChain = run.catch(() => undefined);
    return run;
  }

  /** Push a widget value into the kernel scope (no re-run; the caller
   *  dispatches `tangent-input-change` to trigger dependents). */
  async setVariable(name: string, value: any, opts?: { builtin?: boolean }): Promise<void> {
    await this.request('set-var', { name, value, builtin: opts?.builtin });
  }

  /** Clear the kernel scope, keeping the worker alive. */
  async reset(): Promise<void> {
    const msg = await this.request('reset');
    this.variables.set(msg.variables ?? []);
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
    this.busy.set(false);
    this.variables.set([]);
    // Respawn eagerly so the next run doesn't pay the startup cost.
    void this.spawn().then(() => this.setup());
  }

  /**
   * Terminate this client's worker for good. Unlike interrupt(), nothing is
   * respawned: the notebook it belonged to is closed.
   */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('Notebook closed'));
    this.pending.clear();
    this.busy.set(false);
    this.variables.set([]);
  }
}

const clients = new Map<string, KernelClient>();
let activeId: string | null = null;

export function kernelFor(id: string): KernelClient {
  let client = clients.get(id);
  if (!client) {
    client = new KernelClient();
    clients.set(id, client);
  }
  return client;
}

export function setActiveKernel(id: string | null): void {
  activeId = id;
  rebindProxies();
}

/** Close a notebook's kernel: its worker dies with it, not with the tab. */
export function disposeKernel(id: string): void {
  clients.get(id)?.dispose();
  clients.delete(id);
  if (activeId === id) setActiveKernel(null);
}

function activeClient(): KernelClient {
  // Before any notebook opens, an unbound client absorbs stray calls rather
  // than forcing every call site to null-check.
  return kernelFor(activeId ?? '__unbound__');
}

/** The active notebook's kernel; every call re-resolves which one that is. */
export const kernel: KernelClient = new Proxy({} as KernelClient, {
  get(_target, prop, receiver) {
    const client = activeClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// The UI reads one busy flag and one variable list: the active notebook's.
// These republish whenever the active client changes, or when it emits.
const busyOut = writable(false);
const varsOut = writable<VarSummary[]>([]);
let unbind: Array<() => void> = [];

function rebindProxies(): void {
  for (const off of unbind) off();
  const client = activeClient();
  unbind = [
    client.busy.subscribe((v) => busyOut.set(v)),
    client.variables.subscribe((v) => varsOut.set(v)),
  ];
}

export const kernelBusy = { subscribe: busyOut.subscribe };
export const kernelVariables = { subscribe: varsOut.subscribe };

rebindProxies();
