<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
  } from '@codemirror/view';
  import { EditorState, Compartment, Prec } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
  import {
    bracketMatching,
    indentOnInput,
    indentUnit,
    syntaxHighlighting,
  } from '@codemirror/language';
  import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
  } from '@codemirror/autocomplete';
  import { javascript } from '@codemirror/lang-javascript';
  import { markdown } from '@codemirror/lang-markdown';
  import { classHighlighter } from '@lezer/highlight';
  import { aiInlineSuggestions } from '../utils/cmAiCompletion';

  interface Props {
    value?: string;
    /** 'javascript' (default) or 'markdown'. */
    language?: string;
    height?: string;
    readOnly?: boolean;
    /** Console REPL mode: plain Enter submits, Shift+Enter inserts a newline,
     *  and Arrow Up/Down at the first/last line browse input history. */
    submitOnEnter?: boolean;
    onchange?: (detail: { value: string }) => void;
    onrun?: () => void;
    onrunAndAdvance?: () => void;
    onsubmit?: () => void;
    onhistory?: (direction: 'prev' | 'next') => boolean;
    oneditorFocus?: () => void;
    onfocus?: () => void;
    oneditorBlur?: () => void;
    onblur?: () => void;
  }

  let {
    value = '',
    language = 'javascript',
    height = 'auto',
    readOnly = false,
    submitOnEnter = false,
    onchange,
    onrun,
    onrunAndAdvance,
    onsubmit,
    onhistory,
    oneditorFocus,
    onfocus,
    oneditorBlur,
    onblur,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = null;

  const readOnlyCompartment = new Compartment();

  // Colors come from the app's CSS variables, so the editor follows the
  // light/dark theme with no JS theme switching.
  const editorTheme = EditorView.theme({
    '&': {
      fontSize: '12px',
      backgroundColor: 'transparent',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      caretColor: 'var(--text)',
      padding: '4px 0',
      lineHeight: '1.55',
    },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-faint)',
      border: 'none',
      paddingRight: '12px',
      fontVariantNumeric: 'tabular-nums',
    },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.4em' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--accent-weak-bg, rgba(100, 130, 255, 0.18))',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-input)',
      boxShadow: 'var(--shadow-md)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--surface-hover)',
      color: 'var(--heading)',
    },
    '.cm-ai-ghost': {
      color: 'var(--text-faint)',
      opacity: '0.75',
    },
  });

  // stopPropagation matters: the Notebook component has a global window
  // keydown handler for these same shortcuts, and without it a run from
  // inside the editor would bubble up and execute the cell twice.
  const runKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Shift-Enter',
        stopPropagation: true,
        run: () => {
          onrunAndAdvance?.();
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        stopPropagation: true,
        run: () => {
          onrun?.();
          return true;
        },
      },
    ]),
  );

  // Console REPL keymap (used instead of runKeymap when submitOnEnter is set).
  const atFirstLine = (v: EditorView) =>
    v.state.doc.lineAt(v.state.selection.main.head).number === 1;
  const atLastLine = (v: EditorView) =>
    v.state.doc.lineAt(v.state.selection.main.head).number === v.state.doc.lines;

  const consoleKeymap = Prec.highest(
    keymap.of([
      { key: 'Enter', stopPropagation: true, run: () => { onsubmit?.(); return true; } },
      { key: 'Shift-Enter', stopPropagation: true, run: insertNewlineAndIndent },
      { key: 'ArrowUp', run: (v) => (atFirstLine(v) ? (onhistory?.('prev') ?? false) : false) },
      { key: 'ArrowDown', run: (v) => (atLastLine(v) ? (onhistory?.('next') ?? false) : false) },
    ]),
  );

  onMount(() => {
    const isMarkdown = language === 'markdown';
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Prose doesn't need line numbers; code does. The console prompt is a
          // single REPL line, so it doesn't either.
          ...(isMarkdown || submitOnEnter ? [] : [lineNumbers()]),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          EditorView.lineWrapping,
          isMarkdown ? markdown() : javascript(),
          syntaxHighlighting(classHighlighter),
          editorTheme,
          submitOnEnter ? consoleKeymap : runKeymap,
          aiInlineSuggestions(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          readOnlyCompartment.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newValue = update.state.doc.toString();
              if (newValue !== value) onchange?.({ value: newValue });
            }
            if (update.focusChanged) {
              if (update.view.hasFocus) {
                oneditorFocus?.();
                onfocus?.();
              } else {
                oneditorBlur?.();
                onblur?.();
              }
            }
          }),
        ],
      }),
    });
  });

  // Sync editor value when the prop changes from outside.
  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  });

  // Sync read-only state when the prop changes.
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  export function focus() {
    view?.focus();
  }

  export function getEditor() {
    return view;
  }
</script>

<div
  bind:this={container}
  class="code-editor-container"
  style={height !== 'auto' ? `height: ${height}; overflow: auto;` : ''}
></div>

<style>
  .code-editor-container {
    min-height: 20px;
    width: 100%;
  }

  .code-editor-container :global(.cm-editor) {
    border-radius: var(--radius-input);
  }

  /* Syntax colors (classHighlighter token classes), themed via data-theme.
     Brand-tuned palette for the warm-stone + teal identity: keywords in the
     tangent teal, strings in warm sienna, calls in a muted slate blue,
     literals in muted violet (Flexoki-derived hues, all pairs >= 4.5:1).
     Nothing red: red is reserved for actual errors. Operators and plain
     variables stay in the text color so code doesn't turn into confetti. */
  .code-editor-container :global(.tok-keyword) { color: #076e5e; }
  .code-editor-container :global(.tok-string),
  .code-editor-container :global(.tok-special.tok-string) { color: #9a3412; }
  .code-editor-container :global(.tok-number),
  .code-editor-container :global(.tok-bool),
  .code-editor-container :global(.tok-atom) { color: #5e409d; }
  .code-editor-container :global(.tok-comment) { color: #78716c; font-style: italic; }
  .code-editor-container :global(.tok-definition.tok-variableName),
  .code-editor-container :global(.tok-function.tok-variableName),
  .code-editor-container :global(.tok-function.tok-propertyName) { color: #205ea6; }
  .code-editor-container :global(.tok-propertyName) { color: #205ea6; }
  .code-editor-container :global(.tok-typeName),
  .code-editor-container :global(.tok-className) { color: #92400e; }
  .code-editor-container :global(.tok-regexp) { color: #a02f6f; }
  /* Markdown prose tokens */
  .code-editor-container :global(.tok-heading) { color: var(--heading, #1c1917); font-weight: 700; }
  .code-editor-container :global(.tok-emphasis) { font-style: italic; }
  .code-editor-container :global(.tok-strong) { font-weight: 700; }
  .code-editor-container :global(.tok-link),
  .code-editor-container :global(.tok-url) { color: #076e5e; }
  .code-editor-container :global(.tok-monospace) { color: #9a3412; }

  :global(html[data-theme='dark']) .code-editor-container :global(.tok-keyword) { color: #3aa99f; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-string),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-special.tok-string) { color: #da702c; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-number),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-bool),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-atom) { color: #a898d8; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-comment) { color: #8a847f; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-definition.tok-variableName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-function.tok-variableName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-function.tok-propertyName) { color: #6fa3d4; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-propertyName) { color: #6fa3d4; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-typeName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-className) { color: #d0a215; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-regexp) { color: #ce5d97; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-link),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-url) { color: #3aa99f; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-monospace) { color: #da702c; }
</style>
