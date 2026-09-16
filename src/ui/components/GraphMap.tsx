// FRACTAL: implements F3, F5 | component C10
'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ModuleAvailability, ModuleGraph } from '@/shapes';
import { fitScale, graphMap, worthDrawing, MAP_GEOMETRY, type GraphMap as MapShape, type MapNode } from '@/ui/graph-map';
import { MathText } from '@/ui/components/MathText';

export type GraphMapProps = {
  graph: ModuleGraph;
  availability: ModuleAvailability[];
};

/** What the box says under its title. Short enough to sit on one line at 176px. */
function stateLine(node: MapNode): string {
  if (node.group === 'open') return node.view.state === 'in-progress' ? 'Started' : 'Open now';
  if (node.group === 'done') {
    if (node.view.state === 'needs-review') return 'Worth a second look';
    return 'Done';
  }
  return 'Later on';
}

/** The sentence a screen reader gets, since the picture itself carries no order. */
function nodeLabel(node: MapNode): string {
  const prereqs = node.view.prereqTitles;
  const roots = prereqs.length === 0 ? 'a starting point' : `builds on ${prereqs.join(' and ')}`;
  return `${node.view.node.title} — ${stateLine(node).toLowerCase()}, ${roots}`;
}

/** The share of the window the map may take before it starts shrinking to fit. */
const HEIGHT_BUDGET = 0.58;
/** Below this the panel is not worth a picture at all; it is also the floor a phone hits. */
const MIN_HEIGHT = 260;

/**
 * WHY the size is measured rather than assumed: the panel's width depends on the page
 * gutter, the sidebar and the window, none of which this component can know at render
 * time — and a map drawn wider than its panel simply ran off the screen.
 */
function useFitScale(map: MapShape): { ref: React.RefObject<HTMLDivElement | null>; scale: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const height = Math.max(MIN_HEIGHT, window.innerHeight * HEIGHT_BUDGET);
      setScale(fitScale(map, { width: element.clientWidth, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [map]);

  return { ref, scale };
}

/**
 * WHY the boxes are HTML and only the lines are SVG: a lesson title is real prose that has
 * to wrap, be searchable and be a link the browser treats as one. <text> in SVG does none
 * of those. The two layers share one pixel coordinate space, so they line up exactly.
 *
 * WHY (F3): nothing in the picture is a "next" arrow. The lines mean "grew out of", and
 * every box on screen — done, open or later — is a link the learner may take now.
 */
export function GraphMap({ graph, availability }: GraphMapProps): ReactNode {
  const map = graphMap(graph, availability);
  const fit = useFitScale(map);
  if (!worthDrawing(map)) return null;
  const { nodeWidth, nodeHeight } = MAP_GEOMETRY;

  return (
    <div
      className="la-map-scroll"
      data-testid="graph-map"
      data-scale={fit.scale.toFixed(2)}
      ref={fit.ref}
    >
      {/* The scaled box reserves exactly the room the shrunk drawing occupies, so the
          panel below it does not sit under a transform's leftover empty space. */}
      <div className="la-map-fit" style={{ width: map.width * fit.scale, height: map.height * fit.scale }}>
        <div
          className="la-map"
          style={{ width: map.width, height: map.height, transform: `scale(${fit.scale})` }}
        >
        <svg
          className="la-map-edges"
          width={map.width}
          height={map.height}
          viewBox={`0 0 ${map.width} ${map.height}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id="la-map-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.45" />
            </linearGradient>
          </defs>
          {map.edges.map((edge) => (
            <path
              key={`${edge.from}>${edge.to}`}
              d={edge.path}
              className={edge.pending ? 'la-map-edge la-map-edge-pending' : 'la-map-edge'}
              data-from={edge.from}
              data-to={edge.to}
            />
          ))}
        </svg>
        <ul className="la-map-nodes">
          {map.nodes.map((node) => (
            <li
              key={node.view.node.id}
              className="la-map-node"
              data-testid="graph-map-node"
              data-module-id={node.view.node.id}
              data-group={node.group}
              style={{
                left: node.x - nodeWidth / 2,
                top: node.y - nodeHeight / 2,
                width: nodeWidth,
                height: nodeHeight,
              }}
            >
              <a href={`/modules/${node.view.node.id}`} aria-label={nodeLabel(node)}>
                <span className="la-map-title">
                  <MathText text={node.view.node.title} />
                </span>
                <span className="la-map-state">{stateLine(node)}</span>
              </a>
            </li>
          ))}
        </ul>
        </div>
      </div>
    </div>
  );
}
