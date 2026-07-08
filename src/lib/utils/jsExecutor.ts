/**
 * tangent-notebook_/frontend/src/lib/utils/jsExecutor.ts
 *
 * JavaScript executor used by Tangent Notebook frontend.
 *
 * Responsibilities:
 * - Execute non-module JS code using an explicit shared scope object
 *   so notebook-level variables persist between cells predictably.
 * - Route code that contains top-level `import`/`export` to module execution.
 * - Capture console output and collect DOM outputs appended to a temporary output div.
 * - Preserve last-expression display without mutating the global scope unless the
 *   executed code does so explicitly.
 * - Intercept dynamic <script> injection from cell code and temporarily disable
 *   Monaco's RequireJS/AMD `define` so third-party UMD/WASM scripts (e.g. Verovio)
 *   don't collide with the AMD loader.
 */

import type { CellOutput } from "../types/notebook";
import { getDataset, listDatasetNames } from "./dataStore";

export class JavaScriptExecutor {
  private outputElement: HTMLElement | null = null;

  /** Explicit shared scope for notebook variables across cells */
  private scope: Record<string, any> = {};

  constructor() {
    this.setupExecutionEnvironment();
  }

  private setupExecutionEnvironment() {
    (window as any).__tangent_loadedModules =
      (window as any).__tangent_loadedModules || {};
    // Expose shared scope on window so cells can access it.
    // `nb` is the short public alias: write with `nb.x = 42`, read with
    // `const { x } = nb` or `nb.x`.
    (window as any).__tangent_scope = this.scope;
    (window as any).nb = this.scope;
    // Reactive input widgets (sliders, etc.) available to cells as `ui.*`.
    this.setupInputs();
    // `data(name)` accessor for files dropped into the Data panel.
    this.setupDataAccess();
    // Install the AMD guard so dynamically injected scripts don't conflict
    // with Monaco Editor's RequireJS loader.
    this.installAmdGuard();
  }

  /**
   * Expose `data(name)` to cells: reads a file cached in IndexedDB (dropped into
   * the Data panel) and parses it by extension. `.csv`/`.tsv` use d3 with type
   * coercion, `.json` uses JSON.parse, anything else falls back to raw text.
   * Use `data.text(name)` for the raw string and `data.list()` for the names.
   *
   * Lives on `window` (not the shared scope) so it survives scope clears and
   * stays out of the Variables panel.
   */
  private setupDataAccess(): void {
    const ensureD3 = async (): Promise<any> => {
      if (!(window as any).d3) {
        try { await this.setupCommonLibraries(); } catch { /* ignore */ }
      }
      return (window as any).d3;
    };

    const parse = async (name: string, text: string): Promise<any> => {
      const lower = name.toLowerCase();
      if (lower.endsWith(".json") || lower.endsWith(".ndjson")) return JSON.parse(text);
      if (lower.endsWith(".tsv")) {
        const d3 = await ensureD3();
        return d3 ? d3.tsvParse(text, d3.autoType) : text;
      }
      if (lower.endsWith(".csv")) {
        const d3 = await ensureD3();
        return d3 ? d3.csvParse(text, d3.autoType) : text;
      }
      try { return JSON.parse(text); } catch { return text; }
    };

    const readText = async (name: string): Promise<string> => {
      const rec = await getDataset(name);
      if (!rec) {
        throw new Error(`No dataset "${name}". Drop the file into the Data panel (right sidebar) first.`);
      }
      return rec.text;
    };

    const data: any = async (name: string) => parse(name, await readText(name));
    data.text = readText;
    data.list = () => listDatasetNames();

    (window as any).data = data;
  }

  /**
   * Reactive HTML inputs, exposed to cells as `ui` (e.g. `ui.slider("x", {...})`).
   *
   * An input binds a notebook variable by name: it writes the current value into
   * the shared scope and, on change, dispatches `tangent-input-change` so the
   * notebook can re-run the cells that depend on that variable. The call returns
   * the DOM element, so a cell ending in `ui.slider(...)` displays the control.
   *
   * Browser-only by nature (like Observable's inputs) — these don't run under
   * plain Deno/Zed, but the notebook file is still valid JavaScript.
   */
  private setupInputs() {
    const scope = this.scope;

    // Degrade gracefully outside a browser (Deno, Zed, headless): no DOM, so
    // each input just binds and returns its value instead of building an element.
    const hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';

    const bind = (name: string, value: any) => {
      scope[name] = value;
    };

    // Debounced notification so dragging a slider doesn't spam re-runs.
    const timers: Record<string, any> = {};
    const notify = (name: string) => {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => {
        window.dispatchEvent(new CustomEvent('tangent-input-change', { detail: { name } }));
      }, 120);
    };

    const wrap = (name: string, labelText: string, control: HTMLElement, valueEl?: HTMLElement) => {
      const el = document.createElement('div');
      el.className = 'tangent-input';
      el.style.cssText = 'display:flex;align-items:center;gap:0.5rem;font:13px/1.4 var(--font-sans, system-ui),sans-serif;padding:0.25rem 0;';
      const label = document.createElement('label');
      label.textContent = labelText;
      label.style.cssText = 'min-width:6rem;color:var(--text-muted, #4a4a4a);font-weight:500;';
      el.append(label, control);
      if (valueEl) el.append(valueEl);
      return el;
    };

    const ui = {
      slider(name: string, opts: any = {}) {
        const { min = 0, max = 100, step = 1, value = min, label = name } = opts;
        bind(name, Number(value));
        if (!hasDOM) return Number(value);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.value = String(value);
        input.style.flex = '1';
        const out = document.createElement('span');
        out.style.cssText = 'min-width:3rem;font-family:var(--font-mono, monospace);color:var(--heading, #1a1a1a);';
        out.textContent = String(value);
        input.addEventListener('input', () => {
          const v = Number(input.value);
          out.textContent = String(v);
          bind(name, v);
          notify(name);
        });
        return wrap(name, label, input, out);
      },
      number(name: string, opts: any = {}) {
        const { min, max, step = 1, value = 0, label = name } = opts;
        bind(name, Number(value));
        if (!hasDOM) return Number(value);
        const input = document.createElement('input');
        input.type = 'number';
        if (min !== undefined) input.min = String(min);
        if (max !== undefined) input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        input.addEventListener('input', () => { bind(name, Number(input.value)); notify(name); });
        return wrap(name, label, input);
      },
      checkbox(name: string, opts: any = {}) {
        const { value = false, label = name } = opts;
        bind(name, Boolean(value));
        if (!hasDOM) return Boolean(value);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
        input.addEventListener('change', () => { bind(name, input.checked); notify(name); });
        return wrap(name, label, input);
      },
      select(name: string, opts: any = {}) {
        const { options = [], value, label = name } = opts;
        const resolved = value !== undefined ? value : (options[0] ?? '');
        bind(name, resolved);
        if (!hasDOM) return resolved;
        const sel = document.createElement('select');
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = String(opt); o.textContent = String(opt);
          if (value !== undefined && String(opt) === String(value)) o.selected = true;
          sel.append(o);
        }
        sel.addEventListener('change', () => { bind(name, sel.value); notify(name); });
        return wrap(name, label, sel);
      },
      text(name: string, opts: any = {}) {
        const { value = '', label = name, placeholder = '' } = opts;
        bind(name, String(value));
        if (!hasDOM) return String(value);
        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(value); input.placeholder = placeholder;
        input.style.flex = '1';
        input.addEventListener('input', () => { bind(name, input.value); notify(name); });
        return wrap(name, label, input);
      },
    };

    (window as any).ui = ui;
  }

  /**
   * Monkey-patch document.createElement to intercept <script> element creation.
   * When a notebook cell (or a library it loads) injects a <script> tag,
   * we temporarily hide `window.define` so that UMD/AMD scripts see no AMD
   * loader and fall through to their global/IIFE path instead of colliding
   * with Monaco's RequireJS.
   *
   * `define` is restored once the script's `load` or `error` event fires.
   * Idempotent — safe to call multiple times.
   */
  private installAmdGuard() {
    if ((window as any).__tangent_amdGuardInstalled) return;
    (window as any).__tangent_amdGuardInstalled = true;

    const origCreateElement = document.createElement.bind(document);
    const srcDescriptor = Object.getOwnPropertyDescriptor(
      HTMLScriptElement.prototype,
      "src",
    );

    document.createElement = function (
      tagName: string,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const el = origCreateElement(tagName, options);

      // Only patch <script> elements, and only if we can intercept src
      if (tagName.toLowerCase() !== "script" || !srcDescriptor?.set) {
        return el;
      }

      const origSrcSet = srcDescriptor.set;
      const origSrcGet = srcDescriptor.get;

      // Override `src` on this specific element instance.
      // When src is assigned, hide AMD `define` until load/error fires.
      Object.defineProperty(el, "src", {
        set(value: string) {
          const savedDefine = (window as any).define;
          if (savedDefine && savedDefine.amd) {
            (window as any).define = undefined;

            const restore = () => {
              // Only restore if nothing else has set define in the meantime
              if (!(window as any).define) {
                (window as any).define = savedDefine;
              }
            };
            el.addEventListener("load", restore, { once: true });
            el.addEventListener("error", restore, { once: true });
            // Safety net: restore after 30s even if no event fires
            setTimeout(restore, 30000);
          }

          origSrcSet.call(el, value);
        },
        get() {
          return origSrcGet?.call(el) ?? "";
        },
        configurable: true,
        enumerable: true,
      });

      return el;
    } as typeof document.createElement;
  }

  /** Reset the shared scope (equivalent to "restart kernel") */
  resetScope() {
    for (const key of Object.keys(this.scope)) {
      delete this.scope[key];
    }
    (window as any).__tangent_scope = this.scope;
  }

  /** Get current variable names and values from shared scope */
  getVariables(): Record<string, any> {
    const vars: Record<string, any> = {};
    for (const [key, value] of Object.entries(this.scope)) {
      // Skip internal variables
      if (key.startsWith('__tangent_')) continue;
      vars[key] = value;
    }
    return vars;
  }

  /**
   * Execute a code cell that is not treated as an ESM module.
   * If the code contains top-level import/export it will be
   * delegated to executeModule to avoid `import` syntax errors.
   */
  async executeCode(code: string): Promise<CellOutput> {
    // If code contains top-level import/export, route to module execution.
    if (/^\s*(import|export)\s+/m.test(code)) {
      return this.executeModule(code);
    }

    try {
      if (!code || !code.trim()) {
        return {
          type: "text",
          content: "No code to execute",
          timestamp: Date.now(),
        };
      }

      // Temporary DOM container to capture library-attached visualizations
      const outputDiv = document.createElement("div");
      outputDiv.style.position = "absolute";
      outputDiv.style.left = "-9999px";
      outputDiv.dataset.tangentOutput = "true";
      document.body.appendChild(outputDiv);
      (window as any).__tangent_currentOutputDiv = outputDiv;

      // Capture console output
      const originalLog = console.log;
      const originalError = console.error;
      const originalWarn = console.warn;

      let capturedOutput: string[] = [];
      let hasError = false;

      const captureLog = (...args: any[]) => {
        capturedOutput.push(args.map((a) => this.formatValue(a)).join(" "));
        originalLog(...args);
      };
      const captureError = (...args: any[]) => {
        capturedOutput.push(
          `ERROR: ${args.map((a) => this.formatValue(a)).join(" ")}`,
        );
        hasError = true;
        originalError(...args);
      };
      const captureWarn = (...args: any[]) => {
        capturedOutput.push(
          `WARN: ${args.map((a) => this.formatValue(a)).join(" ")}`,
        );
        originalWarn(...args);
      };

      console.log = captureLog;
      console.error = captureError;
      console.warn = captureWarn;

      try {
        const lines = code.split("\n");

        const stripLeadingComments = (input: string): string => {
          let prev = input;
          let curr = input;
          const leadingCommentRegex = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)/;
          do {
            prev = curr;
            curr = curr.replace(leadingCommentRegex, "");
          } while (curr !== prev);
          return curr.trimStart();
        };

        const stripTrailingComments = (input: string): string => {
          let prev = input;
          let curr = input;
          const trailingCommentRegex = /(?:\/\/[^\n]*$|\/\*[\s\S]*?\*\/\s*)$/m;
          do {
            prev = curr;
            curr = curr.replace(trailingCommentRegex, "");
          } while (curr !== prev);
          return curr.trimEnd();
        };

        const codeNoLeading = stripLeadingComments(code);
        const codeNormalized = stripTrailingComments(codeNoLeading);

        const isAsyncIIFE = /^\(\s*async\s*\(\)\s*=>/.test(codeNormalized) && /\)\s*\(\s*\)\s*;?$/.test(codeNormalized);

        // Detect if last line is a simple expression we should display
        const codeForCapture = this.stripTrailingLineComments(code);
        const captureLines = codeForCapture.split("\n");
        const rawLastLine = captureLines[captureLines.length - 1]?.trim() ??
          "";
        const lastNoSemi = rawLastLine.replace(/;+$/, "");
        const isLikelyExpression = lastNoSemi &&
          !/^(const|let|var|function|class|if|for|while|switch|return)\b/.test(
            lastNoSemi,
          ) &&
          !lastNoSemi.endsWith("{") &&
          !lastNoSemi.endsWith("}") &&
          // Skip genuine assignments (x = ...), but NOT arrow functions (=>) or
          // comparisons (==, ===, <=, >=, !=). A bare `=` here means the cell's
          // last line is an assignment statement, which we don't display.
          !/(^|[^=!<>])=(?![=>])/.test(lastNoSemi);

        let execBody = code;
        if (isLikelyExpression && !isAsyncIIFE) {
          const capture = this.extractLastExpression(codeForCapture);
          if (capture) {
            const { before, expression } = capture;
            const needsNewline = before.length > 0 && !before.endsWith("\n");
            const prefix = needsNewline ? `${before}\n` : before;
            execBody = prefix
              ? `${prefix}window.__tangent_last = (${expression});`
              : `window.__tangent_last = (${expression});`;
          }
        } else {
          execBody = code;
        }

        // Hoist top-level declarations into the shared scope and wrap execution
        // in `with(scope)` so prior-cell variables are readable as plain names.
        const transformedBody = this.transformForScope(execBody);
        const globalEval = window.eval as (s: string) => any;
        const wrapped = `(async () => { with(window.__tangent_scope) {\n${transformedBody}\n} })()`;
        const iifeResult = globalEval(wrapped);
        let returnedValue: any = undefined;
        if (iifeResult && typeof iifeResult.then === "function") {
          returnedValue = await iifeResult;
        }

        // Sync scope: fallback for destructuring declarations not handled by transformForScope
        this.syncScopeFromGlobals(code);

        // After execution, prefer DOM outputs that libraries appended to the outputDiv.
        // Use __tangent_last (set by last-expression capture) or the IIFE's return value.
        const lastVal = (window as any).__tangent_last !== undefined
          ? (window as any).__tangent_last
          : returnedValue;
        try {
          delete (window as any).__tangent_last;
        } catch {
          // ignore
        }

        if (lastVal instanceof Node) {
          return {
            type: "dom",
            content: lastVal as Element,
            timestamp: Date.now(),
          };
        }

        const tableFromSpecial = this.tryRenderTable(lastVal);
        if (tableFromSpecial) {
          return {
            type: "dom",
            content: tableFromSpecial,
            timestamp: Date.now(),
          };
        }

        if (outputDiv.children.length > 0) {
          let domNode: Element;
          if (outputDiv.children.length === 1) {
            domNode = outputDiv.children[0] as Element;
          } else {
            const wrapper = document.createElement("div");
            while (outputDiv.firstChild) {
              wrapper.appendChild(outputDiv.firstChild);
            }
            domNode = wrapper;
          }
          return {
            type: "dom",
            content: domNode,
            timestamp: Date.now(),
          };
        }

        if (lastVal !== undefined) {
          return {
            type: hasError ? "error" : "text",
            content: capturedOutput.concat([this.formatValue(lastVal)]).join(
              "\n",
            ),
            timestamp: Date.now(),
          };
        }

        return {
          type: hasError ? "error" : "text",
          content: capturedOutput.join("\n"),
          timestamp: Date.now(),
        };
      } finally {
        console.log = originalLog;
        console.error = originalError;
        console.warn = originalWarn;

        try {
          const cur = (window as any).__tangent_currentOutputDiv;
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        } catch {}
        try {
          if (outputDiv.parentNode) outputDiv.parentNode.removeChild(outputDiv);
        } catch {}
        try {
          delete (window as any).__tangent_currentOutputDiv;
        } catch {}
      }
    } catch (error: any) {
      return {
        type: "error",
        content: `Error: ${error?.message ?? String(error)}`,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Transform top-level declarations so they write into the shared scope,
   * making variables declared in one cell readable as plain names in the next.
   *
   * Rules (applied to lines at column 0 — top-level heuristic):
   *   const x = expr   →  window.__tangent_scope.x = expr
   *   let   x = expr   →  window.__tangent_scope.x = expr
   *   var   x = expr   →  window.__tangent_scope.x = expr
   *   function foo() {} → (unchanged) + appends: scope.foo = foo
   *
   * Destructuring declarations (const { a } = …) and class declarations are
   * left untransformed and stay private to the cell.
   */
  private transformForScope(code: string): string {
    // Replace `const/let/var name =` with a direct scope write.
    // Matches only at column 0 (no leading whitespace) to avoid
    // rewriting declarations inside function bodies or blocks.
    const transformed = code.replace(
      /^(const|let|var)\s+([\w$]+)(\s*=)/gm,
      'window.__tangent_scope.$2$3',
    );

    // Function declarations hoist to the IIFE scope; copy into shared scope
    // after they are defined so subsequent cells can call them by name.
    const funcNames: string[] = [];
    for (const m of code.matchAll(/^function\s+([\w$]+)\s*\(/gm)) {
      funcNames.push(m[1]);
    }
    if (funcNames.length === 0) return transformed;

    const syncs = funcNames
      .map(n => `if (typeof ${n} !== 'undefined') window.__tangent_scope.${n} = ${n};`)
      .join('\n');
    return `${transformed}\n${syncs}`;
  }

  /**
   * Try to sync simple top-level variable declarations from code into the scope.
   * This is a best-effort heuristic so notebook variables are trackable.
   *
   * `transformForScope` already writes plain `const x = …` declarations straight
   * into the shared scope, so by the time this runs `scope.x` holds the cell's
   * value. We must NOT then overwrite it with `window.x`: many ordinary variable
   * names (`data`, `width`, `height`, `name`, `location`, `top`, `length`, …)
   * also exist as built-in properties on `window`, and copying those back would
   * clobber the notebook's value with an unrelated global — e.g. `const data =
   * […]` would be replaced by the `data()` dataset accessor, breaking every
   * downstream cell and closure that reads `data`. Only pull from `window` for
   * names the transform did not already capture (e.g. destructuring patterns).
   */
  private syncScopeFromGlobals(code: string): void {
    const declRegex = /(?:^|\n)\s*(?:const|let|var)\s+([\w$]+)\s*=/g;
    let match: RegExpExecArray | null;
    while ((match = declRegex.exec(code)) !== null) {
      const name = match[1];
      if (Object.prototype.hasOwnProperty.call(this.scope, name)) continue;
      if (name in window) {
        this.scope[name] = (window as any)[name];
      }
    }
  }

  /**
   * Execute code as an ES module. Supports static imports and top-level await.
   */
  async executeModule(code: string): Promise<CellOutput> {
    try {
      (window as any).__tangent_loadedModules =
        (window as any).__tangent_loadedModules || {};

      const imports: Array<{
        spec: string;
        bindings: Array<{ local: string; imported?: string }>;
      }> = [];
      const importRegex =
        /import\s+(?:\*\s+as\s+([\w_$]+)|([\w_$]+)|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRegex.exec(code)) !== null) {
        const localAll = m[1];
        const localDefault = m[2];
        const localNamed = m[3];
        const spec = m[4];
        // `imported` undefined => namespace/default binding (whole module);
        // `imported` set => a named specifier that must resolve to mod[imported].
        const bindings: Array<{ local: string; imported?: string }> = [];
        if (localAll) bindings.push({ local: localAll });
        if (localDefault) bindings.push({ local: localDefault });
        if (localNamed) {
          localNamed.split(",").forEach((part) => {
            const asMatch = part.trim().match(/([\w_$]+)\s+as\s+([\w_$]+)/);
            if (asMatch) bindings.push({ local: asMatch[2], imported: asMatch[1] });
            else {
              const name = part.trim();
              if (name) bindings.push({ local: name, imported: name });
            }
          });
        }
        if (bindings.length > 0) imports.push({ spec, bindings });
      }

      for (const imp of imports) {
        const url = this.normalizeModuleUrl(imp.spec);
        const mod = await import(
          /* @vite-ignore */ /* webpackIgnore: true */ url
        );
        for (const b of imp.bindings) {
          // Named specifiers resolve to the individual export (mod[name]);
          // namespace/default bindings keep the module (or its default).
          // Falling back to mod.default[name] covers packages that only
          // surface members through their default export.
          const value =
            b.imported === undefined
              ? mod.default || mod
              : mod[b.imported] !== undefined
                ? mod[b.imported]
                : mod.default
                  ? mod.default[b.imported]
                  : undefined;
          (window as any)[b.local] = value;
          this.scope[b.local] = value;
        }
        (window as any).__tangent_loadedModules[imp.spec] = mod;
      }

      const codeWithoutImports = code
        .split("\n")
        .filter((line) => !line.trim().startsWith("import "))
        .join("\n")
        .trim();

      if (!codeWithoutImports) {
        const loadedModules = imports.map((i) => i.spec).join(", ");
        return {
          type: "text",
          content: loadedModules
            ? `Modules loaded: ${loadedModules}`
            : "No code",
          timestamp: Date.now(),
        };
      }

      const codeForCapture = this.stripTrailingLineComments(codeWithoutImports);
      const lines = codeForCapture.split("\n");
      const rawLast = lines[lines.length - 1]?.trim() ?? "";
      const lastNoSemi = rawLast.replace(/;+$/, "");
      const isLastExpr = lastNoSemi &&
        !/^(const|let|var|function|class|if|for|while|switch|return)\b/.test(
          lastNoSemi,
        ) &&
        !lastNoSemi.endsWith("{") &&
        !lastNoSemi.endsWith("}") &&
        !/^(?:globalThis|window)\s*(?:\.|\[).*=/.test(lastNoSemi);

      let funcBody: string;
      if (isLastExpr) {
        const capture = this.extractLastExpression(codeForCapture);
        if (capture) {
          const { before, expression } = capture;
          const needsNewline = before.length > 0 && !before.endsWith("\n");
          const prefix = needsNewline ? `${before}\n` : before;
          funcBody = prefix
            ? `${prefix}window.__tangent_last = (${expression});`
            : `window.__tangent_last = (${expression});`;
        } else {
          funcBody = codeWithoutImports;
        }
      } else {
        funcBody = codeWithoutImports;
      }

      const transformedBody = this.transformForScope(funcBody);
      const asyncIIFE = `(async () => { with(window.__tangent_scope) {\n${transformedBody}\n} })()`;
      const globalEval = window.eval as (s: string) => any;
      const returnedValue = await globalEval(asyncIIFE);

      // Sync scope: fallback for destructuring declarations
      this.syncScopeFromGlobals(codeWithoutImports);

      // Use __tangent_last (last-expression capture) or the IIFE's return value
      const last = (window as any).__tangent_last !== undefined
        ? (window as any).__tangent_last
        : returnedValue;
      try {
        delete (window as any).__tangent_last;
      } catch {}

      if (last instanceof Node) {
        return {
          type: "dom",
          content: last as Element,
          timestamp: Date.now(),
        } as any;
      }

      const tableFromSpecial = this.tryRenderTable(last);
      if (tableFromSpecial) {
        return {
          type: "dom",
          content: tableFromSpecial,
          timestamp: Date.now(),
        };
      }

      return {
        type: "text",
        content: last !== undefined ? this.formatValue(last) : "Executed",
        timestamp: Date.now(),
      };
    } catch (err: any) {
      return {
        type: "error",
        content: `Module execution error: ${err?.message ?? String(err)}`,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Remove a trailing `// comment` from the final line of the code and drop
   * trailing lines that are blank or pure comments, so the last-expression
   * capture never treats comment text as "the expression" (e.g. a cell ending
   * in `f(x); // result: [5, -3.75]`).
   */
  private stripTrailingLineComments(code: string): string {
    const lines = code.split("\n");
    while (lines.length > 0) {
      const line = lines[lines.length - 1];
      const stripped = this.stripLineComment(line);
      if (stripped.trim()) {
        lines[lines.length - 1] = stripped.trimEnd();
        break;
      }
      lines.pop();
    }
    return lines.join("\n");
  }

  /**
   * Truncate `line` at the first `//` that is not inside a string literal.
   * Lines containing backticks are returned untouched: they may sit inside a
   * multi-line template literal, where truncation would corrupt the code.
   */
  private stripLineComment(line: string): string {
    if (line.includes("`")) return line;
    let inString: string | null = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inString = ch;
        continue;
      }
      if (ch === "/" && line.charAt(i + 1) === "/") return line.slice(0, i);
    }
    return line;
  }

  private extractLastExpression(code: string): {
    before: string;
    expression: string;
  } | null {
    if (!code) return null;

    let end = code.length;
    while (end > 0 && /\s/.test(code.charAt(end - 1))) {
      end--;
    }

    while (end > 0 && code.charAt(end - 1) === ";") {
      end--;
      while (end > 0 && /\s/.test(code.charAt(end - 1))) {
        end--;
      }
    }

    if (end <= 0) return null;

    const relevant = code.slice(0, end);
    let depth = 0;
    let inString: string | null = null;
    let escaped = false;

    for (let i = end - 1; i >= 0; i--) {
      const ch = relevant.charAt(i);

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === "'" || ch === '"') {
        inString = ch;
        continue;
      }

      if (ch === "`") {
        return null;
      }

      if (ch === ")" || ch === "]" || ch === "}") {
        depth++;
        continue;
      }

      if ((ch === "(" || ch === "[" || ch === "{") && depth > 0) {
        depth--;
        continue;
      }

      if (depth === 0 && (ch === ";" || ch === "\n" || ch === "\r")) {
        const start = i + 1;
        const expression = relevant.slice(start);
        if (!expression.trim()) return null;
        const before = relevant.slice(0, start);
        return { before, expression };
      }
    }

    const expression = relevant;
    if (!expression.trim()) return null;
    return { before: "", expression };
  }

  private formatValue(value: any): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "function") return value.toString();
    if (typeof value === "object") {
      try {
        if (Array.isArray(value) && value.length > 200) {
          return `Array(${value.length}) [${
            value
              .slice(0, 10)
              .map((v: any) => this.formatValue(v))
              .join(", ")
          } ...]`;
        }
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  async loadModule(moduleUrl: string): Promise<any> {
    try {
      const normalized = this.normalizeModuleUrl(moduleUrl);
      return await import(
        /* @vite-ignore */ /* webpackIgnore: true */ normalized
      );
    } catch (err: any) {
      throw new Error(
        `Failed to load module ${moduleUrl}: ${err?.message ?? String(err)}`,
      );
    }
  }

  private normalizeModuleUrl(moduleUrl: string): string {
    if (/^https?:\/\//.test(moduleUrl)) return moduleUrl;
    return `https://cdn.jsdelivr.net/npm/${moduleUrl}/+esm`;
  }

  private tryRenderTable(value: any): Element | null {
    if (!value || typeof value !== "object") return null;

    const looksLikeTable = typeof (value as any).objects === "function" &&
      typeof (value as any).columnNames === "function" &&
      typeof (value as any).numRows === "function";
    if (!looksLikeTable) return null;

    let rows: any[] | null = null;
    try {
      if (typeof value.objects === "function") {
        const result = value.objects();
        if (Array.isArray(result)) {
          rows = result;
        } else if (result && typeof result[Symbol.iterator] === "function") {
          rows = Array.from(result);
        }
      }
    } catch {
      rows = null;
    }

    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (rows.length > 1000) rows = rows.slice(0, 1000);

    let keys: string[] = [];
    try {
      const cols = value.columnNames();
      if (Array.isArray(cols)) keys = cols.slice(0, 100);
    } catch {
      keys = [];
    }

    if (!keys.length) {
      const set = new Set<string>();
      rows.forEach((row) => {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          Object.keys(row).forEach((k) => set.add(k));
        }
      });
      keys = Array.from(set);
    }

    if (keys.length === 0 || keys.length > 100) return null;

    rows = rows.map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        return row;
      }
      const obj: Record<string, any> = {};
      keys.forEach((key, idx) => {
        if (Array.isArray(row)) obj[key] = row[idx];
        else obj[key] = undefined;
      });
      return obj;
    });

    const table = document.createElement("table");
    table.className = "tangent-table-output";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    keys.forEach((key) => {
      const th = document.createElement("th");
      th.textContent = key;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.slice(0, 500).forEach((row) => {
      const tr = document.createElement("tr");
      keys.forEach((key) => {
        const td = document.createElement("td");
        const value = (row as any)[key];
        td.textContent =
          value === null || value === undefined ? "" : String(value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /**
   * setupCommonLibraries
   * Preloads d3 and Plot so cells can use them without imports.
   */
  async setupCommonLibraries(): Promise<void> {
    try {
      if ((window as any).__tangent_commonLibsLoaded) return;

      const [d3mod, plotmod] = await Promise.all([
        this.loadModule("d3"),
        this.loadModule("@observablehq/plot"),
      ]);

      (window as any).d3 = d3mod && (d3mod.default || d3mod);
      (window as any).Plot = plotmod && (plotmod.default || plotmod);

      // Also track in scope
      this.scope.d3 = (window as any).d3;
      this.scope.Plot = (window as any).Plot;

      (window as any).__tangent_commonLibsLoaded = true;
    } catch (err) {
      try {
        console.warn(
          "setupCommonLibraries: failed to preload common libs",
          err,
        );
      } catch {}
    }
  }

  async executeCodeWithModules(
    code: string,
    modules: string[] = [],
  ): Promise<CellOutput> {
    try {
      await Promise.all(
        modules.map(async (m) => {
          const mod = await this.loadModule(m);
          const name = this.getModuleName(m);
          (window as any)[name] = mod.default || mod;
          this.scope[name] = mod.default || mod;
        }),
      );
      return await this.executeCode(code);
    } catch (err: any) {
      return {
        type: "error",
        content: `Module loading error: ${err?.message ?? String(err)}`,
        timestamp: Date.now(),
      };
    }
  }

  private getModuleName(moduleUrl: string): string {
    if (moduleUrl.includes("d3")) return "d3";
    if (moduleUrl.includes("plot")) return "Plot";
    if (moduleUrl.includes("lodash")) return "_";
    if (moduleUrl.includes("three")) return "THREE";
    if (moduleUrl.includes("p5")) return "p5";
    const parts = moduleUrl.split("/");
    const last = parts[parts.length - 1];
    return last.replace(/[@\-\.]/g, "_");
  }
}
