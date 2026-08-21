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
 */

import type { CellOutput } from "../types/notebook";
import { getDataset, listDatasetNames } from "./dataStore";
import { tableSpec, type TableSpec } from "./tableData";
import {
  hasSyntaxErrors,
  topLevelDeclarations,
  topLevelDefinitions,
  topLevelNamesToCopy,
} from "./jsSyntax";

/**
 * Split a code cell into its final expression (for last-value display) and the
 * statements before it. Pure string logic, exported for unit testing. Scans
 * backward, respecting bracket depth and string literals, to find the start of
 * the trailing expression.
 *
 * Method-chain continuation is honoured: a newline before a leading `.` (a
 * fluent chain broken across lines, e.g. `foo(...)\n  .bar()`) is NOT a
 * statement boundary, so the whole chain is captured rather than the dangling
 * `.bar()` (which would parse as "expected expression, got '.'"). An explicit
 * `;` always ends the statement.
 *
 * Returns null when there is no displayable trailing expression, or when the
 * expression would begin inside a template literal (`\``), which this scanner
 * does not split.
 */
/**
 * Forward scan: find every top-level token of interest — a statement boundary
 * (`;` or newline) or an assignment `=` — that is NOT inside a string, comment,
 * template literal, or bracket group. Returns the character indices, in order.
 *
 * A frame stack handles template-literal interpolation correctly: inside a
 * `` `...` `` a `${` opens a nested CODE frame (with its own bracket depth), and
 * the matching `}` returns to the template. This is what lets a last expression
 * contain a `title: \`... ${x} ...\`` template literal — the old scanner bailed
 * on any backtick and the cell silently never displayed.
 */
function scanTopLevel(code: string): { index: number; char: string }[] {
  const tokens: { index: number; char: string }[] = [];
  // Each frame is a CODE context with its own bracket depth, or a string/template
  // context. The outermost frame is code; interpolation pushes another code frame.
  type Frame = { type: "code"; depth: number } | { type: "sq" | "dq" | "tpl" };
  const stack: Frame[] = [{ type: "code", depth: 0 }];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = code[i];
    const c2 = code[i + 1];

    if (top.type === "sq" || top.type === "dq") {
      if (c === "\\") { i += 2; continue; }
      if ((top.type === "sq" && c === "'") || (top.type === "dq" && c === '"')) stack.pop();
      i++;
      continue;
    }

    if (top.type === "tpl") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i++; continue; }
      if (c === "$" && c2 === "{") { stack.push({ type: "code", depth: 0 }); i += 2; continue; }
      i++;
      continue;
    }

    // code frame (the only remaining variant here; narrow for TypeScript)
    const codeTop = top as { type: "code"; depth: number };
    if (c === "/" && c2 === "/") {           // line comment: skip to (not incl.) newline
      let j = i + 2;
      while (j < n && code[j] !== "\n") j++;
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {            // block comment
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      i = Math.min(n, j + 2);
      continue;
    }
    if (c === "'") { stack.push({ type: "sq" }); i++; continue; }
    if (c === '"') { stack.push({ type: "dq" }); i++; continue; }
    if (c === "`") { stack.push({ type: "tpl" }); i++; continue; }
    if (c === "(" || c === "[" || c === "{") { codeTop.depth++; i++; continue; }
    if (c === ")" || c === "]") { codeTop.depth = Math.max(0, codeTop.depth - 1); i++; continue; }
    if (c === "}") {
      if (codeTop.depth === 0 && stack.length > 1) {
        stack.pop();                          // closes a `${...}` interpolation
      } else {
        codeTop.depth = Math.max(0, codeTop.depth - 1);
      }
      i++;
      continue;
    }
    if (c === "=") {
      // Distinguish a real assignment from `==`/`===`/`=>`/`!=`/`<=`/`>=`.
      if (c2 === "=" || c2 === ">") { i += 2; continue; }
      const prev = i > 0 ? code[i - 1] : "";
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">") { i++; continue; }
      // Compound assignments (`+=`, `||=`, …) count as assignments, like `=`.
      if (stack.length === 1 && codeTop.depth === 0) tokens.push({ index: i, char: "=" });
      i++;
      continue;
    }
    if ((c === ";" || c === "\n" || c === "\r") && stack.length === 1 && codeTop.depth === 0) {
      tokens.push({ index: i, char: c });
    }
    i++;
  }
  return tokens;
}

/** Statement boundaries only (`;`/newline), for splitting off the last statement. */
function topLevelBoundaries(code: string): { index: number; char: string }[] {
  return scanTopLevel(code).filter((t) => t.char !== "=");
}

/** True when `code` performs an assignment at its own top level (not nested). */
function hasTopLevelAssignment(code: string): boolean {
  return scanTopLevel(code).some((t) => t.char === "=");
}

/**
 * Keywords that begin a *statement*, not an expression. Wrapping any of these in
 * `(...)` for last-value display is a syntax error (`const`, `if`, `return`, …) or
 * silently drops a binding (`function foo(){}`, `class A{}`), so such a trailing
 * statement must be executed as written instead.
 */
const STATEMENT_START =
  /^(?:const|let|var|function|class|if|else|for|while|do|switch|case|default|try|catch|finally|return|throw|break|continue|import(?!\s*\()|export|debugger|with|yield|async\s+function)\b/;

/**
 * Decide whether a candidate trailing statement can be wrapped as
 * `window.__tangent_last = (<candidate>)` for last-value display.
 *
 * This deliberately inspects the WHOLE candidate statement rather than the cell's
 * final physical line: a multi-line declaration ends in `];` or `);`, which reads
 * as an expression line-wise, and wrapping it produced
 * "expected expression, got keyword 'const'". Declarations are complete
 * statements on their own — they run unwrapped and simply display nothing.
 *
 * Assignments are checked at the candidate's top level only, so a nested `=`
 * (a default parameter, or a `const` inside an arrow-function body) does not
 * suppress display of an otherwise ordinary expression.
 */
export function isDisplayableExpression(candidate: string): boolean {
  const text = candidate.replace(/[\s;]+$/, "").trim();
  if (!text) return false;
  if (STATEMENT_START.test(text)) return false;
  // An unterminated block, or a statement ending in one (`if (…) { … }`).
  if (text.endsWith("{") || text.endsWith("}")) return false;
  // `x = 1` / `window.foo = bar` are statements we run but don't display.
  if (hasTopLevelAssignment(text)) return false;
  return true;
}

export function extractLastExpression(code: string): {
  before: string;
  expression: string;
} | null {
  if (!code) return null;

  // Trim trailing whitespace and semicolons to locate the end of the last expression.
  let end = code.length;
  while (end > 0 && /\s/.test(code.charAt(end - 1))) end--;
  while (end > 0 && code.charAt(end - 1) === ";") {
    end--;
    while (end > 0 && /\s/.test(code.charAt(end - 1))) end--;
  }
  if (end <= 0) return null;

  const boundaries = topLevelBoundaries(code).filter((b) => b.index < end);

  // Walk boundaries from the last toward the first; the statement start is just
  // after the chosen boundary. A NEWLINE boundary immediately before a leading
  // `.` is a method-chain continuation, not a statement break, so skip it and
  // take an earlier boundary (an explicit `;` always breaks).
  for (let k = boundaries.length - 1; k >= 0; k--) {
    const b = boundaries[k];
    const expression = code.slice(b.index + 1, end);
    if (!expression.trim()) continue;
    if (b.char !== ";" && /^\s*\./.test(expression)) continue;
    return { before: code.slice(0, b.index + 1), expression };
  }

  const expression = code.slice(0, end);
  if (!expression.trim()) return null;
  return { before: "", expression };
}

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

        // Split off the cell's last statement and display it only if it is an
        // expression. A trailing declaration (`const x = […]`) is left alone: it
        // is a complete statement, and wrapping it for display was a syntax error.
        const codeForCapture = this.stripTrailingLineComments(code);

        let execBody = code;
        if (!isAsyncIIFE) {
          const capture = this.extractLastExpression(codeForCapture);
          if (capture && isDisplayableExpression(capture.expression)) {
            const { before, expression } = capture;
            const needsNewline = before.length > 0 && !before.endsWith("\n");
            const prefix = needsNewline ? `${before}\n` : before;
            execBody = prefix
              ? `${prefix}window.__tangent_last = (${expression});`
              : `window.__tangent_last = (${expression});`;
          }
        }

        // Hoist top-level declarations into the shared scope and wrap execution
        // in `with(scope)` so prior-cell variables are readable as plain names.
        const globalEval = window.eval as (s: string) => any;
        const wrapped = this.wrapForExecution(execBody, code);
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

        // Worker-kernel ui.* controls return a declarative spec instead of a
        // DOM node; surface it as a `widget` output for main-thread rendering.
        if (lastVal && lastVal.__tangentWidget) {
          return {
            type: "widget",
            content: JSON.stringify(lastVal),
            timestamp: Date.now(),
          };
        }

        if (lastVal instanceof Node) {
          return {
            type: "dom",
            content: lastVal as Element,
            timestamp: Date.now(),
          };
        }

        const table = this.tryTableSpec(lastVal);
        if (table) {
          return {
            type: "table",
            content: JSON.stringify(table),
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
   * Build the `with(scope)`-wrapped async IIFE that is handed to eval.
   *
   * `body` is the (possibly last-expression-rewritten) code; `original` is the
   * cell exactly as written. If the rewritten body does not parse but the
   * original does, we execute the original: display of the last value is a
   * convenience, and losing it is always better than failing the whole cell on a
   * heuristic misfire.
   */
  private wrapForExecution(body: string, original: string): string {
    const wrap = (b: string) =>
      `(async () => { with(window.__tangent_scope) {\n${this.transformForScope(b)}\n} })()`;
    const candidate = wrap(body);
    if (body === original || this.compiles(candidate)) return candidate;
    const fallback = wrap(original);
    return this.compiles(fallback) ? fallback : candidate;
  }

  /** Parse `src` without running it; false when it is a syntax error. */
  private compiles(src: string): boolean {
    try {
      // `new Function` compiles the source but does not execute it.
      new Function(src);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Transform top-level declarations so they write into the shared scope,
   * making variables declared in one cell readable as plain names in the next.
   *
   *   const x = expr    →  window.__tangent_scope.x = expr
   *   let   x           →  window.__tangent_scope.x = undefined
   *   const a = 1, b = 2 → …scope.a = 1, …scope.b = 2   (every declarator)
   *   function foo() {} →  (unchanged) + appends: scope.foo = foo
   *   const {a, b} = o  →  (unchanged) + appends: scope.a = a, scope.b = b
   *   class Foo {}      →  (unchanged) + appends: scope.Foo = Foo
   *
   * A pattern cannot become an assignment target in place, and a `function` or
   * `class` declaration must stay one, so those three keep their declaration
   * and get copied out afterwards instead (topLevelNamesToCopy). The copy runs
   * at the end of the cell body, where every top-level name is bound — so it
   * needs no `typeof` guard, and a destructured name whose value is genuinely
   * `undefined` still reaches the next cell as undefined rather than as a
   * "not defined" ReferenceError.
   *
   * Declarations are located by parsing the cell (see jsSyntax), not by matching
   * line starts, which is what the dependency analysis reports too — so what a
   * cell is said to define and what it actually shares cannot drift apart. It
   * also means an indented top-level declaration is shared like any other, and
   * that a `const …` sitting at column 0 *inside a template literal* is left
   * alone instead of being rewritten into the string.
   *
   * Left untransformed, and so private to the cell: `export` wrappers, and
   * anything in a cell that does not parse.
   */
  private transformForScope(code: string): string {
    // A cell with a syntax error can't be analysed meaningfully; run it as
    // written and let the engine report the error.
    if (hasSyntaxErrors(code)) return code;

    // Collect edits first, then apply them back-to-front so earlier offsets
    // stay valid.
    const edits: { from: number; to: number; text: string }[] = [];
    for (const decl of topLevelDeclarations(code)) {
      if (!decl.declarators || decl.exported) continue;
      const writes = decl.declarators.map((d) =>
        d.init
          ? `window.__tangent_scope.${d.name} = ${code.slice(d.init.from, d.init.to)}`
          : `window.__tangent_scope.${d.name} = undefined`
      );
      edits.push({ from: decl.from, to: decl.to, text: writes.join(', ') });
    }

    let transformed = code;
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      transformed =
        transformed.slice(0, edit.from) + edit.text + transformed.slice(edit.to);
    }

    // Whatever the rewrite left as a declaration binds in the IIFE scope only;
    // copy those names into the shared scope so subsequent cells can use them.
    const copied = topLevelNamesToCopy(code);
    if (copied.length === 0) return transformed;

    const syncs = copied
      .map(n => `window.__tangent_scope.${n} = ${n};`)
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
   * names the transform did not already capture — `globalThis.x = …`
   * assignments, `ui.slider("x", …)` bindings, and `export` declarations.
   */
  private syncScopeFromGlobals(code: string): void {
    for (const name of topLevelDefinitions(code)) {
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

      // The imports are independent, so fetch them in parallel; the binding /
      // scope assignments below still run in the original order.
      const mods = await Promise.all(
        imports.map((imp) =>
          import(
            /* @vite-ignore */ /* webpackIgnore: true */ this.normalizeModuleUrl(
              imp.spec,
            )
          ),
        ),
      );

      for (let i = 0; i < imports.length; i++) {
        const imp = imports[i];
        const mod = mods[i];
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

      let funcBody = codeWithoutImports;
      const capture = this.extractLastExpression(codeForCapture);
      if (capture && isDisplayableExpression(capture.expression)) {
        const { before, expression } = capture;
        const needsNewline = before.length > 0 && !before.endsWith("\n");
        const prefix = needsNewline ? `${before}\n` : before;
        funcBody = prefix
          ? `${prefix}window.__tangent_last = (${expression});`
          : `window.__tangent_last = (${expression});`;
      }

      const asyncIIFE = this.wrapForExecution(funcBody, codeWithoutImports);
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

      if (last && last.__tangentWidget) {
        return {
          type: "widget",
          content: JSON.stringify(last),
          timestamp: Date.now(),
        };
      }

      if (last instanceof Node) {
        return {
          type: "dom",
          content: last as Element,
          timestamp: Date.now(),
        } as any;
      }

      const table = this.tryTableSpec(last);
      if (table) {
        return {
          type: "table",
          content: JSON.stringify(table),
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
    return extractLastExpression(code);
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

  private tryTableSpec(value: any): TableSpec | null {
    return tableSpec(value);
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

}
