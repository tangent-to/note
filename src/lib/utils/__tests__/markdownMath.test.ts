/**
 * Which dollars in a text cell are TeX. Money, escaped dollars and code must
 * come through untouched, or the text around them disappears into an equation.
 */
import { describe, it, expect } from 'vitest';
import { renderMath } from '../markdownMath';

const mark = (md: string) => renderMath(md, (tex, display) => (display ? `[D:${tex}]` : `[I:${tex}]`));

describe('renderMath', () => {
  it('renders inline and display math', () => {
    expect(mark('soit $x^2$ ici')).toBe('soit [I:x^2] ici');
    expect(mark('$$\n\\frac{a}{b}\n$$')).toBe('[D:\n\\frac{a}{b}\n]');
    expect(mark('$a$ et $b$')).toBe('[I:a] et [I:b]');
  });

  it('leaves amounts of money alone', () => {
    expect(mark('10 $ et 20 $')).toBe('10 $ et 20 $');
    expect(mark('coûte $5 ou $10')).toBe('coûte $5 ou $10');
    // Reads as TeX by the rule; escaping one dollar is the way out.
    expect(mark('entre \\$5 et 10$ {a} b')).toBe('entre \\$5 et 10$ {a} b');
  });

  it('keeps braces outside math', () => {
    expect(mark('un objet {a: 1} à 5 $')).toBe('un objet {a: 1} à 5 $');
  });

  it('treats \\$ as a literal dollar', () => {
    expect(mark('\\$x\\$')).toBe('\\$x\\$');
    expect(mark('$a \\$ b$')).toBe('[I:a \\$ b]');
  });

  it('never reads code as math', () => {
    expect(mark('`$x$` et $y$')).toBe('`$x$` et [I:y]');
    expect(mark('```js\nconst a = `${b}$`;\n```\n$c$')).toBe('```js\nconst a = `${b}$`;\n```\n[I:c]');
    expect(mark('```\n$x$')).toBe('```\n$x$');
  });
});
