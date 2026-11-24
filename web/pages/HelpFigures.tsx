// Pictures of the app for the help pages, drawn with the app's own markup and classes rather than screenshots: they
// stay sharp when zoomed, follow every change of style, and show the reader's own handle, project, and agent. A
// guide page asks for one with a comment line, invisible on GitHub:
//
//   <!-- ui:post mark=reply,quote | Under every post -->
//
// "mark" rings the named controls in gold, as the tour does; the text after "|" is the caption. Each picture copies
// the markup of the component it shows (named beside it), so a change to that markup should be copied here too.
// Nothing in a picture works: it is inert and hidden from screen readers, which read the caption instead.

import "../styles/workspace.css";

import type { ReactNode } from "react";

import { BrandMark } from "../chrome/Header.tsx";
import { Avatar, icons, KindIcon, Who } from "../components/ui.tsx";
import { useProject } from "../state/project.tsx";

interface Scene {
  handle: string;
  project: string;
  agent: string;
  marks: ReadonlySet<string>;
}

/** " help-mark" when `name` is to be ringed. */
const ring = (scene: Scene, name: string) => (scene.marks.has(name) ? " help-mark" : "");

/** chrome/Header.tsx */
function Header(scene: Scene) {
  return (
    <div className="top help-top">
      <a className="brand"><BrandMark /><span>Autoforum</span></a>
      <select className="project-select" value="project" onChange={() => undefined} tabIndex={-1}><option value="project">{scene.project}</option></select>
      <nav>
        <a className={`active${ring(scene, "forum")}`}>Forum</a>
        <a className={ring(scene, "library")}>Library</a>
        <a className={ring(scene, "workspace")}>Workspace<i className="nav-dot running" /></a>
        <span className="agents-nav"><a className={ring(scene, "agents")}>Agents</a></span>
      </nav>
      <div className={`search-box${ring(scene, "search")}`}>
        <input type="search" placeholder="Search threads, posts, sources, results…" readOnly tabIndex={-1} />
      </div>
      <button type="button" className={`cluster-btn${ring(scene, "scribe")}`} tabIndex={-1}>{icons.quill}<span>Scribe</span></button>
      <button type="button" className={`cluster-btn identity${ring(scene, "account")}`} tabIndex={-1}><span>@{scene.handle}</span>{icons.chevron}</button>
    </div>
  );
}

/** A strip of the header holding only `children`, for its small signals. */
const Strip = ({ children }: { children: ReactNode }) => <div className="top help-top help-strip"><nav>{children}</nav></div>;

/** pages/Thread.tsx, PostView */
function Post(scene: Scene, agent = false) {
  const author = agent ? scene.agent : "margaret";
  return (
    <article className={`post ${agent ? "by-agent" : ""}`}>
      <header>
        <Avatar handle={author} size="small" />
        <span className="post-author">
          <Who handle={author} kind={agent ? "agent" : "human"} />
          {agent ? <span className="post-model">anthropic/claude · medium effort</span> : null}
        </span>
        <span className="muted">2h ago</span>
        {agent ? <a className="reply-to muted">{icons.reply} post:1</a> : null}
        <span className="post-id"><button type="button" className={`address-chip${ring(scene, "address")}`} tabIndex={-1}>{agent ? "post:3" : "post:1"}</button></span>
      </header>
      <div className="md">
        <p>{agent
          ? "Comparing the two venues: the library room is cheaper but holds only 30, which is tight at the upper estimate. The church hall fits everyone and has step-free access."
          : "We expect 25 to 35 people and need step-free access. Please compare the two venues in the Library, especially parking, cost, and noise."}</p>
      </div>
      <footer>
        <button type="button" className={`link${ring(scene, "reply")}`} tabIndex={-1}>Reply</button>
        <button type="button" className={`link${ring(scene, "quote")}`} tabIndex={-1}>Quote</button>
        <button type="button" className={`link${ring(scene, "cite")}`} tabIndex={-1}>Cite</button>
        <button type="button" className={`link${ring(scene, "ask")}`} tabIndex={-1}>Ask the Scribe</button>
      </footer>
    </article>
  );
}

const ATTACH = [["question", "Question"], ["claim", "Claim"], ["evidence", "Evidence"], ["proposal", "Proposal"], ["relation", "Relation"], ["excerpt", "Excerpt"]] as const;

/** pages/Composer.tsx */
function Composer(scene: Scene, options: { text?: string; replying?: boolean } = {}) {
  return (
    <div className="card form composer">
      {options.replying ? (
        <div className={`reply-target small${ring(scene, "reply-target")}`}>
          {icons.reply} Replying to <a className="ref ref-post">post:2</a>
          <button type="button" className="link" tabIndex={-1}>cancel</button>
        </div>
      ) : null}
      <div className={`smart-textarea${ring(scene, "box")}${ring(scene, "mention")}`}>
        <textarea rows={options.text ? 3 : 4} readOnly tabIndex={-1} value={options.text ?? ""} placeholder="Write a reply in Markdown. @ mentions a member; [[ links a post, a claim, a source, a result." />
      </div>
      <div className={`attach-bar${ring(scene, "attach")}`}>
        <span className="muted small">Attach</span>
        {ATTACH.map(([kind, label]) => <button type="button" key={kind} className="attach" tabIndex={-1}><KindIcon kind={kind} /> {label}</button>)}
      </div>
      <div className="row">
        <button type="button" className={`primary${ring(scene, "post-reply")}`} tabIndex={-1}>Post reply</button>
        <button type="button" className={ring(scene, "preview")} tabIndex={-1}>Preview</button>
        <span className="muted small push">Posting as @{scene.handle} · Ctrl+Enter posts</span>
      </div>
    </div>
  );
}

/** pages/Home.tsx, the board's head */
function NewThread(scene: Scene) {
  return (
    <div className="head-row board-head">
      <h1>{scene.project}</h1>
      <span className="head-tools"><button type="button" className={`primary${ring(scene, "new-thread")}`} tabIndex={-1}>New thread</button></span>
    </div>
  );
}

/** pages/Home.tsx, TagFilter */
function Tags(scene: Scene) {
  return (
    <div className="chips tag-filter">
      <span className="chips-label">Tags</span>
      <a className={`chip on${ring(scene, "tag")}`}>meetings<span className="chip-x">×</span></a>
      <a className="chip">december<span className="chip-count">2</span></a>
      <a className="chip">seeds<span className="chip-count">1</span></a>
      <a className={`chips-clear small${ring(scene, "clear")}`}>Clear</a>
    </div>
  );
}

/** chrome/ScribeChat.tsx: the panel's head and one exchange */
function ScribeAnswer(scene: Scene) {
  return (
    <section className="panel-frame help-panel">
      <header className="panel-head">
        <span className="panel-title">{icons.quill} Scribe</span>
        <span className="panel-sub">
          <button type="button" className={`chat-title${ring(scene, "conversations")}`} tabIndex={-1}><span>Venue for December</span>{icons.chevron}</button>
        </span>
        <span className="panel-tools">
          <button type="button" className="icon-button" tabIndex={-1}>{icons.plus}</button>
          <button type="button" className="icon-button" tabIndex={-1}>{icons.close}</button>
        </span>
      </header>
      <div className="chat">
        <div className="chat-log">
          <div className="msg mine"><div className="md"><p>Draft a short reply that asks for the hire prices.</p></div></div>
          <article className="msg scribe">
            <div className="msg-who">{icons.quill} Scribe <span className="muted">just now</span></div>
            <div className="md"><p>Thanks, both. Before we decide, could someone confirm the hire price for each venue for an evening in December?</p></div>
            <div className="msg-actions">
              <button type="button" className="link" tabIndex={-1}>Copy</button>
              <button type="button" className={`link${ring(scene, "use-reply")}`} tabIndex={-1}>Use as reply</button>
              <button type="button" className={`link${ring(scene, "use-thread")}`} tabIndex={-1}>Use as new thread</button>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/** pages/Library.tsx */
function Library(scene: Scene) {
  return (
    <div className="library">
      <div className="head-row">
        <div>
          <div className="crumbs">Library</div>
          <h1>Sources</h1>
        </div>
        <span className="head-tools">
          <button type="button" className={`library-add primary${ring(scene, "add")}`} tabIndex={-1}>{icons.plus}</button>
        </span>
      </div>
      <div className="library-tools">
        <label className={`library-search${ring(scene, "search")}`}>{icons.search}<input type="search" placeholder="Search this library" readOnly tabIndex={-1} /></label>
      </div>
    </div>
  );
}

/** pages/Source.tsx, the reader with a passage selected */
function Excerpt(scene: Scene) {
  return (
    <div className="help-reader">
      <pre className="page-text">
        {"The hall seats 120 and is let by the hour. "}
        <span className="help-selected">Evening hire, from 6 pm, is £25 an hour for community groups.</span>
        {" A refundable deposit of £50 is taken on booking. Step-free access is by the side door on Church Lane."}
      </pre>
      <div className="selection-tools help-selection-tools">
        <button type="button" className={`primary small${ring(scene, "excerpt")}`} tabIndex={-1}>Excerpt in my reply</button>
      </div>
    </div>
  );
}

/** chrome/Header.tsx, the account menu open */
function AccountMenu(scene: Scene) {
  return (
    <div className="help-account">
      <div className="top help-top help-strip">
        <button type="button" className="cluster-btn identity on" tabIndex={-1}><span>@{scene.handle}</span>{icons.chevron}</button>
      </div>
      <div className="help-menu-area">
        <div className="popover right menu">
          <div className="menu-note">Signed in as <b>@{scene.handle}</b></div>
          <a className={`menu-item${ring(scene, "help")}`}>{icons.help} Help</a>
          <button type="button" className={`menu-item${ring(scene, "tour")}`} tabIndex={-1}>{icons.compass} Take the tour</button>
          <a className="menu-item">{icons.gear} Project settings</a>
          <button type="button" className={`menu-item${ring(scene, "signout")}`} tabIndex={-1}>{icons.signOut} Sign out</button>
        </div>
      </div>
    </div>
  );
}

/** pages/Workspace.tsx, what a member sees while the sandbox is stopped */
function SandboxStopped() {
  return (
    <div className="ws-startup help-startup">
      <span className="ws-startup-mark">{icons.folder}</span>
      <p className="eyebrow">Project workspace</p>
      <h1>The sandbox is stopped</h1>
      <p className="muted">Only the project owner can start or stop the sandbox. Workspace pages open here while it is running.</p>
    </div>
  );
}

const FIGURES: Record<string, { flush?: boolean; draw(scene: Scene): ReactNode }> = {
  "header": { flush: true, draw: Header },
  "post": { draw: (scene) => Post(scene) },
  "agent-post": { draw: (scene) => Post(scene, true) },
  "composer": { draw: (scene) => Composer(scene) },
  "composer-replying": { draw: (scene) => Composer(scene, { replying: true, text: "The church hall's ramp is at the side door." }) },
  "composer-mention": { draw: (scene) => Composer(scene, { text: `@${scene.agent} Which venue works out cheaper per person?` }) },
  "new-thread": { draw: NewThread },
  "tags": { draw: Tags },
  "scribe-answer": { flush: true, draw: ScribeAnswer },
  "library": { draw: Library },
  "excerpt": { draw: Excerpt },
  "account-menu": { flush: true, draw: AccountMenu },
  "sandbox-stopped": { draw: SandboxStopped },
  "agents-working": {
    flush: true,
    draw: () => (
      <Strip>
        <a>Forum</a>
        <a>Library</a>
        <span className="agents-nav">
          <a className="working">Agents<span className="nav-count">1</span><span className="nav-activity" /></a>
        </span>
      </Strip>
    ),
  },
  "workspace-dot": {
    flush: true,
    draw: () => (
      <div className="help-pair">
        <div><Strip><a>Workspace<i className="nav-dot running" /></a></Strip><span>Running</span></div>
        <div><Strip><a>Workspace<i className="nav-dot stopped" /></a></Strip><span>Stopped</span></div>
      </div>
    ),
  },
};

export function HelpFigure({ name, marks, children }: { name: string; marks: string[]; children: ReactNode }) {
  const { user, project, members } = useProject();
  const figure = FIGURES[name];
  if (!figure) return <p className="muted small">[No picture called “{name}”.]</p>;
  const scene: Scene = {
    handle: user.handle,
    project: project.name,
    agent: members.find((member) => member.kind === "agent")?.handle ?? "holmes",
    marks: new Set(marks),
  };
  return (
    <figure className="help-figure">
      <div className={`help-screen ${figure.flush ? "flush" : ""}`} inert aria-hidden="true">{figure.draw(scene)}</div>
      {children ? <figcaption>{children}</figcaption> : null}
    </figure>
  );
}
