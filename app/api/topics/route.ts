// FRACTAL: implements F1 | component C9
import { topicIntakeRequestSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import { dashboardFor } from '@/api/dashboard-source';
import { attachSources } from '@/api/source';
import { ensureTopicDir } from '@/orchestrator/topic-state';

export const POST = route(async (req) => {
  const intake = await parseBody(req, topicIntakeRequestSchema);
  const svc = requireStore();
  const topic = svc.store.topics.create({
    subject: intake.subject,
    level: intake.level,
    levelDetail: intake.levelDetail,
    purpose: intake.purpose,
    diagnostic: null,
    allowDuplicate: intake.confirmDuplicate,
  });
  // WHY the directory is made here and nowhere later: a subject that has a row is allowed
  // to have a folder, and after this point nothing is — a run whose subject was deleted
  // underneath it must not be able to put one back (see TopicDeletedError).
  ensureTopicDir(svc.dataRoot, topic.id);
  // WHY the material is claimed after the topic exists and not before: until there is a
  // topic id there is no directory to confine it to. Staging is where it waits for one.
  attachSources(svc.store, svc.dataRoot, topic.id, intake.sourceIds, intake.pastedMaterial);
  return topic;
});

export const GET = route(async () => {
  const svc = requireStore();
  return dashboardFor(svc.store, svc.dataRoot);
});
