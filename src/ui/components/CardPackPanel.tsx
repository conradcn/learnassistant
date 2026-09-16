// FRACTAL: implements F14, F2 | component C10
'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { ApiResponse, CardDeck, CardPack, CardPackImport } from '@/shapes';
import { MathText } from '@/ui/components/MathText';
import {
  PACK_ADD_AGAIN_LABEL,
  PACK_ADD_LABEL,
  PACK_HEADING,
  packAddedLine,
  packSummaryLine,
} from '@/ui/cards-copy';

export type CardPackPanelProps = {
  pack: CardPack;
  /** The deck these cards are already in, if the learner has taken them before. */
  existingDeck: CardDeck | null;
  add: () => Promise<ApiResponse<CardPackImport>>;
};

/**
 * The pack of flash cards this lesson wrote for itself, offered rather than imposed.
 *
 * WHY the cards are shown before the button and not behind it: the learner is deciding
 * whether these belong on their shelf, and they cannot decide that about a number. WHY
 * both sides are visible here when F14's study screen hides the back — this is not a
 * retrieval, it is a look at what they are being offered, and hiding half of it would
 * make the choice blind without making anything harder to forget.
 */
export function CardPackPanel({ pack, existingDeck, add }: CardPackPanelProps): ReactNode {
  const [deck, setDeck] = useState<CardDeck | null>(existingDeck);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onAdd = (): void => {
    setBusy(true);
    setError(null);
    setMessage(null);
    void add().then((response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setDeck(response.data.deck);
      setMessage(packAddedLine(response.data.added.length, response.data.alreadyThere));
    });
  };

  return (
    <section className="la-card" data-testid="card-pack">
      <h3>{PACK_HEADING}</h3>
      <p className="la-muted" data-testid="card-pack-why">
        <MathText text={pack.why} />
      </p>
      <p className="la-muted">{packSummaryLine(pack.cards.length, pack.name)}</p>
      <ul data-testid="card-pack-list">
        {pack.cards.map((card) => (
          <li key={card.front}>
            <MathText text={card.front} /> — <MathText text={card.back} />
          </li>
        ))}
      </ul>
      <div className="la-row">
        <button type="button" data-testid="add-card-pack" onClick={onAdd} disabled={busy}>
          {deck === null ? PACK_ADD_LABEL : PACK_ADD_AGAIN_LABEL}
        </button>
        {deck === null ? null : (
          <Link href={`/cards/${deck.id}`} data-testid="card-pack-deck-link">
            Open “{deck.name}” in my cards
          </Link>
        )}
      </div>
      {message === null ? null : (
        <p className="la-notice" role="status" data-testid="card-pack-message">
          {message}
        </p>
      )}
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="card-pack-error">
          {error}
        </p>
      )}
    </section>
  );
}
