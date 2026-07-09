/**
 * Worker-side notebook kernel.
 *
 * Owns the shared scope and executes all code cells OFF the main thread, so
 * long computations (MCMC, GP fits, …) never freeze the UI, and a running
 * kernel can be interrupted by terminating the worker.
 *
 * Reuses JavaScriptExecutor unchanged by giving the worker the globals it
 * expects: `window` aliases the worker global, and `document` (plus the DOM
 * constructors) come from linkedom, so DOM-building libraries (Observable
 * Plot, d3) produce shim nodes that are serialized to HTML for display.
 *
 * Differences from the main-thread executor, by design:
 * - Outputs are serialized: DOM nodes → HTML strings; everything else is
 *   already a string. No live event listeners survive serialization.
 * - `ui.*` inputs return a declarative spec ({__tangentWidget}), rendered as
 *   a real control on the main thread; value changes are posted back into
 *   the worker scope (see widgetHost.ts / kernelClient.ts).
 */
import { parseHTML } from 'linkedom';

// ---------------------------------------------------------------------------
// Globals the executor (and notebook code) expects. Must be set up before
// JavaScriptExecutor is imported/constructed.
// ---------------------------------------------------------------------------
const g = globalThis as any;

const dom = parseHTML('<!doctype html><html><head></head><body></body></html>');
g.document = dom.document;
// DOM constructors so `instanceof Node`, `instanceof Element`… work.
for (const key of [
  'Node',
  'Element',
  'HTMLElement',
  'SVGElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'MutationObserver',
] as const) {
  if ((dom as any)[key] && !g[key]) g[key] = (dom as any)[key];
}
// `window` aliases the worker global (NOT linkedom's window) so that
// `window.eval`, `window.__tangent_scope`, timers, fetch, URL… all exist.
if (!g.window) g.window = g;
// Some libraries schedule via requestAnimationFrame, which not all worker
// contexts implement.
if (!g.requestAnimationFrame) {
  g.requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(performance.now()), 16);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
if (!g.getComputedStyle) {
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
}

// NOTE: this import hoists above the global setup, but that's fine — the
// executor only touches window/document from its constructor and methods,
// and `new JavaScriptExecutor()` below runs after the globals are in place.
import { JavaScriptExecutor } from '../utils/jsExecutor';
import type { CellOutput } from '../types/notebook';

const executor = new JavaScriptExecutor();

// ---------------------------------------------------------------------------
// ui.* inputs → declarative widget specs (real controls live on the main
// thread; changed values are posted back with a `set-var` message).
// ---------------------------------------------------------------------------
function widgetUi() {
  const scope = (g.__tangent_scope ?? {}) as Record<string, any>;
  const spec = (kind: string, name: string, opts: any, value: any) => {
    scope[name] = value;
    return { __tangentWidget: true, kind, name, opts, value };
  };
  return {
    slider(name: string, opts: any = {}) {
      const { min = 0, max = 100, step = 1, value = min, label = name } = opts;
      return spec('slider', name, { min, max, step, label }, Number(value));
    },
    number(name: string, opts: any = {}) {
      const { min, max, step = 1, value = 0, label = name } = opts;
      return spec('number', name, { min, max, step, label }, Number(value));
    },
    checkbox(name: string, opts: any = {}) {
      const { value = false, label = name } = opts;
      return spec('checkbox', name, { label }, Boolean(value));
    },
    select(name: string, opts: any = {}) {
      const { options = [], value, label = name } = opts;
      const resolved = value !== undefined ? value : (options[0] ?? '');
      return spec('select', name, { options, label }, resolved);
    },
    text(name: string, opts: any = {}) {
      const { value = '', label = name, placeholder = '' } = opts;
      return spec('text', name, { label, placeholder }, String(value));
    },
  };
}
g.ui = widgetUi();

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
function serializeOutput(out: CellOutput): CellOutput {
  if (out.type === 'dom') {
    const el = out.content as any;
    const html = el && typeof el.outerHTML === 'string' ? el.outerHTML : String(el);
    return { type: 'html', content: html, timestamp: out.timestamp };
  }
  // text / html / json / error / widget already carry strings.
  return { ...out, content: String(out.content ?? '') };
}

export interface VarSummary {
  name: string;
  type: string;
  repr: string;
}

function reprOf(value: any): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'fn()';
  if (typeof value === 'string')
    return value.length > 50 ? `"${value.substring(0, 50)}..."` : `"${value}"`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object' && typeof value.nodeType === 'number')
    return `<${String(value.tagName || value.nodeName || 'node').toLowerCase()}>`;
  if (typeof value === 'object') {
    const ctor = value.constructor?.name;
    const keys = Object.keys(value);
    if (ctor && ctor !== 'Object') return `${ctor} {${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
    if (keys.length > 5) return `{${keys.slice(0, 3).join(', ')}, ... +${keys.length - 3}}`;
    try {
      const str = JSON.stringify(value);
      return str.length > 60 ? str.substring(0, 60) + '...' : str;
    } catch {
      return 'Object';
    }
  }
  return String(value);
}

function typeOf(value: any): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object' && typeof value.nodeType === 'number') return 'element';
  return typeof value;
}

function variableSummaries(): VarSummary[] {
  const vars = executor.getVariables();
  return Object.entries(vars).map(([name, value]) => ({
    name,
    type: typeOf(value),
    repr: reprOf(value),
  }));
}

// ---------------------------------------------------------------------------
// Message handling. Executions are queued client-side (one at a time), so a
// simple async handler is enough here.
// ---------------------------------------------------------------------------
interface KernelRequest {
  id: number;
  type: 'exec' | 'setup' | 'set-var' | 'reset' | 'get-vars';
  code?: string;
  name?: string;
  value?: any;
}

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'setup': {
        await executor.setupCommonLibraries();
        self.postMessage({ id: msg.id, type: 'result' });
        break;
      }
      case 'exec': {
        const output = await executor.executeCode(msg.code ?? '');
        self.postMessage({
          id: msg.id,
          type: 'result',
          output: serializeOutput(output),
          variables: variableSummaries(),
        });
        break;
      }
      case 'set-var': {
        if (msg.name) (g.__tangent_scope ?? {})[msg.name] = msg.value;
        self.postMessage({ id: msg.id, type: 'result' });
        break;
      }
      case 'reset': {
        executor.resetScope();
        self.postMessage({ id: msg.id, type: 'result', variables: [] });
        break;
      }
      case 'get-vars': {
        self.postMessage({ id: msg.id, type: 'result', variables: variableSummaries() });
        break;
      }
    }
  } catch (error: any) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      message: error?.message ?? String(error),
    });
  }
};

// Signal readiness (the client resolves its `ready` promise on this).
self.postMessage({ id: -1, type: 'ready' });
