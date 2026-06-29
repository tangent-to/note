// User-editable reference text appended to the chat assistant's system prompt.
//
// It defaults to a curated cheatsheet for the Tangent notebook runtime plus the
// libraries it ships (Observable Plot, Arquero) and the tangent/ds design
// language. The user can edit it in AI settings; edits persist to localStorage.
// Keep the default tight: it is prepended to every chat request, so it costs
// context-window tokens on each call.

const STORAGE_KEY = 'tangent-ai-context';

export const DEFAULT_AI_CONTEXT = `# Tangent reference (Observable Plot, Arquero, tangent/ds)

Render: end a cell with a bare expression, or return a DOM node, to display it.
Preloaded globals: d3, Plot. Import anything else as browser ESM, e.g.
import * as aq from "arquero";  // bare specifier, resolved from a CDN

## Observable Plot (global Plot)
Plot.plot(options) returns an element; end the cell with it to render.
- Histogram: Plot.plot({ marks: [Plot.rectY(data, Plot.binX({ y: "count" }, { x: "value" }))] })
- Line:      Plot.plot({ marks: [Plot.line(data, { x: "date", y: "value" })] })
- Scatter:   Plot.plot({ marks: [Plot.dot(data, { x: "a", y: "b" })] })
- Bar:       Plot.plot({ marks: [Plot.barY(data, { x: "name", y: "count" })] })
- Options: width, height, y: { grid: true }, color: { legend: true }.

## Arquero (import * as aq from "arquero")
aq.from(rows) builds a table; chain verbs; read out with .objects().
- aq.from(data).filter(d => d.value > 0).derive({ z: d => d.x + d.y })
- .groupby("category").rollup({ n: aq.op.count(), mean: d => aq.op.mean(d.value) }).orderby(aq.desc("n"))
- End a cell with .objects() to render the rows as a table.

## tangent/ds (design language)
Restrained editorial-technical: one teal accent on warm stone, serif for prose,
sans for UI, mono for code. Borders over shadows, one accent only, no em-dashes
in visible text. When generating UI, reuse the app CSS variables: --accent,
--surface, --text, --border, --font-serif, --font-mono.`;

export function loadAIContext(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // An empty string is a valid (user-cleared) value, so only fall back to the
    // default when nothing has ever been saved.
    if (saved !== null) return saved;
  } catch (error) {
    console.warn('Failed to load AI context:', error);
  }
  return DEFAULT_AI_CONTEXT;
}

export function saveAIContext(text: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch (error) {
    console.warn('Failed to save AI context:', error);
  }
}

export function resetAIContext(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to reset AI context:', error);
  }
}
