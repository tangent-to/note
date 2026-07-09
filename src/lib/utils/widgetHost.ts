/**
 * Main-thread renderer for worker-kernel ui.* widget specs.
 *
 * The worker kernel can't host live DOM, so its `ui.slider(...)` & friends
 * return a declarative spec (`{__tangentWidget, kind, name, opts, value}`).
 * This module builds the real control (same look as the legacy main-thread
 * inputs), pushes value changes back into the worker scope, and dispatches
 * the existing `tangent-input-change` event so dependent cells re-run.
 */
import { kernel } from './kernelClient';

export interface WidgetSpec {
  __tangentWidget: true;
  kind: 'slider' | 'number' | 'checkbox' | 'select' | 'text';
  name: string;
  opts: Record<string, any>;
  value: any;
}

// Debounced change notification, matching the legacy executor behaviour so
// dragging a slider doesn't spam re-runs.
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
function pushValue(name: string, value: any) {
  void kernel.setVariable(name, value);
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('tangent-input-change', { detail: { name } }));
  }, 120);
}

function wrap(labelText: string, control: HTMLElement, valueEl?: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tangent-input';
  el.style.cssText =
    'display:flex;align-items:center;gap:0.5rem;font:13px/1.4 var(--font-sans, system-ui),sans-serif;padding:0.25rem 0;';
  const label = document.createElement('label');
  label.textContent = labelText;
  label.style.cssText = 'min-width:6rem;color:var(--text-muted, #4a4a4a);font-weight:500;';
  el.append(label, control);
  if (valueEl) el.append(valueEl);
  return el;
}

export function renderWidget(spec: WidgetSpec): HTMLElement {
  const { kind, name, opts = {}, value } = spec;

  switch (kind) {
    case 'slider': {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(opts.min ?? 0);
      input.max = String(opts.max ?? 100);
      input.step = String(opts.step ?? 1);
      input.value = String(value ?? opts.min ?? 0);
      input.style.flex = '1';
      const out = document.createElement('span');
      out.style.cssText =
        'min-width:3rem;font-family:var(--font-mono, monospace);color:var(--heading, #1a1a1a);';
      out.textContent = String(input.value);
      input.addEventListener('input', () => {
        out.textContent = input.value;
        pushValue(name, Number(input.value));
      });
      return wrap(opts.label ?? name, input, out);
    }
    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      if (opts.min !== undefined) input.min = String(opts.min);
      if (opts.max !== undefined) input.max = String(opts.max);
      input.step = String(opts.step ?? 1);
      input.value = String(value ?? 0);
      input.addEventListener('input', () => pushValue(name, Number(input.value)));
      return wrap(opts.label ?? name, input);
    }
    case 'checkbox': {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.addEventListener('change', () => pushValue(name, input.checked));
      return wrap(opts.label ?? name, input);
    }
    case 'select': {
      const sel = document.createElement('select');
      for (const opt of opts.options ?? []) {
        const o = document.createElement('option');
        o.value = String(opt);
        o.textContent = String(opt);
        if (String(opt) === String(value)) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => pushValue(name, sel.value));
      return wrap(opts.label ?? name, sel);
    }
    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = String(value ?? '');
      input.placeholder = opts.placeholder ?? '';
      input.style.flex = '1';
      input.addEventListener('input', () => pushValue(name, input.value));
      return wrap(opts.label ?? name, input);
    }
    default: {
      const pre = document.createElement('pre');
      pre.textContent = `Unknown widget kind: ${String(kind)}`;
      return pre;
    }
  }
}
