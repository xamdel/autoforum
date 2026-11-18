// The small TeX boundary shared by forum Markdown. Delimiter recognition follows Pandoc's conservative dollar
// rules, while KaTeX is loaded only when a page actually contains math. We request MathML rather than KaTeX's
// styled HTML so the forum can keep its production CSP free of inline-style exceptions.

import type Katex from "katex";
import type { TokenizerAndRendererExtension } from "marked";

const INLINE_MATH: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/^\$\$([\s\S]+?)\$\$/, true],
  [/^\\\[([\s\S]+?)\\\]/, true],
  [/^\\\(([\s\S]+?)\\\)/, false],
  [/^\$(?![\s$])((?:\\.|[^$\\\n`])+?)(?<!\s)\$(?!\d)/, false],
];

export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "mathBlock",
    level: "block",
    start: (source) => source.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
    tokenizer(source) {
      const match = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(source);
      if (!match) return undefined;
      return { type: "mathBlock", raw: match[0], text: (match[1] ?? match[2]!).trim(), display: true };
    },
  },
  {
    name: "mathInline",
    level: "inline",
    start: (source) => source.match(/\$|\\[(\[]/)?.index,
    tokenizer(source) {
      for (const [expression, display] of INLINE_MATH) {
        const match = expression.exec(source);
        if (match) return { type: "mathInline", raw: match[0], text: match[1]!.trim(), display };
      }
      return undefined;
    },
  },
];

let katex: typeof Katex | null = null;
let loading: Promise<typeof Katex> | null = null;

async function loadKatex(): Promise<typeof Katex> {
  if (katex) return katex;
  loading ??= import("katex").then((module) => {
    katex = module.default;
    return katex;
  });
  return await loading;
}

/** Converts trusted parser output to CSP-compatible MathML. KaTeX still treats every TeX command as untrusted. */
export async function renderMathMarkup(source: string, displayMode: boolean): Promise<string> {
  const renderer = await loadKatex();
  return renderer.renderToString(source, {
    displayMode,
    output: "mathml",
    throwOnError: false,
    strict: "ignore",
    trust: false,
    maxExpand: 1_000,
  });
}
