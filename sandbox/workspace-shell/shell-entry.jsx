import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

function useShellStatus() {
  const [status, setStatus] = useState(null);
  const initialRevision = useRef(null);
  useEffect(() => {
    let active = true;
    let timer;
    const read = async () => {
      try {
        const response = await fetch("/__autoforum_workspace/status", { cache: "no-store" });
        const next = await response.json();
        if (!active) return;
        if (initialRevision.current === null) initialRevision.current = next.revision;
        else if (next.revision !== initialRevision.current) {
          location.reload();
          return;
        }
        setStatus(next);
      } catch {
        // Rebuilds may briefly replace the active files. Try again.
      }
      timer = window.setTimeout(read, 1_000);
    };
    void read();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("Workspace page failed", error);
  }

  render() {
    if (this.state.error) {
      return <main className="page"><div className="empty error workspace-message"><h1>Page error</h1><pre>{String(this.state.error?.stack ?? this.state.error)}</pre></div></main>;
    }
    return this.props.children;
  }
}

// The shell's own views are built from the design system (design-system.css) plus the few .workspace-* classes in
// shell.css, the same way a project page should be.
function Home({ pages }) {
  return (
    <main className="page workspace-home">
      <p className="eyebrow">Project workspace</p>
      <h1>Pages built for this project</h1>
      <p className="lede muted">Open a page to use what has been built. Ask the Scribe in Autoforum to add a page, change one, or improve a reusable module.</p>
      {pages.length ? (
        <section className="workspace-grid" aria-label="Workspace pages">
          {pages.map((page) => (
            <a className="card workspace-card" href={`/${page.slug}`} key={page.slug}>
              <span className="workspace-card-icon" aria-hidden="true">{page.icon || "◇"}</span>
              <span><strong>{page.title}</strong><small>{page.description || "Open this workspace page."}</small></span>
              <span className="workspace-card-arrow" aria-hidden="true">→</span>
            </a>
          ))}
        </section>
      ) : (
        <section className="empty workspace-message">
          <h1>No pages yet</h1>
          <p>Talk to the Scribe about what this project needs. New pages will appear here automatically.</p>
        </section>
      )}
    </main>
  );
}

function WorkspaceShell({ pages }) {
  const status = useShellStatus();
  const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean)[0] ?? "");
  const page = pages.find((candidate) => candidate.slug === slug);
  const Page = page?.component;
  return (
    <div className="workspace-shell">
      {page ? (
        <nav className="crumbs workspace-crumbs" aria-label="Workspace pages">
          <a href="/">Pages</a><span aria-hidden="true">›</span><span aria-current="page">{page.title}</span>
        </nav>
      ) : null}
      {status?.error ? <div className="workspace-build-error" role="alert">The latest workspace change did not build. The previous version is still running.<details><summary>Build details</summary><pre>{status.error}</pre></details></div> : null}
      {slug && !page ? <main className="page"><div className="empty workspace-message"><h1>Page not found</h1><p>There is no workspace page at <code>/{slug}</code>.</p><a href="/">Return home</a></div></main>
        : Page ? <PageErrorBoundary><Page /></PageErrorBoundary>
          : <Home pages={pages} />}
    </div>
  );
}

export function mountWorkspace(pages) {
  createRoot(document.getElementById("root")).render(<WorkspaceShell pages={pages} />);
}
