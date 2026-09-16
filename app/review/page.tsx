// FRACTAL: implements F7 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getDashboard, getModule, getReviewsDue } from '@/ui/api-client';
import { LOADING, ready, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { ReviewQueue } from '@/ui/components/ReviewQueue';
import { REVIEW_EMPTY_MESSAGE, toCard, type ReviewCardView } from '@/ui/review-copy';

export default function ReviewPage(): ReactNode {
  const [state, setState] = useState<LoadState<ReviewCardView[]>>(LOADING);
  const [dueTotal, setDueTotal] = useState(0);

  const load = useCallback((): void => {
    setState(LOADING);
    void getReviewsDue().then(async (response) => {
      if (!response.ok) {
        setState({ status: 'error', error: response.error });
        return;
      }
      const items = response.data;
      setDueTotal((total) => (total > items.length ? total : items.length));
      if (items.length === 0) {
        setState({ status: 'empty' });
        return;
      }
      const titles = await Promise.all(
        items.map((item) => getModule(item.moduleId).then((r) => (r.ok ? r.data.module.title : null))),
      );
      setState(ready(items.map((item, i) => toCard(item, titles[i]))));
    });
    void getDashboard().then((response) => {
      if (response.ok) setDueTotal((total) => (total > response.data.reviewsDue ? total : response.data.reviewsDue));
    });
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <h1>Worth revisiting</h1>
      <p className="la-row">
        <Link href="/">Back to your subjects</Link>
        <Link href="/practice">Mixed practice instead</Link>
      </p>
      <LoadStateBoundary
        state={state}
        label="the lessons to revisit today"
        emptyMessage={REVIEW_EMPTY_MESSAGE}
        onRetry={load}
      >
        {(cards): ReactNode => <ReviewQueue cards={cards} dueTotal={dueTotal} />}
      </LoadStateBoundary>
    </>
  );
}
