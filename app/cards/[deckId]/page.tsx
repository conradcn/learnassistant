// FRACTAL: implements F14 | component C10
'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { CardId, CardView, DeckId } from '@/shapes';
import { deckIdSchema } from '@/shapes';
import {
  addCard,
  deleteCard as deleteCardCall,
  deleteDeck,
  editCard,
  getDeck,
  getStudyQueue,
  importCards,
  type DeckDetail,
} from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { CardStudy } from '@/ui/components/CardStudy';
import { MathText } from '@/ui/components/MathText';
import { DECK_EMPTY_MESSAGE, dueLine, importLine, PASTE_HELP } from '@/ui/cards-copy';

const BAD_LINK = 'That link does not point at a deck we can open.';

export default function DeckPage({ params }: { params: Promise<{ deckId: string }> }): ReactNode {
  const raw = use(params).deckId;
  const parsed = deckIdSchema.safeParse(raw);
  const deckId: DeckId | null = parsed.success ? parsed.data : null;

  const [state, setState] = useState<LoadState<DeckDetail>>(LOADING);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [paste, setPaste] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [studying, setStudying] = useState<CardView[] | null>(null);
  const [editing, setEditing] = useState<CardId | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback((): void => {
    if (deckId === null) {
      setState({ status: 'error', error: { code: 'validation', message: BAD_LINK, correlationId: 'c_browser' } });
      return;
    }
    setState(LOADING);
    void getDeck(deckId).then((response) => setState(fromResponse(response, () => false)));
  }, [deckId]);

  useEffect(load, [load]);

  const submitCard = (event: FormEvent): void => {
    event.preventDefault();
    if (deckId === null) return;
    if (front.trim().length === 0 || back.trim().length === 0) {
      setError('A card needs something on the front and something on the back.');
      return;
    }
    setError(null);
    void addCard(deckId, { front: front.trim(), back: back.trim() }).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setFront('');
      setBack('');
      setMessage(importLine(response.data.cards.length, 0));
      setSkipped([]);
      load();
    });
  };

  const submitPaste = (event: FormEvent): void => {
    event.preventDefault();
    if (deckId === null || paste.trim().length === 0) return;
    setError(null);
    void importCards(deckId, paste).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      // WHY the paste box is only cleared when something landed: a paste that split into
      // nothing is a paste the learner still needs, to fix the separator and try again.
      if (response.data.cards.length > 0) setPaste('');
      setMessage(importLine(response.data.cards.length, response.data.skipped.length));
      setSkipped(response.data.skipped);
      load();
    });
  };

  const saveEdit = (card: CardView, nextFront: string, nextBack: string): void => {
    void editCard(card.id, { front: nextFront.trim(), back: nextBack.trim() }).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setEditing(null);
      load();
    });
  };

  const removeCard = (cardId: CardId): void => {
    void deleteCardCall(cardId).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      load();
    });
  };

  const study = (): void => {
    if (deckId === null) return;
    void getStudyQueue(deckId).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setStudying(response.data);
    });
  };

  const removeDeck = (): void => {
    if (deckId === null) return;
    void deleteDeck(deckId).then((response) => {
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      window.location.assign('/cards');
    });
  };

  return (
    <LoadStateBoundary state={state} label="this deck" emptyMessage={DECK_EMPTY_MESSAGE} onRetry={load}>
      {(detail): ReactNode => (
        <>
          <div className="la-page-head">
            <h1>{detail.deck.name}</h1>
            <button type="button" className="la-primary" data-testid="deck-study" onClick={study}>
              Study this deck
            </button>
          </div>
          <p className="la-row">
            <Link href="/cards">All decks</Link>
            <Link href="/">Back to your subjects</Link>
          </p>

          {error === null ? null : (
            <p className="la-error" role="alert" data-testid="deck-detail-error">
              {error}
            </p>
          )}

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

          <form className="la-card" onSubmit={submitCard} data-testid="card-form">
            <h2>Add a card</h2>
            <label className="la-field">
              <span>Front — what you will be asked</span>
              <input
                type="text"
                value={front}
                data-testid="card-front-input"
                onChange={(event): void => setFront(event.target.value)}
              />
            </label>
            <label className="la-field">
              <span>Back — what you have to remember</span>
              <input
                type="text"
                value={back}
                data-testid="card-back-input"
                onChange={(event): void => setBack(event.target.value)}
              />
            </label>
            <button type="submit" data-testid="card-add">
              Add it
            </button>
          </form>

          <form className="la-card" onSubmit={submitPaste} data-testid="paste-form">
            <h2>Paste a list</h2>
            <p className="la-muted">{PASTE_HELP}</p>
            <textarea
              rows={5}
              value={paste}
              data-testid="card-paste"
              onChange={(event): void => setPaste(event.target.value)}
            />
            <button type="submit" data-testid="card-import">
              Read it into cards
            </button>
            {message === null ? null : (
              <p className="la-muted" data-testid="import-message">
                {message}
              </p>
            )}
            {skipped.length === 0 ? null : (
              <ul className="la-list" data-testid="import-skipped">
                {skipped.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </form>

          {detail.cards.length === 0 ? (
            <p className="la-empty" data-testid="deck-empty">
              {DECK_EMPTY_MESSAGE}
            </p>
          ) : (
            <ul className="la-list" data-testid="card-list">
              {detail.cards.map((card) => (
                <li className="la-card" key={card.id} data-testid="card-row">
                  {editing === card.id ? (
                    <CardEditor card={card} onSave={saveEdit} onCancel={(): void => setEditing(null)} />
                  ) : (
                    <>
                      <MathText as="div" text={card.front} testId={`card-row-front-${card.id}`} />
                      <MathText as="div" text={card.back} className="la-muted" testId={`card-row-back-${card.id}`} />
                      <p className="la-meta">{dueLine(card)}</p>
                      <div className="la-row">
                        <button type="button" data-testid={`card-edit-${card.id}`} onClick={(): void => setEditing(card.id)}>
                          Change it
                        </button>
                        <button type="button" data-testid={`card-delete-${card.id}`} onClick={(): void => removeCard(card.id)}>
                          Remove it
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="la-row">
            {removing ? (
              <>
                <span className="la-muted">Remove this deck and its cards?</span>
                <button type="button" className="la-stop" data-testid="deck-delete-confirm" onClick={removeDeck}>
                  Yes, remove it
                </button>
                <button type="button" onClick={(): void => setRemoving(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" data-testid="deck-delete" onClick={(): void => setRemoving(true)}>
                Remove this deck
              </button>
            )}
          </div>
        </>
      )}
    </LoadStateBoundary>
  );
}

function CardEditor({
  card,
  onSave,
  onCancel,
}: {
  card: CardView;
  onSave: (card: CardView, front: string, back: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  return (
    <div data-testid={`card-editor-${card.id}`}>
      <label className="la-field">
        <span>Front</span>
        <input type="text" value={front} onChange={(event): void => setFront(event.target.value)} />
      </label>
      <label className="la-field">
        <span>Back</span>
        <input type="text" value={back} onChange={(event): void => setBack(event.target.value)} />
      </label>
      <div className="la-row">
        <button type="button" data-testid={`card-save-${card.id}`} onClick={(): void => onSave(card, front, back)}>
          Save it
        </button>
        <button type="button" onClick={onCancel}>
          Leave it
        </button>
      </div>
    </div>
  );
}
