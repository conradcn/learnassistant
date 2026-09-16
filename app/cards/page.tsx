// FRACTAL: implements F14 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CardView, DashboardTopic, DeckSummary, TopicId } from '@/shapes';
import { createDeck, getDashboard, getStudyQueue, listDecks } from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { CardStudy } from '@/ui/components/CardStudy';
import { CARDS_EMPTY_MESSAGE, CARDS_INTRO, deckLine } from '@/ui/cards-copy';

export default function CardsPage(): ReactNode {
  const [state, setState] = useState<LoadState<DeckSummary[]>>(LOADING);
  const [subjects, setSubjects] = useState<DashboardTopic[]>([]);
  const [name, setName] = useState('');
  const [topicId, setTopicId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [studying, setStudying] = useState<CardView[] | null>(null);

  const load = useCallback((): void => {
    setState(LOADING);
    void listDecks().then((response) => {
      setState(fromResponse(response, (decks) => decks.length === 0));
    });
    void getDashboard().then((response) => {
      if (response.ok) setSubjects(response.data.topics);
    });
  }, []);

  useEffect(load, [load]);

  const add = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setError(null);
    void createDeck(trimmed, topicId === '' ? null : (topicId as TopicId)).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setName('');
      load();
    });
  };

  const study = (): void => {
    setError(null);
    void getStudyQueue(null).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setStudying(response.data);
    });
  };

  return (
    <>
      <div className="la-page-head">
        <h1>Flash cards</h1>
        <button type="button" className="la-primary" data-testid="study-all" onClick={study}>
          Study everything due
        </button>
      </div>
      <p className="la-row">
        <Link href="/">Back to your subjects</Link>
        <Link href="/review">Lessons worth revisiting</Link>
      </p>
      <p className="la-muted">{CARDS_INTRO}</p>

      {studying === null ? null : (
        <CardStudy
          key={studying.map((card) => card.id).join('-')}
          cards={studying}
          onDone={(): void => {
            setStudying(null);
            load();
          }}
        />
      )}

      <form className="la-card" onSubmit={add} data-testid="deck-form">
        <h2>New deck</h2>
        <label className="la-field">
          <span>What is it for?</span>
          <input
            type="text"
            value={name}
            data-testid="deck-name"
            placeholder="Functional groups"
            onChange={(event): void => setName(event.target.value)}
          />
        </label>
        <label className="la-field">
          <span>Part of a subject? (optional)</span>
          <select
            value={topicId}
            data-testid="deck-topic"
            onChange={(event): void => setTopicId(event.target.value)}
          >
            <option value="">On its own</option>
            {subjects.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.subject}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" data-testid="deck-create">
          Make the deck
        </button>
        {error === null ? null : (
          <p className="la-error" role="alert" data-testid="deck-error">
            {error}
          </p>
        )}
      </form>

      <LoadStateBoundary state={state} label="your decks" emptyMessage={CARDS_EMPTY_MESSAGE} onRetry={load}>
        {(decks): ReactNode => (
          <ul className="la-list" data-testid="deck-list">
            {decks.map((summary) => (
              <li className="la-card" key={summary.deck.id} data-testid="deck-row">
                <h2>
                  <Link href={`/cards/${summary.deck.id}`}>{summary.deck.name}</Link>
                </h2>
                <p className="la-meta" data-testid={`deck-line-${summary.deck.id}`}>
                  {deckLine(summary)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </LoadStateBoundary>
    </>
  );
}
