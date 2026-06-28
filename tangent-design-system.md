# Tangent Design System

Paste this file (or the relevant section) into any chat or agent when building a Tangent
surface: the website, the `tangent/ds` docs, or the notebook app. It is the single source
of truth for how Tangent looks.

**One-line brief:** Tangent is a scientific-computing studio. The language is *restrained
editorial-technical*: calm, high-contrast, one teal accent on warm stone, serif for prose,
sans for UI, mono for code. Simplistic on purpose. Not flashy.

---

## 0. Hard rules (read first, these override taste)

1. **One accent only.** Teal. Never add a second accent color anywhere on a page.
2. **No em-dashes or en-dashes** (`—` `–`) in any visible text. Use a period, comma,
   parentheses, colon, or a plain hyphen `-`. (This is the #1 "AI-generated" tell.)
3. **Eyebrows are rationed.** The small uppercase/mono label above a heading: at most one
   per three sections on a page. Usually the heading alone is enough.
4. **No decorative dots, version stamps, scroll cues, or locale/time strips.** Dots only for
   real state (e.g. a live status indicator).
5. **Serif is for prose only** (body, article text, the occasional display headline).
   All UI chrome, navigation, buttons, labels: sans. This editorial serif is a deliberate
   preserved brand token (academic/publication heritage), not decoration.
6. **One radius scale, one theme per page.** See below. Dark mode is first-class, never an
   afterthought; design both.
7. **Every button's text must pass contrast** against its own background (WCAG AA).

---

## 1. Color tokens

```css
/* Accent: tangent teal */
--tangent-50:  #effdf9;
--tangent-100: #cdf9ec;
--tangent-300: #5fe3c4;
--tangent-400: #28c9a8;  /* accent on DARK surfaces */
--tangent-500: #0fae8f;
--tangent-600: #048b74;  /* primary action on LIGHT surfaces */
--tangent-700: #076e5e;  /* links on LIGHT surfaces */
--tangent-800: #0a574c;
--tangent-900: #0c483f;

/* Neutral: warm stone (Tailwind `stone`) */
--bg-light:    #fafaf9;  /* stone-50  */
--bg-dark:     #0c0a09;  /* stone-950 */
--text-light:  #44403c;  /* stone-700, body on light */
--text-dark:   #d6d3d1;  /* stone-300, body on dark  */
--heading-light:#1c1917; /* stone-900 */
--heading-dark: #ffffff;
--border-light:#e7e5e4;  /* stone-200 */
--border-dark: #292524;  /* stone-800 */
```

Usage map:
- **Page** stone-50 (light) / stone-950 (dark).
- **Headings** stone-900 / white. **Body** stone-700 / stone-300. (Do not use the old
  washed-out `black/50`.)
- **Links** teal-700 / teal-400, underline with the same color at ~30% opacity.
- **Primary button** bg teal-600 / hover teal-700, text white (same in dark mode).
- **Soft accent fills** (badges, highlights) teal-50/100 light, teal-900/40 dark.
- **Borders/dividers** stone-200 / stone-800.

If using Tailwind, register teal under the name `tangent` (config in §6).

---

## 2. Typography

- **Sans (UI, nav, buttons, labels):** Inter. `font-sans`.
- **Serif (prose, article body, display headlines):** Lora. `font-serif`.
- **Mono (code, `tangent/` labels, small technical captions):** system mono stack
  `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. `font-mono`.

Scale (fluid, desktop):
| Role | Classes |
|---|---|
| Hero / display | `font-serif text-4xl sm:text-5xl leading-[1.1] text-stone-900 dark:text-white` |
| Section heading (h2) | `font-sans text-3xl font-bold text-stone-900 dark:text-white` |
| Card title (h3) | `font-sans text-xl font-semibold text-stone-900 dark:text-white` |
| Body | `text-stone-600 dark:text-stone-400 leading-relaxed` |
| Prose body (articles) | `font-serif text-[15px] leading-relaxed` |
| Small / caption | `text-sm text-stone-500` |
| Eyebrow (rationed!) | `font-mono text-xs uppercase tracking-[0.18em] text-tangent-600 dark:text-tangent-400` |
| `tangent/` label | `font-mono` with the slug teal: `<span class="text-tangent-600 dark:text-tangent-400">tangent/</span>ds` |

Emphasis inside a headline: use **italic or bold of the same font**, never a second font.

---

## 3. Shape, spacing, motion

- **Radius:** soft scale. Cards/buttons-as-pills: `rounded-xl` (12px) for cards, `rounded-full`
  for buttons and badges, `rounded-lg` for inputs. Pick this and do not mix in sharp corners.
- **Container:** `mx-auto max-w-5xl px-5` (site). Docs/app may go wider but keep the gutter.
- **Section rhythm:** `py-16` default (density 3, calm). Hero `py-20 sm:py-24`, top padding
  never exceeds `pt-24`.
- **Borders over shadows.** Group with `border` + `divide`/`border-t`, not drop shadows.
  If a shadow is needed, keep it small and tinted (`shadow-sm`), never pure-black glow.
- **Motion (intensity ~4, calm):** `transition-colors`/`transition-all duration-300` on hover;
  a gentle fade-up on first paint is fine. No infinite loops, no parallax, no scroll-hijack.
  Honor `prefers-reduced-motion`.

---

## 4. The mark

A curve with a line *tangent* to it (the name, made literal). `currentColor` so it inherits
teal. Use at 24-32px beside the `tangent` wordmark (Inter semibold).

```html
<svg width="26" height="26" viewBox="0 0 32 32" fill="none" class="text-tangent-600 dark:text-tangent-400">
  <path d="M3 25C9 25 12 5 29 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="6" y1="27" x2="26" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
  <circle cx="15.5" cy="17.6" r="2.6" fill="currentColor"/>
</svg>
```

---

## 5. Component recipes (copy-paste Tailwind)

**Primary button**
```html
<a class="inline-flex items-center gap-2 rounded-full bg-tangent-600 hover:bg-tangent-700 text-white px-5 py-2.5 font-sans text-sm font-medium transition-colors">Label</a>
```
**Secondary button**
```html
<a class="inline-flex items-center gap-2 rounded-full border border-stone-300 dark:border-stone-700 hover:border-tangent-500 dark:hover:border-tangent-400 px-5 py-2.5 font-sans text-sm font-medium text-stone-800 dark:text-stone-200 transition-colors">Label</a>
```
**Link**
```html
<a class="text-tangent-700 dark:text-tangent-400 underline underline-offset-2 decoration-tangent-700/30 hover:decoration-tangent-700 transition-colors">Label</a>
```
**Tech tag**
```html
<span class="text-[11px] px-2 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 font-sans">PyTorch</span>
```
**Category badge (solid)** and **status pill (soft)**
```html
<span class="text-[11px] px-2 py-0.5 rounded-full bg-stone-900 text-white dark:bg-white dark:text-stone-900 font-sans font-medium">Government</span>
<span class="text-[11px] px-2 py-0.5 rounded-full bg-tangent-100 dark:bg-tangent-900/40 text-tangent-700 dark:text-tangent-300 font-sans">Open source</span>
```
**Card** (tool / project / writing share this shell)
```html
<article class="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 hover:border-tangent-400 dark:hover:border-tangent-500 transition-colors">
  <h3 class="font-sans text-xl font-semibold text-stone-900 dark:text-white">Title</h3>
  <p class="mt-2.5 text-[15px] leading-relaxed text-stone-600 dark:text-stone-400">Body.</p>
</article>
```
**Page scaffold**
```html
<body class="font-serif bg-stone-50 text-stone-700 dark:bg-stone-950 dark:text-stone-300 antialiased">
```

---

## 6. Tailwind config (drop-in)

```js
theme: { extend: {
  fontFamily: {
    sans: ["Inter", ...defaultTheme.fontFamily.sans],
    serif: ["Lora", ...defaultTheme.fontFamily.serif],
    mono: ["ui-monospace","SFMono-Regular","Menlo","Consolas", ...defaultTheme.fontFamily.mono],
  },
  colors: { tangent: {
    50:"#effdf9",100:"#cdf9ec",300:"#5fe3c4",400:"#28c9a8",500:"#0fae8f",
    600:"#048b74",700:"#076e5e",800:"#0a574c",900:"#0c483f",
  } },
} }
```

---

## 7. Voice

Plain, precise, confident. State what something does. No filler verbs ("elevate",
"seamless", "unleash"), no hype, no fake-precise numbers. The author is a senior expert;
the work speaks. Never use job-seeker framing on public surfaces.
