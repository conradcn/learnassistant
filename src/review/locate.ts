// FRACTAL: implements F7, F8 | component C7
import { isoDateStringSchema, type ISODateString, type ModuleId, type ModuleNode, type Topic } from '@/shapes';
import type { ModuleSummary } from '@/store/modules';
import type { Store } from '@/store/open';

/** A module placed in its subject, with its content. */
export type LocatedModule = { topic: Topic; node: ModuleNode };
/** The same placement without the content blob — enough to name a lesson, not to open it. */
export type LocatedSummary = { topic: Topic; node: ModuleSummary };

export function isoAt(epochMs: number): ISODateString {
  return isoDateStringSchema.parse(new Date(epochMs).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'));
}

// WHY: the index is two queries — the topic list and one blob-free sweep of the module
// rows — so a queue of any depth costs the same as an empty one, and neither the query
// count nor the payload grows with how much lesson content the library holds. Building
// it out of `graph()` per topic kept the query count honest but parsed every lesson's
// content_json to read a title; callers that want the content ask for the one node.
export function moduleIndex(store: Store): Map<ModuleId, LocatedSummary> {
  const index = new Map<ModuleId, LocatedSummary>();
  const topics = new Map<string, Topic>();
  for (const row of store.topics.list()) {
    if ('degraded' in row) continue;
    topics.set(row.id, row);
  }
  for (const node of store.modules.index()) {
    const topic = topics.get(node.topicId);
    if (topic === undefined) continue;
    index.set(node.id, { topic, node });
  }
  return index;
}

export function locate(store: Store, moduleId: ModuleId): LocatedModule | null {
  const summary = moduleIndex(store).get(moduleId);
  if (summary === undefined) return null;
  const node = store.modules.node(moduleId);
  // WHY: the row can go between the index sweep and the read; a lesson that vanished
  // mid-request is simply not there, which is what every caller already handles.
  if (node === null) return null;
  return { topic: summary.topic, node };
}
