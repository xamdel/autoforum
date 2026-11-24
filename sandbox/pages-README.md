# Pages

Each immediate directory is one page in the image-owned workspace shell.

A page requires `page.json` with `title`, optional `description`, and optional short `icon`, plus a `page.tsx` that default-exports a React component. Add `server.ts` only when the page needs sandbox-side filesystem, process, or authenticated-service work; it default-exports `(request: Request) => Promise<Response>` and is available to that page at `/api/pages/<page-name>/...`.

Page-specific helpers may live beside the page. Put genuinely reusable capabilities under `modules/` and import them by source path.

## Design

A page is part of Autoforum and should look like it. The shell loads Autoforum's design system ahead of every page, so plain elements (headings, links, buttons, fields, `code`, `pre`) are already styled, and its classes and colour tokens are available without an import. Read `/opt/autoforum-workspace-shell/design-system.css`, and `shell.css` beside it, before styling a page; their comments say what each piece is for.

- Put `className="page"` on the root of an ordinary page for the standard column and gutters. A page that fills the window (a canvas, a graph editor) leaves it off and sets `flex: 1` on its root.
- Build from what exists first: `.card`, `.form`, `.row`, `.primary`, `.badge`, `.chip`, `table.data`, `.empty`, and the rest listed at the top of `design-system.css`.
- For anything it lacks, add a stylesheet beside the page and draw on the tokens: `var(--marble)`, `var(--stone)`, `var(--ink)`, `var(--radius)`, and so on. Do not hard-code colours, bring another font or a dark theme, copy the design system into the workspace, or restyle the shell's own `.workspace-*` chrome. When a dependency ships its own look, restyle it with the tokens so that it matches.

## Browser sandbox

Pages run in a sandboxed cross-origin iframe. Scripts, same-origin requests, web workers, blob/data images, and downloads work, but the frame deliberately has no form-submission permission and its content policy sets `form-action 'none'`. Do not depend on native `<form>` submission: use `type="button"` with `onClick`, and handle Enter explicitly with `onKeyDown` when appropriate. Use `/api/pages/<page-name>/...` for durable state or privileged work. Browser storage belongs to the short-lived preview origin and must not be treated as durable project storage. Browser code cannot fetch external origins; put required external access behind `server.ts` and its same-origin page API. Popups, nested frames, top-level navigation, and browser capabilities disabled by the preview permissions policy are unavailable by design.
