/**
 * Show a notebook-wide search inside each cell's editor.
 *
 * The search runs over the notebook (notebookSearch.ts); each CodeMirror only
 * paints what falls in its own cell — every match softly, the current one
 * strongly. Seeing all the hits at once is most of what a find bar is for.
 *
 * One store drives every editor. An editor subscribes when it is created and
 * repaints when the search changes or its own text does, so a replacement, an
 * edit or a new query all stay in step without the find bar knowing which
 * editors happen to be mounted.
 */
import { writable } from 'svelte/store';
import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { findInText, type Match } from './notebookSearch';

export interface SearchHighlight {
  regex: RegExp | null;
  current: Match | null;
}

export const searchHighlight = writable<SearchHighlight>({ regex: null, current: null });

const repaint = StateEffect.define<null>();
const hit = Decoration.mark({ class: 'cm-notebook-match' });
const currentHit = Decoration.mark({ class: 'cm-notebook-match cm-notebook-match-current' });

export function searchHighlighter(cellId: string): Extension {
  let state: SearchHighlight = { regex: null, current: null };

  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    if (!state.regex) return builder.finish();
    const text = view.state.doc.toString();
    for (const { from, to } of findInText(text, state.regex)) {
      const isCurrent =
        state.current?.cellId === cellId && state.current.from === from && state.current.to === to;
      builder.add(from, to, isCurrent ? currentHit : hit);
    }
    return builder.finish();
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      unsubscribe: () => void;

      destroyed = false;

      constructor(view: EditorView) {
        let initial = true;
        this.unsubscribe = searchHighlight.subscribe((next) => {
          state = next;
          // The subscription answers synchronously while the view is still
          // being built, when dispatching is not allowed; the first paint
          // happens just below instead.
          if (initial) return;
          // Deferred: the search can change because this very editor's text
          // changed, and dispatching from inside its own update throws.
          queueMicrotask(() => {
            if (!this.destroyed) view.dispatch({ effects: repaint.of(null) });
          });
        });
        initial = false;
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(repaint)))) {
          this.decorations = build(update.view);
        }
      }

      destroy() {
        this.destroyed = true;
        this.unsubscribe();
      }
    },
    { decorations: (value) => value.decorations }
  );

  const theme = EditorView.baseTheme({
    '.cm-notebook-match': {
      backgroundColor: 'color-mix(in srgb, var(--accent, #0d9488) 22%, transparent)',
      borderRadius: '2px',
    },
    '.cm-notebook-match-current': {
      backgroundColor: 'color-mix(in srgb, var(--accent, #0d9488) 55%, transparent)',
      outline: '1px solid var(--accent, #0d9488)',
    },
  });

  return [plugin, theme];
}
