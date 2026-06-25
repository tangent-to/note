<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import loader from '@monaco-editor/loader';
  import { aiService } from '../utils/aiService';
  import { buildNotebookContext } from '../utils/notebookContext';

  interface Props {
    value?: string;
    language?: string;
    theme?: string;
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
    theme = 'vs',
    height = '200px',
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
  let editor: any;
  let monacoLib: any;
  let editorHeight = $state('32px');
  let editorReady = $state(false);
  let focusDisposable: { dispose: () => void } | null = null;
  let blurDisposable: { dispose: () => void } | null = null;
  let removePointerListener: (() => void) | null = null;
  let contentSizeDisposable: { dispose: () => void } | null = null;
  const MIN_HEIGHT = 20;
  const HEIGHT_PADDING = 6;

  function getContentHeight(): number {
    try {
      if (!editor) return MIN_HEIGHT;
      const h = typeof editor.getContentHeight === 'function'
        ? editor.getContentHeight()
        : undefined;
      if (h != null && Number.isFinite(h) && h > 0) return h;
    } catch {
      // fall through to minimum
    }
    return MIN_HEIGHT;
  }

  function applyEditorHeight(px: number) {
    const padded = Math.max(0, px) + HEIGHT_PADDING;
    editorHeight = `${Math.max(MIN_HEIGHT, Math.round(padded))}px`;
  }

  function scheduleHeightSync(delays: number[] = [0, 80, 200, 400]) {
    if (height !== 'auto') return;
    delays.forEach((delay) => {
      setTimeout(() => {
        if (!editor) return;
        try {
          applyEditorHeight(getContentHeight());
          editor.layout();
        } catch {
          // ignore measurement failures
        }
      }, delay);
    });
  }

  function patchCaretRangeFallback(doc: Document | null | undefined) {
    if (!doc) return;
    const anyDoc = doc as any;
    if (anyDoc.__tangentPatchedCaretRange) return;

    const originalCaretRange = typeof anyDoc.caretRangeFromPoint === 'function'
      ? anyDoc.caretRangeFromPoint.bind(doc)
      : null;
    const originalCaretPosition = typeof anyDoc.caretPositionFromPoint === 'function'
      ? anyDoc.caretPositionFromPoint.bind(doc)
      : null;

    if (!originalCaretRange && !originalCaretPosition) return;

    anyDoc.__tangentPatchedCaretRange = true;
    anyDoc.caretRangeFromPoint = (x: number, y: number) => {
      try {
        if (originalCaretRange) {
          const range = originalCaretRange(x, y);
          if (range) return range;
        }
        if (originalCaretPosition) {
          const pos = originalCaretPosition(x, y);
          if (pos && pos.offsetNode) {
            const synthetic = doc.createRange();
            synthetic.setStart(pos.offsetNode, pos.offset ?? 0);
            synthetic.collapse(true);
            return synthetic;
          }
        }
        if (doc.body) {
          const synthetic = doc.createRange();
          synthetic.setStart(doc.body, 0);
          synthetic.collapse(true);
          return synthetic;
        }
      } catch {
        // ignore and fall through
      }
      return null;
    };
  }

  let computedHeight = $derived(height === 'auto' ? editorHeight : height);

  // Sync editor value when prop changes from outside
  $effect(() => {
    if (!editorReady || !editor) return;
    if (value !== editor.getValue()) {
      editor.setValue(value);
      if (height === 'auto') {
        setTimeout(() => {
          applyEditorHeight(getContentHeight());
          editor.layout();
        }, 0);
      }
    }
  });

  // Sync editor theme when prop changes
  $effect(() => {
    if (!editorReady || !editor || !monacoLib) return;
    monacoLib.editor.setTheme(theme);
  });

  // Sync editor language when prop changes
  $effect(() => {
    if (!editorReady || !editor || !monacoLib) return;
    const model = editor.getModel();
    if (model) {
      monacoLib.editor.setModelLanguage(model, language);
    }
  });

  onMount(async () => {
    monacoLib = await loader.init();

    patchCaretRangeFallback(container?.ownerDocument ?? document);

    async function waitForContainerVisible(el: HTMLElement | undefined | null, timeout = 3000) {
      if (!el) return;
      const start = performance.now();
      return new Promise<void>((resolve) => {
        const check = () => {
          try {
            if (
              el &&
              el.isConnected &&
              el.offsetParent !== null &&
              el.getBoundingClientRect &&
              el.getBoundingClientRect().width > 0 &&
              el.getBoundingClientRect().height > 0
            ) {
              resolve();
              return;
            }
            if (performance.now() - start > timeout) {
              resolve();
              return;
            }
          } catch {
            // ignore exceptions and retry
          }
          requestAnimationFrame(check);
        };
        check();
      });
    }

    if (monacoLib.languages && monacoLib.languages.typescript) {
      monacoLib.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monacoLib.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        moduleResolution: monacoLib.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monacoLib.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        esModuleInterop: true,
        jsx: monacoLib.languages.typescript.JsxEmit.React,
        reactNamespace: 'React',
        allowJs: true,
        typeRoots: ['node_modules/@types']
      });

      monacoLib.languages.typescript.javascriptDefaults.addExtraLib(`
        declare const d3: any;
        declare const Plot: any;
        declare const console: {
          log(...args: any[]): void;
          error(...args: any[]): void;
          warn(...args: any[]): void;
        };
        /** Shared notebook scope. Write: \`nb.x = 42\`  Read: \`const { x } = nb\` */
        declare const nb: Record<string, any>;
      `, 'global.d.ts');
    }

    await waitForContainerVisible(container);

    await initEditor();
  });

  async function initEditor(attempt = 0) {
    if (editor) return;
    if (!container?.isConnected || !container?.parentNode) {
      if (attempt < 5) {
        setTimeout(() => initEditor(attempt + 1), 150 * (attempt + 1));
      }
      return;
    }

    try {
      editor = monacoLib.editor.create(container, {
        value,
        language,
        theme,
        readOnly,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 4,
        automaticLayout: true,
        fontSize: 12,
        fontFamily: '"Fira Code", Monaco, Menlo, "Ubuntu Mono", monospace',
        tabSize: 2,
        insertSpaces: true,
        contextmenu: true,
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        acceptSuggestionOnCommitCharacter: true,
        snippetSuggestions: 'top',
        inlineSuggest: { enabled: true },
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          useShadows: false,
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
          alwaysConsumeMouseWheel: false
        },
        padding: {
          top: 4,
          bottom: 4
        }
      });

      try {
        setTimeout(() => {
          try { editor.layout(); } catch {}
        }, 0);

        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(() => {
            try { editor.layout(); } catch {}
          });
          ro.observe(container);
        } else {
          const onWinResize = () => {
            try { editor.layout(); } catch {}
          };
          window.addEventListener('resize', onWinResize);
        }
      } catch (e) {
        // no-op if layout helpers fail
      }

      editor.onDidChangeModelContent(() => {
        const newValue = editor.getValue();
        if (newValue !== value) {
          onchange?.({ value: newValue });
        }

        if (height === 'auto') scheduleHeightSync([80]);
      });

      contentSizeDisposable = editor.onDidContentSizeChange((e: any) => {
        if (height !== 'auto') return;
        const h = e?.contentHeight;
        if (h != null && Number.isFinite(h) && h > 0) {
          applyEditorHeight(h);
        } else {
          applyEditorHeight(getContentHeight());
        }
        editor.layout();
      });

      if (height === 'auto') {
        const syncHeights = () => {
          applyEditorHeight(getContentHeight());
          editor.layout();
        };
        syncHeights();
        [80, 200, 400].forEach(delay => setTimeout(syncHeights, delay));
      }

      const domKeyHandler = (e: KeyboardEvent) => {
        if (e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          onrunAndAdvance?.();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onrun?.();
        }
      };

      container.addEventListener('keydown', domKeyHandler, true);

      const forwardFocus = () => {
        oneditorFocus?.();
        onfocus?.();
      };
      try {
        focusDisposable = editor.onDidFocusEditorWidget(forwardFocus);
        blurDisposable = editor.onDidBlurEditorWidget(() => {
          oneditorBlur?.();
          onblur?.();
        });
      } catch {
        focusDisposable = null;
        blurDisposable = null;
      }

      const pointerHandler = () => {
        try {
          editor?.focus();
        } catch {
          // best-effort focus
        }
        forwardFocus();
      };
      const pointerOptions: AddEventListenerOptions = { capture: true };
      container.addEventListener('pointerdown', pointerHandler, pointerOptions);
      removePointerListener = () => {
        try {
          container.removeEventListener('pointerdown', pointerHandler, pointerOptions);
        } catch {
          // ignore cleanup failure
        }
      };

      editor.addCommand(monacoLib.KeyMod.CtrlCmd | monacoLib.KeyCode.Space, () => {
        triggerAICompletion();
      });

      editor.addCommand(monacoLib.KeyMod.CtrlCmd | monacoLib.KeyMod.Shift | monacoLib.KeyCode.KeyG, () => {
        triggerAIGeneration();
      });

      registerAICompletionProvider();

      editorReady = true;
      try { editor.focus(); } catch {}
    } catch (err) {
      console.warn('Monaco editor creation failed:', err);
      if (attempt < 3) {
        setTimeout(() => initEditor(attempt + 1), 300 * (attempt + 1));
      }
    }
  }

  async function triggerAICompletion() {
    if (!editor || !aiService.isConfigured() || !monacoLib) return;

    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;

    try {
      const code = model.getValue();
      const offset = model.getOffsetAt(position);

      const completion = await aiService.getCodeCompletion({
        code,
        cursor: offset,
        language: 'javascript',
        context: buildNotebookContext()
      });

      if (completion.completions.length > 0) {
        const suggestion = completion.completions[0];
        editor.executeEdits('ai-completion', [{
          range: new monacoLib.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          text: suggestion
        }]);
      }
    } catch (error) {
      console.error('AI completion failed:', error);
    }
  }

  async function triggerAIGeneration() {
    if (!editor || !aiService.isConfigured()) return;

    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!model || !selection) return;

    const selectedText = model.getValueInRange(selection);
    const userPrompt = selectedText || window.prompt('Enter a description of the code you want to generate:');

    if (!userPrompt) return;

    try {
      const generation = await aiService.generateCode({
        prompt: userPrompt,
        language: 'javascript',
        context: buildNotebookContext()
      });

      if (generation.code) {
        editor.executeEdits('ai-generation', [{
          range: selection,
          text: generation.code
        }]);
      }
    } catch (error: any) {
      console.error('AI generation failed:', error);
      alert(`AI generation failed: ${error.message}`);
    }
  }

  // Inline (ghost-text) AI completion, Copilot-style. Registered once globally
  // for the `javascript` language. Debounced and cancellable so we don't fire
  // the (slow, paid) cloud model on every keystroke.
  let inlineRequestSeq = 0;

  function registerAICompletionProvider() {
    if (!monacoLib) return;
    if ((window as any).__tangent_inlineProviderRegistered) return;
    (window as any).__tangent_inlineProviderRegistered = true;

    monacoLib.languages.registerInlineCompletionsProvider('javascript', {
      provideInlineCompletions: async (model: any, position: any, _context: any, token: any) => {
        if (!aiService.isConfigured()) return { items: [] };

        const requestId = ++inlineRequestSeq;
        // Debounce: wait for a typing pause, bail if superseded or cancelled.
        await new Promise(resolve => setTimeout(resolve, 500));
        if (token.isCancellationRequested || requestId !== inlineRequestSeq) {
          return { items: [] };
        }

        const offset = model.getOffsetAt(position);
        const prefix = model.getValue().slice(0, offset);
        if (!prefix.trim()) return { items: [] };

        try {
          const completion = await aiService.getCodeCompletion({
            code: prefix,
            cursor: offset,
            language: 'javascript',
            context: buildNotebookContext()
          });

          if (token.isCancellationRequested || requestId !== inlineRequestSeq) {
            return { items: [] };
          }

          const text = completion.completions[0];
          if (!text) return { items: [] };

          return {
            items: [{
              insertText: text,
              range: new monacoLib.Range(
                position.lineNumber, position.column,
                position.lineNumber, position.column
              )
            }]
          };
        } catch (error) {
          console.error('AI inline completion failed:', error);
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {}
    });
  }

  onDestroy(() => {
    if (editor) {
      editor.dispose();
    }
    try {
      focusDisposable?.dispose();
    } catch {}
    try {
      blurDisposable?.dispose();
    } catch {}
    try {
      removePointerListener?.();
    } catch {}
    try {
      contentSizeDisposable?.dispose();
    } catch {}
  });

  export function focus() {
    if (editor) {
      editor.focus();
    }
  }

  export function getEditor() {
    return editor;
  }
</script>

<div bind:this={container} class="monaco-editor-container" tabindex="0" role="textbox" style="height: {computedHeight}; width: 100%;"></div>

<style>
  .monaco-editor-container {
    min-height: 20px;
    transition: height 0.1s ease;
  }
  :global(.monaco-editor) {
    border-radius: 0.375rem;
  }

  /* Increase spacing between line numbers and code */
  :global(.monaco-editor .margin) {
    padding-right: 16px !important;
    background: transparent;
  }

  :global(.monaco-editor .line-numbers) {
    padding-right: 12px !important;
  }
</style>
