// Forum Markdown, rendered inertly. Marked tokens become React elements; raw HTML shows as typed characters, links
// keep only http(s) and mailto destinations, and images are shown as links rather than fetched. The sole generated-
// HTML island is trust-disabled KaTeX MathML from web/lib/math.ts.
//
// Three things are recognized beyond Markdown: TeX math, [[address]] references, and @handles of project members.

import { Marked, type Token, type Tokens } from "marked";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { mathExtensions, renderMathMarkup } from "../lib/math.ts";
import { addressLink } from "../lib/router.ts";
import { useProject } from "../state/project.tsx";

export const ADDRESS_PATTERN = "(?:thread|post|source|excerpt|result|question|claim|evidence|proposal|rel):[1-9]\\d*(?:#[a-z][a-z0-9_-]{0,63})?";
const LOCAL_PATTERN = "new:[a-z][a-z0-9_-]{0,31}";
const referenceAtStart = new RegExp(`^\\[\\[(${ADDRESS_PATTERN}|${LOCAL_PATTERN})\\]\\]`);
const inText = new RegExp("(?<![\\w@/.-])@([a-z][a-z0-9_-]{1,31})\\b", "gi");

const parser = new Marked({
  gfm: true,
  breaks: false,
  extensions: [...mathExtensions, {
    name: "reference",
    level: "inline",
    start: (source: string) => {
      const index = source.indexOf("[[");
      return index < 0 ? undefined : index;
    },
    tokenizer: (source: string) => {
      const match = referenceAtStart.exec(source);
      return match ? { type: "reference", raw: match[0], address: match[1] } : undefined;
    },
  }],
});

const lexed = new Map<string, Token[]>();
function tokensFor(text: string): Token[] {
  let tokens = lexed.get(text);
  if (!tokens) {
    tokens = parser.lexer(text);
    if (lexed.size > 400) lexed.delete(lexed.keys().next().value!);
    lexed.set(text, tokens);
  }
  return tokens;
}

let decoder: HTMLTextAreaElement | null = null;
/** Markdown leaves character references (&amp;, &#8212;) for HTML to resolve; with no HTML, they are resolved here. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (entity) => {
    decoder ??= document.createElement("textarea");
    decoder.innerHTML = entity;
    return decoder.value;
  });
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^#\/\d/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, "https://relative.invalid/");
    if (url.hostname === "relative.invalid") return null;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The only generated-HTML island in forum Markdown: trust-disabled KaTeX output containing MathML only. */
function MathExpression({ source, display }: { source: string; display: boolean }) {
  const identity = `${display ? "block" : "inline"}\0${source}`;
  const [rendered, setRendered] = useState<{ identity: string; html: string } | null>(null);
  const html = rendered?.identity === identity ? rendered.html : null;
  useEffect(() => {
    let current = true;
    void renderMathMarkup(source, display).then(
      (next) => { if (current) setRendered({ identity, html: next }); },
      () => { if (current) setRendered({ identity, html: "" }); },
    );
    return () => { current = false; };
  }, [identity, source, display]);
  if (!html) {
    const fallback = <code className="math-source">{source}</code>;
    return display ? <span className="math-display">{fallback}</span> : fallback;
  }
  return <span className={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Context {
  projectId: number;
  kinds: ReadonlyMap<string, "human" | "agent">;
}

export function Reference({ address, projectId }: { address: string; projectId: number }) {
  if (address.startsWith("new:")) return <span className="ref pending" title="An attachment on this post; it gets its address when posted">{address}</span>;
  const kind = address.slice(0, address.indexOf(":"));
  return <a className={`ref ref-${kind}`} href={addressLink(projectId, address)} data-ref={address}>{address}</a>;
}

/** Plain text with project-member mentions highlighted. */
function prose(text: string, context: Context, key: string): ReactNode[] {
  const decoded = decodeEntities(text);
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of decoded.matchAll(inText)) {
    const [whole, handle] = match;
    let node: ReactNode = null;
    if (handle) {
      const kind = context.kinds.get(handle.toLowerCase());
      if (kind) node = <span key={`${key}m${match.index}`} className={`mention ${kind}`}>{whole}</span>;
    }
    if (!node) continue;
    if (match.index > last) out.push(decoded.slice(last, match.index));
    out.push(node);
    last = match.index + whole.length;
  }
  if (last < decoded.length) out.push(decoded.slice(last));
  return out;
}

function inline(tokens: Token[] | undefined, context: Context, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  const flush = (index: number) => {
    if (!buffer) return;
    out.push(...prose(buffer, context, `${prefix}t${index}`));
    buffer = "";
  };
  (tokens ?? []).forEach((token, index) => {
    const key = `${prefix}${index}`;
    // Neighbouring runs of plain text are joined first, so a handle or a path split by the tokenizer is seen whole.
    if (token.type === "escape" || (token.type === "text" && !(token as Tokens.Text).tokens)) {
      buffer += (token as Tokens.Text).text;
      return;
    }
    flush(index);
    switch (token.type) {
      case "text":
        out.push(...inline((token as Tokens.Text).tokens, context, `${key}.`));
        break;
      case "strong":
        out.push(<strong key={key}>{inline((token as Tokens.Strong).tokens, context, `${key}.`)}</strong>);
        break;
      case "em":
        out.push(<em key={key}>{inline((token as Tokens.Em).tokens, context, `${key}.`)}</em>);
        break;
      case "del":
        out.push(<del key={key}>{inline((token as Tokens.Del).tokens, context, `${key}.`)}</del>);
        break;
      case "codespan": {
        const text = (token as Tokens.Codespan).text;
        out.push(<code key={key}>{text}</code>);
        break;
      }
      case "br":
        out.push(<br key={key} />);
        break;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        const children = inline(link.tokens, context, `${key}.`);
        out.push(href
          ? href.startsWith("#")
            ? <a key={key} href={href}>{children}</a>
            : <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" title={link.title ?? undefined}>{children}</a>
          : <span key={key}>{children}</span>);
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = safeHref(image.href);
        const label = `image: ${image.text || image.href}`;
        out.push(href
          ? <a key={key} className="md-image" href={href} target="_blank" rel="noopener noreferrer nofollow" title="Images in posts are not loaded; this opens it in a new tab">{label}</a>
          : <span key={key} className="md-image">{label}</span>);
        break;
      }
      case "reference":
        out.push(<Reference key={key} address={String((token as Tokens.Generic).address)} projectId={context.projectId} />);
        break;
      case "mathInline": {
        const math = token as Tokens.Generic;
        out.push(<MathExpression key={key} source={String(math.text)} display={Boolean(math.display)} />);
        break;
      }
      case "checkbox":
        out.push(<span key={key} className="md-check" aria-hidden="true">{(token as Tokens.Checkbox).checked ? "☑" : "☐"} </span>);
        break;
      default:
        // Raw HTML and anything unrecognized: the characters as written.
        buffer += token.raw;
    }
  });
  flush((tokens ?? []).length);
  return out;
}

function blocks(tokens: Token[], context: Context, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const key = `${prefix}${index}`;
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "hr":
        out.push(<hr key={key} />);
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Tag = `h${Math.min(6, heading.depth)}` as "h1";
        out.push(<Tag key={key}>{inline(heading.tokens, context, `${key}.`)}</Tag>);
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        out.push(<pre key={key} data-language={code.lang || undefined}><code>{code.text}</code></pre>);
        break;
      }
      case "mathBlock": {
        const math = token as Tokens.Generic;
        out.push(<MathExpression key={key} source={String(math.text)} display />);
        break;
      }
      case "blockquote":
        out.push(<blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, context, `${key}.`)}</blockquote>);
        break;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => (
          <li key={itemIndex} className={item.task ? "task" : undefined}>
            {item.task && !item.tokens.some(hasCheckbox) ? <span className="md-check" aria-hidden="true">{item.checked ? "☑" : "☐"} </span> : null}
            {blocks(item.tokens, context, `${key}.${itemIndex}.`)}
          </li>
        ));
        out.push(list.ordered
          ? <ol key={key} start={typeof list.start === "number" && list.start !== 1 ? list.start : undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>);
        break;
      }
      case "paragraph":
        out.push(<p key={key}>{inline((token as Tokens.Paragraph).tokens, context, `${key}.`)}</p>);
        break;
      case "table": {
        const table = token as Tokens.Table;
        const cell = (each: Tokens.TableCell, cellIndex: number, Tag: "th" | "td") => (
          <Tag key={cellIndex} style={each.align ? { textAlign: each.align } : undefined}>{inline(each.tokens, context, `${key}.${cellIndex}.`)}</Tag>
        );
        out.push(
          <div key={key} className="md-table">
            <table>
              <thead><tr>{table.header.map((each, cellIndex) => cell(each, cellIndex, "th"))}</tr></thead>
              <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((each, cellIndex) => cell(each, cellIndex, "td"))}</tr>)}</tbody>
            </table>
          </div>,
        );
        break;
      }
      case "html":
        out.push(<p key={key} className="md-raw">{(token as Tokens.HTML).raw.trim()}</p>);
        break;
      default: {
        // A tight list item's text, or an inline token at block level.
        const nested = (token as Tokens.Generic).tokens;
        out.push(...inline(nested ?? [token], context, `${key}.`));
      }
    }
  });
  return out;
}

const hasCheckbox = (token: Token): boolean => token.type === "checkbox" || Boolean((token as Tokens.Generic).tokens?.some(hasCheckbox));

export const Markdown = memo(function Markdown({ text, className = "md" }: { text: string; className?: string }) {
  const { projectId, kinds } = useProject();
  const rendered = useMemo(
    () => blocks(tokensFor(text), { projectId, kinds }, ""),
    [text, projectId, kinds],
  );
  return <div className={className}>{rendered}</div>;
});

/** One line of plain words from Markdown, for lists and previews. */
export function plainLine(text: string | null | undefined, limit = 160): string {
  if (!text) return "";
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}
