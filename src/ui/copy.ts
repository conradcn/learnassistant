// FRACTAL: implements F5, F12 | component C10
import type { DashboardTopic } from '@/shapes';

export function progressLine(topic: DashboardTopic): string {
  const parts = [
    `${topic.completedCount} done`,
    `${topic.availableCount} open next`,
    `${topic.remainingCount} still ahead`,
  ];
  if (topic.needsReviewCount > 0) parts.push(`${topic.needsReviewCount} worth a second look`);
  return parts.join(' · ');
}

export function capstoneLine(topic: DashboardTopic): string {
  if (topic.capstone === 'n/a') return 'No final project for this subject.';
  if (topic.capstone === 'passed') return 'Final project: finished.';
  if (topic.capstone === 'in-review') return 'Final project: being looked over.';
  return 'Final project: not started yet.';
}
