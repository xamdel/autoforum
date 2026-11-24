// A member's first look around: a short tour of the header on the first visit, then three hints, each shown once at
// the moment it matters — mentioning an agent (its reply will be public), opening a discussion (how to reply), and
// opening the Scribe (it is private). The tour replays from the account menu; the hints do not come back.
// Everything here points at the existing chrome; see Coachmark.tsx.

import "../styles/onboarding.css";

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { useRoute } from "../lib/router.ts";
import { endTour, loadOnboarding, markSeen, onboarding, showStep, startTour, type Lesson } from "../state/onboarding.ts";
import { useProject } from "../state/project.tsx";
import { Bubble, inView, Spotlight, useAnchor, type Placement } from "./Coachmark.tsx";

interface Stop {
  /** What the stop points at; none for the welcome, which sits in the middle of the window. */
  target: string | null;
  title: string;
  body: ReactNode;
}

function tourStops(projectName: string, agent: string | null): Stop[] {
  return [
    {
      target: null,
      title: `Welcome to ${projectName}`,
      body: (
        <>
          <p>Autoforum is a private discussion board for your group, with AI helpers built in. This short tour points out the main parts of the page. It takes about a minute.</p>
          <p className="muted">You can take it again any time: click your name at the top right and choose <b>Take the tour</b>.</p>
        </>
      ),
    },
    {
      target: '[data-tour="forum"]',
      title: "Forum",
      body: <p>The group’s discussions. Click a title to read a discussion from the beginning, and reply in the box at the bottom. To start a new one, click <b>New thread</b>.</p>,
    },
    {
      target: '[data-tour="library"]',
      title: "Library",
      body: <p>Articles, web links, and PDFs the group has collected. You can add your own, read them right here, and quote a passage in a discussion.</p>,
    },
    {
      target: '[data-tour="workspace"]',
      title: "Workspace",
      body: (
        <>
          <p>Where the project builds small software prototypes to try out ideas and test hypotheses, usually with the Scribe’s help.</p>
          <p>It runs in a sandbox that only the project owner can start or stop. The dot beside the word turns green while it is running.</p>
        </>
      ),
    },
    {
      target: ".agents-nav",
      title: "Agents",
      body: (
        <>
          <p>AI participants who answer <b>in public</b>. To ask one, write its name with an @ in a post, for example <b>@{agent ?? "name"}</b>. When you post, it reads the discussion and replies where everyone in the project can see.</p>
          <p>This page lists the agents and shows when one is working.</p>
        </>
      ),
    },
    {
      target: '[data-tour="search"]',
      title: "Search",
      body: <p>Type a few words and press Enter to search every discussion, post, and source in the project.</p>,
    },
    {
      target: '[data-tour="scribe"]',
      title: "Scribe",
      body: <p>Your <b>private</b> AI assistant. Ask it to summarize a discussion, explain something, or help you draft a reply. Only you can see your conversation, and it never posts anything for you. It opens beside the page you are reading.</p>,
    },
    {
      target: '[data-tour="account"]',
      title: "Your menu",
      body: <p>Click your name for the help pages, to take this tour again, or to sign out.</p>,
    },
  ];
}

/** Tab stays among the bubble's buttons while the tour has the page. */
function keepFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "Tab") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (!buttons.length) return;
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
  event.preventDefault();
  buttons[next]!.focus();
}

function Tour({ step }: { step: number }) {
  const { project, members } = useProject();
  const heading = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const stops = tourStops(project.name, members.find((member) => member.kind === "agent")?.handle ?? null);
  const at = Math.min(step, stops.length - 1);
  const stop = stops[at]!;
  const last = at === stops.length - 1;
  const anchor = useAnchor(() => {
    const element = stop.target ? document.querySelector(stop.target) : null;
    return element ? { element, data: at } : null;
  }, true, at);
  const rect = anchor?.data === at ? anchor.rect : null;
  const next = () => (last ? endTour() : showStep(at + 1));
  const back = () => showStep(Math.max(0, at - 1));

  useEffect(() => primary.current?.focus(), [at]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") return endTour();
    if (event.key === "ArrowRight" && at > 0) return next();
    if (event.key === "ArrowLeft" && at > 1) return back();
    keepFocus(event);
  };

  return (
    <>
      <Spotlight rect={rect} />
      <Bubble rect={rect} labelledBy={heading} modal className={`tour ${at === 0 ? "welcome" : ""}`} onKeyDown={keys}>
        <h2 id={heading}>{stop.title}</h2>
        <div className="coach-body">{stop.body}</div>
        {at === 0 ? (
          <div className="coach-actions">
            <button type="button" className="link" onClick={endTour}>Not now</button>
            <button type="button" className="primary" ref={primary} onClick={next}>Show me around</button>
          </div>
        ) : (
          <div className="coach-actions">
            <button type="button" className="link" onClick={endTour}>End tour</button>
            <span className="coach-count">{at} of {stops.length - 1}</span>
            {at > 1 ? <button type="button" onClick={back}>Back</button> : null}
            <button type="button" className="primary" ref={primary} onClick={next}>{last ? "Finish" : "Next"}</button>
          </div>
        )}
      </Bubble>
    </>
  );
}

interface Hint {
  lesson: Exclude<Lesson, "tour">;
  placement: Placement;
  /** The element to point at once the moment has come, and anything the words need (the agent's handle). */
  find(): { element: Element; data: string } | null;
  title(data: string): ReactNode;
  body(data: string): ReactNode;
}

function Hints({ seen }: { seen: Partial<Record<Lesson, true>> }) {
  const { members } = useProject();
  const page = useRoute().segments[1] ?? "forum";
  const heading = useId();
  const agents = members.filter((member) => member.kind === "agent").map((member) => member.handle.toLowerCase());
  const mention = agents.length ? new RegExp(`(?<![\\w@/.-])@(${agents.join("|")})(?![\\w-])`, "i") : null;

  const hints: Hint[] = [
    {
      lesson: "mention",
      placement: "above",
      // Any draft on the page that will be posted to the forum; the Scribe's own box is in the dock, not here, and
      // the help pages' pictures of a reply box are not drafts.
      find: () => {
        if (!mention || page === "settings" || page === "agents") return null;
        for (const area of document.querySelectorAll<HTMLTextAreaElement>("#page textarea")) {
          if (area.closest(".help-screen")) continue;
          const match = mention.exec(area.value);
          if (match && inView(area)) return { element: area, data: match[1]!.toLowerCase() };
        }
        return null;
      },
      title: (agent) => <>@{agent} will reply in public</>,
      body: (agent) => <>When you post this, @{agent} will read the discussion and add a reply that everyone in the project can see. If you only meant to mention it, leave out the @.</>,
    },
    {
      lesson: "scribe",
      placement: "left",
      find: () => {
        const element = document.querySelector('.panel-frame[aria-label="The Scribe"] .panel-head');
        return element ? { element, data: "" } : null;
      },
      title: () => "This conversation is private",
      body: () => <>Only you can see what you and the Scribe write here, and it never posts for you. When it drafts something useful, <b>Use as reply</b> puts the text in your reply box for you to check and post.</>,
    },
    {
      lesson: "thread",
      placement: "below",
      find: () => {
        if (page !== "t") return null;
        const element = [...document.querySelectorAll('[data-tour="reply"]')].find(inView);
        return element ? { element, data: "" } : null;
      },
      title: () => "Replying",
      body: () => <>Click <b>Reply</b> under a post to answer it, or write in the box at the bottom of the page. Nothing is posted until you click <b>Post reply</b>.</>,
    },
  ];
  const waiting = hints.filter((hint) => !seen[hint.lesson]);
  const anchor = useAnchor(() => {
    for (const hint of waiting) {
      const found = hint.find();
      if (found) return { element: found.element, data: `${hint.lesson}:${found.data}` };
    }
    return null;
  }, waiting.length > 0, waiting.map((hint) => hint.lesson).join());

  if (!anchor) return null;
  const cut = anchor.data.indexOf(":");
  const hint = waiting.find((each) => each.lesson === anchor.data.slice(0, cut));
  if (!hint) return null;
  const data = anchor.data.slice(cut + 1);
  return (
    <Bubble rect={anchor.rect} placement={hint.placement} labelledBy={heading} className="hint">
      <h2 id={heading}>{hint.title(data)}</h2>
      <p className="coach-body">{hint.body(data)}</p>
      <div className="coach-actions">
        <button type="button" className="primary" onClick={() => markSeen(hint.lesson)}>Got it</button>
      </div>
    </Bubble>
  );
}

export function Onboarding() {
  const { user } = useProject();
  const state = onboarding.use();
  const ready = state.userId === user.id;
  useLayoutEffect(() => loadOnboarding(user.id), [user.id]);

  // The first visit opens the tour once the page has settled.
  useEffect(() => {
    if (!ready || onboarding.get().seen.tour) return;
    const timer = window.setTimeout(startTour, 700);
    return () => clearTimeout(timer);
  }, [ready]);

  if (!ready) return null;
  if (state.step !== null) return <Tour step={state.step} />;
  return <Hints seen={state.seen} />;
}
