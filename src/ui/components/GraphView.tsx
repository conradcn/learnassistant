// FRACTAL: implements F3, F5 | component C10
'use client';
import { useState, type ReactNode } from 'react';
import type { ModuleAvailability, ModuleGraph } from '@/shapes';
import {
  graphLayout,
  prereqSentence,
  stillToComeSentence,
  type GraphNodeView,
} from '@/ui/graph-layout';
import { minutesLine } from '@/ui/lesson';
import { GraphMap } from '@/ui/components/GraphMap';
import { graphMap, worthDrawing } from '@/ui/graph-map';
import { MathText } from '@/ui/components/MathText';

export type GraphViewProps = {
  graph: ModuleGraph;
  availability: ModuleAvailability[];
};

const KIND_LABEL: Record<GraphNodeView['node']['kind'], string> = {
  module: 'Lesson',
  detour: 'Side trip',
  remedial: 'Extra help',
  capstone: 'Final project',
};

function OpenCard({ view }: { view: GraphNodeView }): ReactNode {
  return (
    <li className="la-card" data-testid="graph-open-node" data-module-id={view.node.id} data-layer={view.layer}>
      <h3>
        <a href={`/modules/${view.node.id}`} data-testid="open-module">
          <MathText text={view.node.title} />
        </a>
      </h3>
      <p className="la-meta">
        <span>{KIND_LABEL[view.node.kind]}</span>
        <span>{minutesLine(view.node.estimatedMinutes)}</span>
        <MathText text={prereqSentence(view)} />
      </p>
      {/* WHY (F3): testing out is allowed from any module — the eligible flag only decides
          how loudly the offer is made, never whether it is on screen at all. */}
      {/* WHY: both of these links mean "skip the reading, go straight to the questions".
          Landing on the bare /eval URL threw that intent away, so the page the learner
          arrived at emphasised "Start the conversation" — the opposite of what they just
          clicked — and never said which of the two entries was running. */}
      {view.node.testOutEligible ? (
        <p>
          <a href={`/modules/${view.node.id}/eval?mode=test-out`} data-testid="test-out-link">
            You may already know this — go straight to the questions
          </a>
        </p>
      ) : (
        <p>
          <a
            href={`/modules/${view.node.id}/eval?mode=test-out`}
            className="la-quiet-link"
            data-testid="skip-to-eval"
          >
            Skip to the questions instead
          </a>
        </p>
      )}
    </li>
  );
}

function DoneCard({ view }: { view: GraphNodeView }): ReactNode {
  return (
    <li className="la-card" data-testid="graph-done-node" data-module-id={view.node.id}>
      <h3>
        <a href={`/modules/${view.node.id}`}>
          <MathText text={view.node.title} />
        </a>
      </h3>
      <p className="la-meta">
        {view.state === 'needs-review' ? 'Finished — worth a second look soon.' : 'Finished.'}
      </p>
    </li>
  );
}

function LaterCard({ view }: { view: GraphNodeView }): ReactNode {
  return (
    <li className="la-card" data-testid="graph-later-node" data-module-id={view.node.id}>
      <h3>
        <a href={`/modules/${view.node.id}`} data-testid="open-later-module">
          <MathText text={view.node.title} />
        </a>
      </h3>
      <p className="la-meta">
        <MathText text={stillToComeSentence(view)} />
        <span>Nothing stops you starting it now if you would rather.</span>
      </p>
    </li>
  );
}

/**
 * WHY the picture sits above the lists rather than replacing them: the lists are where the
 * lesson is opened, tested out of and read about. The map answers a different question —
 * where am I in this subject, and what did this grow out of — and answering it should not
 * cost the learner the cards. It opens by default and can be folded away.
 */
function MapPanel({ graph, availability }: GraphViewProps): ReactNode {
  const [shown, setShown] = useState(true);
  // A course with no prerequisites between its lessons has no picture to draw, and an
  // empty panel with a "hide the map" button beside it is worse than no panel.
  if (!worthDrawing(graphMap(graph, availability))) return null;

  return (
    <section className="la-card la-map-card" data-testid="graph-map-panel">
      <h2 className="la-header">
        The shape of this subject
        <button
          type="button"
          className="la-quiet-button"
          data-testid="toggle-graph-map"
          aria-expanded={shown}
          onClick={() => setShown((was) => !was)}
        >
          {shown ? 'Hide the map' : 'Show the map'}
        </button>
      </h2>
      {shown ? (
        <>
          <p className="la-muted">
            Each line means &ldquo;grew out of&rdquo;, not &ldquo;do this next&rdquo;. Any box here
            opens the lesson.
          </p>
          <GraphMap graph={graph} availability={availability} />
          <p className="la-map-key" data-testid="graph-map-key">
            <span className="la-map-legend">
              <span className="la-map-swatch" data-group="open" />
              Open now
            </span>
            <span className="la-map-legend">
              <span className="la-map-swatch" data-group="done" />
              Done
            </span>
            <span className="la-map-legend">
              <span className="la-map-swatch" data-group="later" />
              Suggested later
            </span>
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * WHY (F3 AC): everything open is shown side by side as a choice. There is no "next"
 * control anywhere in this view, because picking one of several open lessons is the
 * learner's decision, not the app's.
 */
export function GraphView({ graph, availability }: GraphViewProps): ReactNode {
  const full = graphLayout(graph, availability);
  /* WHY (F2): the capstone is not one lesson among many — it is the final project, and the
     topic page gives it its own card. Listing it here too made the same module appear twice
     on one screen, under two different names. */
  const notCapstone = (view: GraphNodeView): boolean => view.node.kind !== 'capstone';
  const open = full.open.filter(notCapstone);
  const layout = {
    ...full,
    open,
    done: full.done.filter(notCapstone),
    later: full.later.filter(notCapstone),
    isOpenChoice: open.length >= 2,
  };

  return (
    <div data-testid="graph-view" data-open-choice={layout.isOpenChoice ? 'yes' : 'no'}>
      <MapPanel graph={graph} availability={availability} />

      <section>
        <h2>Open to you now</h2>
        <p className="la-muted" data-testid="graph-choice-hint">
          {layout.open.length === 0
            ? 'Nothing is open right now.'
            : layout.open.length === 1
              ? 'One lesson is open at the moment.'
              : `${layout.open.length} lessons are open. Pick whichever one interests you most — any order is fine.`}
        </p>
        <ul className="la-list" data-testid="graph-open-list">
          {layout.open.map((view) => (
            <OpenCard key={view.node.id} view={view} />
          ))}
        </ul>
      </section>

      {layout.done.length === 0 ? null : (
        <section>
          <h2>Already done</h2>
          <ul className="la-list" data-testid="graph-done-list">
            {layout.done.map((view) => (
              <DoneCard key={view.node.id} view={view} />
            ))}
          </ul>
        </section>
      )}

      {layout.later.length === 0 ? null : (
        <section>
          <h2>Suggested for later</h2>
          <ul className="la-list" data-testid="graph-later-list">
            {layout.later.map((view) => (
              <LaterCard key={view.node.id} view={view} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
