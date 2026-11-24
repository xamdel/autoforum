// The member guide, inside the app. The pages are docs/member-guide's Markdown files, rendered as they stand in the
// repository, so there is one copy to keep. A link between them (`how-do-i.md#ask-the-scribe`) becomes a link here
// (#/3/help/how-do-i?at=ask-the-scribe), and each heading carries the id GitHub would give it, so the same links work
// in both places. A line such as `<!-- ui:post mark=reply | Under every post -->` draws a picture of that part of the
// app (HelpFigures.tsx); on GitHub it is an invisible comment.

import "../styles/help.css";

import { useEffect, useMemo } from "react";

import { Empty } from "../components/ui.tsx";
import { Markdown, plainLine } from "../components/Markdown.tsx";
import { link, useRoute } from "../lib/router.ts";
import { useProject } from "../state/project.tsx";
import { HelpFigure } from "./HelpFigures.tsx";

// screenshots.md is for whoever maintains the guide, not for members.
const files = import.meta.glob<string>(["../../docs/member-guide/*.md", "!../../docs/member-guide/screenshots.md"], { query: "?raw", import: "default", eager: true });

/** The pages in the order the guide is read. */
const ORDER = ["README.md", "how-do-i.md", "private-or-public.md", "what-does-this-mean.md", "troubleshooting.md", "cheat-sheet.md"];

interface Page { file: string; slug: string; title: string; text: string; printable: boolean }

const PAGES: Page[] = ORDER.flatMap((file) => {
  const text = files[`../../docs/member-guide/${file}`];
  if (text === undefined) return [];
  const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? file;
  return [{ file, slug: file === "README.md" ? "welcome" : file.replace(/\.md$/, ""), title: plainLine(title), text, printable: file === "cheat-sheet.md" }];
});

/** GitHub's id for a heading: lower case, punctuation dropped, spaces as hyphens. */
function anchorFor(heading: string): string {
  return plainLine(heading, 400).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

interface Section { id: string | null; level: number; heading: string; text: string }

/** The page cut at each second- and third-level heading, so each can carry its id. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  const used = new Map<string, number>();
  let current: Section & { lines: string[] } = { id: null, level: 1, heading: "", text: "", lines: [] };
  let fenced = false;
  const close = () => out.push({ id: current.id, level: current.level, heading: current.heading, text: current.lines.join("\n") });
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    close();
    const base = anchorFor(heading[2]!);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    current = { id: count ? `${base}-${count}` : base, level: heading[1]!.length, heading: heading[2]!, text: "", lines: [line] };
  }
  close();
  return out.filter((section) => section.text.trim());
}

const FIGURE_LINE = /^<!--\s*ui:([\w-]+)((?:\s+[\w-]+=[\w,-]+)*)\s*(?:\|\s*(.*?))?\s*-->$/;

type Piece = { text: string } | { figure: string; marks: string[]; caption: string };

/** A section's Markdown, cut wherever a picture is asked for. */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    if (lines.join("\n").trim()) out.push({ text: lines.join("\n") });
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const figure = fenced ? null : FIGURE_LINE.exec(line.trim());
    if (!figure) {
      lines.push(line);
      continue;
    }
    flush();
    const marks = /\bmark=([\w,-]+)/.exec(figure[2] ?? "")?.[1]?.split(",") ?? [];
    out.push({ figure: figure[1]!, marks, caption: figure[3] ?? "" });
  }
  flush();
  return out;
}

/** Links to other guide pages, and to headings on this one, as links inside the app. */
function relink(text: string, projectId: number, page: Page): string {
  const to = (target: Page, at?: string) => `${link(projectId, "help", target.slug)}${at ? `?at=${at}` : ""}`;
  return text
    .replace(/\]\(([\w-]+\.md)(?:#([\w-]+))?\)/g, (whole, file: string, at?: string) => {
      const target = PAGES.find((each) => each.file === file);
      return target ? `](${to(target, at)})` : whole;
    })
    .replace(/\]\(#([\w-]+)\)/g, (_whole, at: string) => `](${to(page, at)})`);
}

const show = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ block: "start" });

export default function Help() {
  const { projectId } = useProject();
  const route = useRoute();
  const page = PAGES.find((each) => each.slug === (route.segments[2] ?? "welcome"));
  const at = route.query.get("at");
  const parts = useMemo(
    () => (page ? sections(relink(page.text, projectId, page)).map((part) => ({ ...part, pieces: pieces(part.text) })) : []),
    [page, projectId],
  );
  const contents = parts.filter((part) => part.level === 2 && part.id);

  useEffect(() => {
    if (at) show(at);
  }, [at, page]);

  if (!page) return <Empty>That help page does not exist.</Empty>;
  return (
    <div className="help-page">
      <nav className="help-nav" aria-label="Help pages">
        <p className="eyebrow">Help</p>
        <ul>
          {PAGES.map((each) => (
            <li key={each.slug}>
              <a href={link(projectId, "help", each.slug)} className={each === page ? "active" : ""} aria-current={each === page ? "page" : undefined}>{each.title}</a>
              {each === page && contents.length > 1 ? (
                <ul className="help-contents" aria-label="On this page">
                  {contents.map((part) => (
                    <li key={part.id}>
                      <a href={`${link(projectId, "help", page.slug)}?at=${part.id}`} onClick={() => show(part.id!)}>{plainLine(part.heading, 80)}</a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>
      <article className="help-article">
        {page.printable ? <button type="button" className="help-print" onClick={() => window.print()}>Print this page</button> : null}
        {parts.map((part, index) => (
          <section key={part.id ?? `top${index}`} id={part.id ? `help-${part.id}` : undefined}>
            {part.pieces.map((piece, at) => ("figure" in piece
              ? (
                <HelpFigure key={at} name={piece.figure} marks={piece.marks}>
                  {piece.caption ? <Markdown text={piece.caption} className="md help-caption" /> : null}
                </HelpFigure>
              )
              : <Markdown key={at} text={piece.text} />))}
          </section>
        ))}
      </article>
    </div>
  );
}
