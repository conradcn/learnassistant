// FRACTAL: implements F11 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DashboardTopic, Reflection } from '@/shapes';
import { getDashboard } from '@/ui/api-client';
import { LOADING, ready, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { ReflectionEditor } from '@/ui/components/ReflectionEditor';
import {
  entryStamp,
  entryText,
  JOURNAL_EDIT,
  JOURNAL_EMPTY_MESSAGE,
  JOURNAL_INTRO,
  JOURNAL_NO_SUBJECTS,
  JOURNAL_SUBJECT_LABEL,
  newestFirst,
} from '@/ui/journal-copy';

export default function JournalPage(): ReactNode {
  const [state, setState] = useState<LoadState<DashboardTopic[]>>(LOADING);
  const [subject, setSubject] = useState<string>('');
  const [entries, setEntries] = useState<Reflection[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback((): void => {
    setState(LOADING);
    void getDashboard().then((response) => {
      if (!response.ok) {
        setState({ status: 'error', error: response.error });
        return;
      }
      if (response.data.topics.length === 0) {
        setState({ status: 'empty' });
        return;
      }
      setSubject(response.data.topics[0].id);
      setState(ready(response.data.topics));
    });
  }, []);

  useEffect(load, [load]);

  const apply = (draft: Reflection): void => {
    setEntries((current) => [draft, ...current.filter((entry) => entry.id !== draft.id)]);
    setEditing(null);
  };

  const settle = (draftId: string, saved: Reflection | null): void => {
    setEntries((current) => {
      const without = current.filter((entry) => entry.id !== draftId);
      return saved === null ? without : [saved, ...without.filter((entry) => entry.id !== saved.id)];
    });
    // WHY: a note shows up optimistically under a local draft id, and the server's real
    // id arrives a moment later. If the learner opened that note for editing in between,
    // the id it is keyed on has just changed underneath them — without this the editor
    // silently closes and the typed edit is lost.
    setEditing((current) => (current === draftId ? (saved === null ? null : saved.id) : current));
  };

  return (
    <>
      <h1>Your notes</h1>
      <p className="la-row">
        <Link href="/">Back to your subjects</Link>
      </p>
      <p className="la-muted">{JOURNAL_INTRO}</p>
      <LoadStateBoundary
        state={state}
        label="your subjects"
        emptyMessage={JOURNAL_NO_SUBJECTS}
        onRetry={load}
      >
        {(topics): ReactNode => {
          const chosen = topics.find((topic) => topic.id === subject) ?? topics[0];
          return (
            <section data-testid="journal">
              <label className="la-row">
                <span>{JOURNAL_SUBJECT_LABEL}</span>
                <select
                  value={chosen.id}
                  data-testid="journal-subject"
                  onChange={(event): void => setSubject(event.target.value)}
                >
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.subject}
                    </option>
                  ))}
                </select>
              </label>
              <ReflectionEditor
                key={`new-${chosen.id}`}
                topicId={chosen.id}
                moduleId={null}
                existing={null}
                onApply={apply}
                onSettle={settle}
              />
              {entries.length === 0 ? (
                <p className="la-empty" data-testid="journal-empty">
                  {JOURNAL_EMPTY_MESSAGE}
                </p>
              ) : (
                <ul className="la-list" data-testid="journal-list">
                  {newestFirst(entries).map((entry) => (
                    <li className="la-card" key={entry.id} data-testid="journal-entry">
                      {editing === entry.id ? (
                        <ReflectionEditor
                          topicId={entry.topicId}
                          moduleId={entry.moduleId}
                          existing={entry}
                          onApply={apply}
                          onSettle={settle}
                        />
                      ) : (
                        <>
                          <p style={{ whiteSpace: 'pre-wrap' }} data-testid="journal-entry-text">
                            {entryText(entry)}
                          </p>
                          <p className="la-muted">{entryStamp(entry)}</p>
                          <button
                            type="button"
                            data-testid={`journal-edit-${entry.id}`}
                            onClick={(): void => setEditing(entry.id)}
                          >
                            {JOURNAL_EDIT}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        }}
      </LoadStateBoundary>
    </>
  );
}
