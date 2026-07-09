/**
 * Inline AI ghost-text suggestions for CodeMirror 6 (Copilot-style),
 * replacing the Monaco inline-completions provider.
 *
 * - After a 500 ms typing pause, asks aiService for a completion at the
 *   caret and shows it as dimmed ghost text. Any edit or caret move
 *   dismisses it; Tab accepts, Escape dismisses.
 * - `triggerAiSuggestion(view)` requests one immediately (Mod-Space).
 * - `runAiGeneration(view)` generates code from the selection or a prompt
 *   and inserts it (Mod-Shift-G).
 *
 * All requests are inert unless aiService.isConfigured().
 */
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { aiService } from './aiService';
import { buildNotebookContext } from './notebookContext';
import { toast } from './toast';

interface Suggestion {
  text: string;
  from: number;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ai-ghost';
    span.textContent = this.text;
    return span;
  }
  get lineBreaks() {
    let n = 0;
    for (const ch of this.text) if (ch === '\n') n++;
    return n;
  }
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    // Any edit or caret move invalidates the pending ghost text.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (s): DecorationSet => {
      if (!s || !s.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(s.text), side: 1 }).range(s.from),
      ]);
    }),
});

// Monotonic request id so stale (superseded) responses are dropped.
let requestSeq = 0;

async function requestSuggestion(view: EditorView): Promise<void> {
  if (!aiService.isConfigured()) return;
  const id = ++requestSeq;
  const pos = view.state.selection.main.head;
  const code = view.state.doc.toString();
  const prefix = code.slice(0, pos);
  if (!prefix.trim()) return;

  try {
    const completion = await aiService.getCodeCompletion({
      code: prefix,
      cursor: pos,
      language: 'javascript',
      context: buildNotebookContext(),
    });
    if (id !== requestSeq) return; // superseded by a newer request
    const text = completion.completions?.[0];
    if (!text) return;
    // The document/caret may have changed while the request was in flight.
    if (view.state.selection.main.head !== pos) return;
    view.dispatch({ effects: setSuggestion.of({ text, from: pos }) });
  } catch (error) {
    console.error('AI inline completion failed:', error);
  }
}

/** Request a ghost-text suggestion right now (no debounce). */
export function triggerAiSuggestion(view: EditorView): boolean {
  if (!aiService.isConfigured()) return false;
  void requestSuggestion(view);
  return true;
}

/** Generate code from the selection (or a prompt) and insert it. */
export function runAiGeneration(view: EditorView): boolean {
  if (!aiService.isConfigured()) return false;
  const { from, to } = view.state.selection.main;
  const selectedText = view.state.sliceDoc(from, to);
  const userPrompt =
    selectedText || window.prompt('Enter a description of the code you want to generate:');
  if (!userPrompt) return true;

  aiService
    .generateCode({
      prompt: userPrompt,
      language: 'javascript',
      context: buildNotebookContext(),
    })
    .then((generation) => {
      if (generation.code) {
        view.dispatch({
          changes: { from, to, insert: generation.code },
          selection: { anchor: from + generation.code.length },
        });
      }
    })
    .catch((error: any) => {
      console.error('AI generation failed:', error);
      toast(`AI generation failed: ${error.message}`, 'error');
    });
  return true;
}

/** Debounced automatic suggestions while typing. */
const autoSuggestPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      if (!aiService.isConfigured()) return;
      this.timer = setTimeout(() => {
        if (this.view.hasFocus) void requestSuggestion(this.view);
      }, 500);
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

const suggestionKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        const s = view.state.field(suggestionField, false);
        if (!s || !s.text) return false; // fall through to normal Tab (indent)
        view.dispatch({
          changes: { from: s.from, insert: s.text },
          selection: { anchor: s.from + s.text.length },
        });
        return true;
      },
    },
    {
      key: 'Escape',
      run: (view) => {
        const s = view.state.field(suggestionField, false);
        if (!s) return false;
        view.dispatch({ effects: setSuggestion.of(null) });
        return true;
      },
    },
    { key: 'Mod-Space', run: triggerAiSuggestion },
    { key: 'Mod-Shift-g', run: runAiGeneration },
  ]),
);

export function aiInlineSuggestions(): Extension {
  return [suggestionField, autoSuggestPlugin, suggestionKeymap];
}
