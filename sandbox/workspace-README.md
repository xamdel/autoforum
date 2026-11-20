# Project workspace

This is one persistent, evolving project maintained by the Scribe with the owner. Autoforum supplies and runs the workspace shell; this repository contains only project code and data.

## Layout

- `pages/` contains the browser pages shown by the workspace shell. Each page has a `page.json`, a default-exporting `page.tsx`, and optionally a sandbox-side `server.ts`.
- `modules/` contains reusable project code, organized by capability: for example `node-graph/`, `mesh-viewer/`, or `inference-client/`.
- `outputs/` contains generated files and run data. It is ignored by Git unless a particular small output is deliberately promoted into the project source.

Name modules after what they do, not after the first page that happens to use them. Page-specific code may stay with its page. Extract code into `modules/` only when it has a coherent reusable interface.

The shell automatically discovers and rebuilds pages, and gives every page Autoforum's design system so the workspace looks like the forum beside it; `pages/README.md` says how to build with it. Do not replace the shell or start a competing web server. Keep source, configuration, lockfiles, and small fixtures in Git; keep dependency trees, caches, and generated output ignored.
