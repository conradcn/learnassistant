// FRACTAL: implements F3, F2 | component C10
'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { TopicId } from '@/shapes';
import { MathText } from '@/ui/components/MathText';

export type NotWrittenCardProps = {
  title: string;
  topicId: TopicId;
  onWriteNow: () => void;
};

/**
 * WHY (H3): a lesson that is planned but not yet written is a normal step in the two-step
 * plan-then-write flow, not a fault. It used to share the damaged-content card, so the
 * ordinary state after planning told every learner their saved copy was broken — with no
 * mention of the button on the subject page that actually writes the lessons.
 */
export function NotWrittenCard({ title, topicId, onWriteNow }: NotWrittenCardProps): ReactNode {
  return (
    <section className="la-card" data-testid="not-written-card" role="status">
      <h3>This lesson hasn&apos;t been written yet</h3>
      <p>
        “<MathText text={title} />” is part of your plan, but the writing session for it
        hasn&apos;t run. You can write this one now, or go back and write the whole set together.
      </p>
      <div className="la-row">
        <button type="button" data-testid="write-this-lesson" onClick={onWriteNow}>
          Write this lesson
        </button>
        <Link href={`/topics/${topicId}`}>Back to the subject</Link>
      </div>
    </section>
  );
}
