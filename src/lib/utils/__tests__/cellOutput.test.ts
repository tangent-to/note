import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { LISTENER_FLAG, isEmptyOutput, lostInteractivity } from '../cellOutput';

let document: Document;

beforeAll(() => {
  document = parseHTML('<!doctype html><body></body>').document as unknown as Document;
});

const fragment = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

describe('isEmptyOutput', () => {
  it('treats missing output and blank content as empty', () => {
    expect(isEmptyOutput(null)).toBe(true);
    expect(isEmptyOutput(undefined)).toBe(true);
    expect(isEmptyOutput({ type: 'text', content: '', timestamp: 1 })).toBe(true);
    expect(isEmptyOutput({ type: 'text', content: '   \n ', timestamp: 1 })).toBe(true);
  });

  it('treats any content, DOM node or widget as non-empty', () => {
    expect(isEmptyOutput({ type: 'text', content: '0', timestamp: 1 })).toBe(false);
    expect(isEmptyOutput({ type: 'error', content: 'boom', timestamp: 1 })).toBe(false);
    expect(isEmptyOutput({ type: 'dom', content: fragment('<p>x</p>'), timestamp: 1 })).toBe(false);
    expect(isEmptyOutput({ type: 'widget', content: '{"kind":"slider"}', timestamp: 1 })).toBe(false);
  });

  it('counts what the cell printed, even with no value to show', () => {
    // A cell whose whole point is a console.log returns undefined, so its
    // content is empty; without this it would render no output frame at all
    // and the printing would vanish.
    expect(isEmptyOutput({
      type: 'text',
      content: '',
      timestamp: 1,
      logs: [{ level: 'log', text: 'hello' }],
    })).toBe(false);

    expect(isEmptyOutput({ type: 'text', content: '', timestamp: 1, logs: [] })).toBe(true);
  });
});

describe('lostInteractivity', () => {
  it('is false for static markup', () => {
    expect(lostInteractivity(fragment('<svg><rect width="4" height="4"/></svg>'))).toBe(false);
    expect(lostInteractivity(fragment('<table><tr><td>1</td></tr></table>'))).toBe(false);
  });

  it('is true when a listener was attached to the output or a descendant', () => {
    const root = fragment('<div><button>▶ Play</button></div>');
    expect(lostInteractivity(root)).toBe(false);

    const button = root.querySelector('button')!;
    (button as any)[LISTENER_FLAG] = true;   // what the worker stamps on it
    expect(lostInteractivity(root)).toBe(true);

    const self = fragment('<p>hi</p>');
    (self as any)[LISTENER_FLAG] = true;
    expect(lostInteractivity(self)).toBe(true);
  });

  it('is true for a handler set as a property, not just addEventListener', () => {
    // `el.onclick = fn` never reaches the worker's addEventListener patch and
    // does not survive serialization either — linkedom writes
    // `<button>Play</button>` and the function is gone. Without this the reader
    // got dead controls and no warning, which is the one outcome the notice
    // exists to prevent. (Found on a real jmon player whose Play button is
    // written exactly this way.)
    const root = fragment('<div><button>▶ Play</button></div>');
    expect(lostInteractivity(root)).toBe(false);

    (root.querySelector('button') as any).onclick = () => {};
    expect(lostInteractivity(root)).toBe(true);
  });

  it('sees a handler on the output element itself', () => {
    const self = fragment('<div>chart</div>');
    (self as any).onmousemove = () => {};
    expect(lostInteractivity(self)).toBe(true);
  });

  it('covers the handlers an output actually uses', () => {
    for (const prop of ['onchange', 'oninput', 'onpointerdown', 'onkeydown', 'onwheel']) {
      const root = fragment('<div><input></div>');
      (root.querySelector('input') as any)[prop] = () => {};
      expect(lostInteractivity(root), prop).toBe(true);
    }
  });

  it('does not mistake an unset handler for one', () => {
    // linkedom exposes `on*` on the prototype, so reading one is always
    // allowed; only a function counts.
    const root = fragment('<div><button>x</button></div>');
    (root.querySelector('button') as any).onclick = null;
    expect(lostInteractivity(root)).toBe(false);
  });

  it('is true for output carrying its own <script>, which never runs as HTML', () => {
    expect(lostInteractivity(fragment('<div><script>start()</script></div>'))).toBe(true);
  });

  it('is false when the output is an iframe, which runs its own scripts', () => {
    const iframe = fragment('<iframe srcdoc="&lt;script&gt;go()&lt;/script&gt;"></iframe>');
    expect(lostInteractivity(iframe)).toBe(false);
  });

  it('ignores values that are not elements', () => {
    expect(lostInteractivity(null)).toBe(false);
    expect(lostInteractivity('<button>x</button>')).toBe(false);
    expect(lostInteractivity({})).toBe(false);
  });
});
