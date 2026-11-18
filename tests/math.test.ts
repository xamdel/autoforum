import assert from "node:assert/strict";
import test from "node:test";

import { Marked, type Token, type Tokens } from "marked";

import { mathExtensions, renderMathMarkup } from "../web/lib/math.ts";

const parser = new Marked({ gfm: true, breaks: false, extensions: mathExtensions });

function nestedTokens(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => {
    const nested = (token as Tokens.Generic).tokens;
    return [token, ...(nested ? nestedTokens(nested) : [])];
  });
}

test("forum Markdown recognizes conservative inline and display math delimiters", () => {
  const source = String.raw`Inline $x^2$ and \(y + 1\).

$$
\frac{1}{z}
$$
`;
  const tokens = nestedTokens(parser.lexer(source));
  assert.deepEqual(tokens.filter((token) => token.type === "mathInline").map((token) => (token as Tokens.Generic).text), ["x^2", "y + 1"]);
  assert.deepEqual(tokens.filter((token) => token.type === "mathBlock").map((token) => (token as Tokens.Generic).text), [String.raw`\frac{1}{z}`]);
  assert.equal(nestedTokens(parser.lexer("Prices are $5.00 and $6.00; code is `$x$`." )).some((token) => token.type.startsWith("math")), false);
});

test("KaTeX produces inert MathML without inline styles or trusted links", async () => {
  const markup = await renderMathMarkup(String.raw`x^2 + \frac{1}{y}`, true);
  assert.match(markup, /<math[^>]+display="block"/);
  assert.match(markup, /<mfrac>/);
  assert.doesNotMatch(markup, /\sstyle=|<script|<a\b|\shref=/i);

  const untrusted = await renderMathMarkup(String.raw`\href{javascript:alert(1)}{click}`, false);
  assert.doesNotMatch(untrusted, /<script|<a\b|\shref=/i);
});
