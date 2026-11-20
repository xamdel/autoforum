// What a thread opens beside itself in the dock: a proposal with its results, or one result.

import type { DiscourseObject, ForumResult, ThreadDetail } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { addressLink } from "../lib/router.ts";
import { Markdown, Reference } from "../components/Markdown.tsx";
import { ResultOutputs } from "../components/Records.tsx";
import { AddressChip, Badge, Empty, icons, KindIcon, Loading, PanelFrame, Time } from "../components/ui.tsx";
import { closeDockView, openDockView, type DockView } from "../state/dock.ts";
import { appendToReply } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { useThread } from "../state/queries.ts";
import { askScribe } from "../state/scribe.ts";

function ResultSection({ result, threadId, open }: { result: ForumResult; threadId: number; open?: boolean }) {
  return (
    <section className="result-section" data-address={result.address}>
      <header className="result-head">
        <KindIcon kind="result" />
        <button type="button" className="link" onClick={() => openDockView({ kind: "result", address: result.address, threadId })}>{result.address}</button>
        <span className="muted small">imported <Time at={result.createdAt} /> · <code>{result.submissionId}.json</code></span>
      </header>
      <ResultOutputs result={result} open={open} />
    </section>
  );
}

function ProposalPanel({ proposal, detail }: { proposal: DiscourseObject; detail: ThreadDetail }) {
  const { projectId, isOwner } = useProject();
  const threadId = detail.thread.id;
  const results = detail.results.filter((result) => result.proposalAddress === proposal.address);
  const expected = Object.entries(proposal.expectedOutputs ?? {});
  const delivered = new Set(results.flatMap((result) => Object.keys(result.outputs)));
  const relations = detail.objects.filter((object) => object.kind === "relation" && (object.subjects?.includes(proposal.address) || object.objects?.includes(proposal.address)));
  const post = detail.posts.find((each) => each.id === proposal.bornInPostId);
  return (
    <PanelFrame
      label="Proposal"
      title={<><KindIcon kind="proposal" /> Proposal</>}
      sub={<AddressChip address={proposal.address} />}
      onClose={closeDockView}
      actions={isOwner ? (
        <button type="button" className="small" title="Ask the Scribe to build this in the workspace; the conversation is private to you" onClick={() => askScribe(projectId, { anchor: proposal.address, text: `Build [[${proposal.address}]] in the workspace and publish its outputs as a result. ` })}>
          {icons.quill} Build with the Scribe
        </button>
      ) : null}
    >
      <div className="panel-body">
        {proposal.label ? <h2 className="panel-heading">{proposal.label}</h2> : null}
        <p className="muted small panel-meta">
          proposed by <b>@{proposal.creator}</b> <Time at={proposal.createdAt} />
          {post ? <> in <a href={addressLink(projectId, post.address)} data-ref={post.address}>{post.address}</a></> : null}
        </p>
        {proposal.body ? <Markdown text={proposal.body} /> : null}

        <h4>Expected outputs</h4>
        {expected.length ? (
          <table className="expected">
            <tbody>
              {expected.map(([key, note]) => (
                <tr key={key}>
                  <td><code>{key}</code></td>
                  <td className="muted">{typeof note === "string" ? note : JSON.stringify(note)}</td>
                  <td>{delivered.has(key) ? <Badge tone="good">delivered</Badge> : <Badge tone="open">not yet</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">None declared.</p>}

        <h4>Results {results.length ? <span className="count-badge inline">{results.length}</span> : null}</h4>
        {results.length
          ? results.map((result) => <ResultSection key={result.id} result={result} threadId={threadId} open={results.length === 1} />)
          : <p className="muted small">None yet. Code in the sandbox publishes a result by writing <code>{`{"target":"${proposal.address}","outputs":{"named_output":null}}`}</code> into <code>.autoforum/results/</code>.</p>}

        {relations.length ? (
          <>
            <h4>Relations</h4>
            <ul className="relation-list">
              {relations.map((relation) => (
                <li key={relation.id}>
                  {(relation.subjects ?? []).map((address) => <Reference key={address} address={address} projectId={projectId} />)}
                  <span className={`relation-type relation-${relation.relationType}`}>{relation.relationType}</span>
                  {(relation.objects ?? []).map((address) => <Reference key={address} address={address} projectId={projectId} />)}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="panel-actions">
          <button type="button" onClick={() => appendToReply(projectId, threadId, `[[${proposal.address}]] `)}>Cite in my reply</button>
        </div>
      </div>
    </PanelFrame>
  );
}

function ResultPanel({ result, detail }: { result: ForumResult; detail: ThreadDetail }) {
  const { projectId } = useProject();
  const threadId = detail.thread.id;
  const count = Object.keys(result.outputs).length;
  return (
    <PanelFrame label="Result" title={<><KindIcon kind="result" /> Result</>} sub={<AddressChip address={result.address} />} onClose={closeDockView}>
      <div className="panel-body">
        <p className="muted small panel-meta">
          {plural(count, "output")} for{" "}
          {result.proposalAddress
            ? <button type="button" className="link" onClick={() => openDockView({ kind: "proposal", address: result.proposalAddress!, threadId })}>{result.proposalAddress}</button>
            : "this thread"}
          {" "}· imported <Time at={result.createdAt} /> from <code>.autoforum/results/{result.submissionId}.json</code>
        </p>
        <p className="muted small">Stored exactly as the sandbox wrote it. Each output can be cited on its own.</p>
        <ResultOutputs result={result} open />
        <div className="panel-actions">
          <button type="button" onClick={() => appendToReply(projectId, threadId, `[[${result.address}]] `)}>Cite in my reply</button>
        </div>
      </div>
    </PanelFrame>
  );
}

export default function Inspector({ view }: { view: DockView }) {
  const { projectId } = useProject();
  const thread = useThread(projectId, view.threadId);
  const detail = thread.data;
  if (!detail) return <PanelFrame label="Loading" title="…" onClose={closeDockView}><div className="panel-body"><Loading /></div></PanelFrame>;
  if (view.kind === "proposal") {
    const proposal = detail.objects.find((object) => object.address === view.address);
    if (proposal) return <ProposalPanel proposal={proposal} detail={detail} />;
  } else {
    const result = detail.results.find((each) => each.address === view.address);
    if (result) return <ResultPanel result={result} detail={detail} />;
  }
  return <PanelFrame label="Missing" title={view.address} onClose={closeDockView}><div className="panel-body"><Empty>That record is not in this thread.</Empty></div></PanelFrame>;
}
