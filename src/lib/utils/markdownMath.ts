/**
 * Find the TeX in a text cell, and leave the dollars that are money alone.
 *
 * A bare `$…$` rule turned any line with two dollar signs into an equation:
 * "10 $ et 20 $" rendered as math, and the braces typed in between vanished,
 * because in TeX they only group. The rule here is Pandoc's: an opening `$`
 * has a non-space right after it, a closing `$` has a non-space right before
 * it and no digit right after it. `\$` is always a literal dollar, and code
 * (fenced blocks and backtick spans) is never read as math.
 */

export type MathRenderer = (tex: string, display: boolean) => string;

// Fenced blocks (an unterminated fence runs to the end) and inline code spans.
const CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))|(`+)[^`\n]?[\s\S]*?\2(?!`)/gm;
const DISPLAY = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g;
const INLINE = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)/g;

export function renderMath(markdown: string, render: MathRenderer): string {
  const code: string[] = [];
  const hold = (m: string) => `\u0000${code.push(m) - 1}\u0000`;
  return markdown
    .replace(CODE, hold)
    .replace(DISPLAY, (_, tex) => render(tex, true))
    .replace(INLINE, (_, tex) => render(tex, false))
    .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}
