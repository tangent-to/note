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
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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
  import { classHighlighter } from '@lezer/highlight';
  import { aiInlineSuggestions } from '../utils/cmAiCompletion';

  interface Props {
    value?: string;
    /** Kept for API compatibility; code cells are always JavaScript. */
    language?: string;
    height?: string;
    readOnly?: boolean;
    onchange?: (detail: { value: string }) => void;
    onrun?: () => void;
    onrunAndAdvance?: () => void;
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
    onchange,
    onrun,
    onrunAndAdvance,
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

  const runKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Shift-Enter',
        run: () => {
          onrunAndAdvance?.();
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: () => {
          onrun?.();
          return true;
        },
      },
    ]),
  );

  onMount(() => {
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
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
          javascript(),
          syntaxHighlighting(classHighlighter),
          editorTheme,
          runKeymap,
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
     Palette follows GitHub light/dark for familiarity and AA contrast. */
  .code-editor-container :global(.tok-keyword) { color: #cf222e; }
  .code-editor-container :global(.tok-string),
  .code-editor-container :global(.tok-special.tok-string) { color: #0a3069; }
  .code-editor-container :global(.tok-number),
  .code-editor-container :global(.tok-bool),
  .code-editor-container :global(.tok-atom) { color: #0550ae; }
  .code-editor-container :global(.tok-comment) { color: #6e7781; font-style: italic; }
  .code-editor-container :global(.tok-definition.tok-variableName),
  .code-editor-container :global(.tok-function.tok-variableName),
  .code-editor-container :global(.tok-function.tok-propertyName) { color: #8250df; }
  .code-editor-container :global(.tok-propertyName) { color: #0550ae; }
  .code-editor-container :global(.tok-typeName),
  .code-editor-container :global(.tok-className) { color: #953800; }
  .code-editor-container :global(.tok-operator) { color: #cf222e; }
  .code-editor-container :global(.tok-regexp) { color: #116329; }

  :global(html[data-theme='dark']) .code-editor-container :global(.tok-keyword) { color: #ff7b72; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-string),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-special.tok-string) { color: #a5d6ff; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-number),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-bool),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-atom) { color: #79c0ff; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-comment) { color: #8b949e; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-definition.tok-variableName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-function.tok-variableName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-function.tok-propertyName) { color: #d2a8ff; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-propertyName) { color: #79c0ff; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-typeName),
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-className) { color: #ffa657; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-operator) { color: #ff7b72; }
  :global(html[data-theme='dark']) .code-editor-container :global(.tok-regexp) { color: #7ee787; }
</style>
