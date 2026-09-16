// FRACTAL: implements F1, F2 | component C10
'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { GenerationProgress, Level, StagedSource, Topic } from '@/shapes';
import { createTopic, diagnosticTurn, startGeneration, subscribeProgress } from '@/ui/api-client';
import { DiagnosticPanel } from '@/ui/components/DiagnosticPanel';
import { useStartWork } from '@/ui/lesson';
import SourceMaterial from '@/ui/components/SourceMaterial';
import { MathText } from '@/ui/components/MathText';

const LEVELS: readonly { value: Level; label: string }[] = [
  { value: 'beginner', label: 'New to it' },
  { value: 'intermediate', label: 'Some of it is familiar' },
  { value: 'advanced', label: 'Comfortable, going deeper' },
  { value: 'self-described', label: 'Let me describe it myself' },
];

export default function NewTopicPage(): ReactNode {
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState<Level>('beginner');
  const [levelDetail, setLevelDetail] = useState('');
  const [purpose, setPurpose] = useState('');
  const [runDiagnostic, setRunDiagnostic] = useState(false);
  // WHY planning waits on it: the planner reads what the diagnostic found off the topic, so
  // offering "Plan the lessons" mid-conversation would plan around answers not given yet.
  const [diagnosing, setDiagnosing] = useState(false);
  const [knownCount, setKnownCount] = useState<number | null>(null);
  const [materials, setMaterials] = useState<StagedSource[]>([]);
  const [pastedMaterial, setPastedMaterial] = useState('');
  const [readingMaterial, setReadingMaterial] = useState(false);
  // WHY the source of the subject is tracked rather than just the text: material is a
  // pre-fill, never a decision. Once the learner has typed in the field it is theirs, and
  // a second upload must not quietly overwrite what they wrote.
  const [subjectFrom, setSubjectFrom] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const work = useStartWork();

  useEffect(() => {
    if (topic === null || !planning) return undefined;
    return subscribeProgress(topic.id, {
      onProgress: setProgress,
      onError: setError,
    });
  }, [topic, planning]);

  /**
   * A subject read out of the material fills the field only while the field is either
   * empty or still holding a previous inference. Typing in it makes it the learner's, and
   * from then on the material can disagree in the list without touching what they wrote.
   */
  const inferSubject = (inferred: string, from: string): void => {
    setSubject((current) => {
      if (current.trim().length === 0 || subjectFrom !== null) {
        setSubjectFrom(from);
        return inferred;
      }
      return current;
    });
  };

  const editSubject = (value: string): void => {
    setSubject(value);
    setSubjectFrom(null);
  };

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = subject.trim();
    if (trimmed.length === 0) {
      setError('Tell us what you want to learn first.');
      return;
    }
    setError(null);
    // The paste box is sent as text only when it is not already staged as a read: the
    // component drops its staged copy the moment the text changes, so exactly one of the
    // two carries it and the material is never attached twice.
    const staged = materials.some((m) => m.kind === 'pasted');
    void createTopic({
      subject: trimmed,
      level,
      levelDetail: levelDetail.trim().length === 0 ? undefined : levelDetail.trim(),
      purpose: purpose.trim(),
      runDiagnostic,
      confirmDuplicate: duplicateWarning,
      sourceIds: materials.map((m) => m.id),
      pastedMaterial: staged ? '' : pastedMaterial.trim(),
    }).then((response) => {
      if (response.ok) {
        setTopic(response.data);
        setDiagnosing(runDiagnostic);
        setDuplicateWarning(false);
        return;
      }
      if (response.error.code === 'conflict') {
        setDuplicateWarning(true);
        setError('You are already learning something with this name. Add it again anyway?');
        return;
      }
      setError(response.error.message);
    });
  };

  const plan = (): void => {
    if (topic === null) return;
    work.run(() => {
      setPlanning(true);
      return startGeneration(topic.id).then((response) => {
        if (!response.ok) {
          setPlanning(false);
          setError(response.error.message);
        }
      });
    });
  };

  return (
    <>
      <h1>Add something to learn</h1>
      {topic === null ? (
        <form onSubmit={create} className="la-card">
          <div className="la-field">
            <label htmlFor="subject">What do you want to learn?</label>
            <input
              id="subject"
              type="text"
              data-testid="subject"
              value={subject}
              onChange={(event) => editSubject(event.target.value)}
            />
            {subjectFrom === null ? null : (
              <p className="la-muted" data-testid="subject-inferred">
                Taken from {subjectFrom}. Change it if that is not what you are here for.
              </p>
            )}
          </div>

          <SourceMaterial
            materials={materials}
            onChange={setMaterials}
            pastedText={pastedMaterial}
            onPastedTextChange={setPastedMaterial}
            level={level}
            onSubjectInferred={inferSubject}
            onBusyChange={setReadingMaterial}
          />

          <fieldset>
            <legend>How much do you already know?</legend>
            {LEVELS.map((option) => (
              <label key={option.value} className="la-row">
                <input
                  type="radio"
                  name="level"
                  data-testid={`level-${option.value}`}
                  checked={level === option.value}
                  onChange={() => setLevel(option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>

          {level === 'self-described' ? (
            <div className="la-field">
              <label htmlFor="level-detail">In your own words</label>
              <input
                id="level-detail"
                type="text"
                data-testid="level-detail"
                value={levelDetail}
                onChange={(event) => setLevelDetail(event.target.value)}
              />
            </div>
          ) : null}

          <div className="la-field">
            <label htmlFor="purpose">What do you want to be able to do with it?</label>
            <textarea
              id="purpose"
              data-testid="purpose"
              rows={3}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </div>

          <label className="la-row">
            <input
              type="checkbox"
              data-testid="run-diagnostic"
              checked={runDiagnostic}
              onChange={(event) => setRunDiagnostic(event.target.checked)}
            />
            Ask me a few questions first, to skip what I already know
          </label>

          {/* WHY the button waits on a read but not on an upload existing: material is
              optional, so an empty form submits exactly as it always did — but a file
              still being read is a subject about to be pre-filled, and submitting through
              it would file the topic under whatever was in the box a moment earlier. */}
          <button
            type="submit"
            className="la-primary"
            data-testid="create-topic"
            disabled={readingMaterial}
          >
            {readingMaterial ? 'Reading your material…' : duplicateWarning ? 'Yes, add it again' : 'Add it'}
          </button>
        </form>
      ) : (
        <section className="la-card" data-testid="topic-created">
          <h2>
            <MathText text={topic.subject} /> is on your list
          </h2>
          {/* WHY (H2): `planning` is set on the click's own tick, before the server has
              answered, so the invitation and its button are gone for the whole in-flight
              window — a learner never sees "nothing has been written yet" next to a
              progress line, and cannot start the same work twice. Once a real count arrives
              it replaces this line rather than sitting above it, so the screen never carries
              two different answers to "how far along is it?". The idle invitation belongs to
              `!planning` alone: branching it on the progress count as well brought "nothing
              has been written yet" back the moment the first count landed, under a progress
              line and with no button left to act on. */}
          {diagnosing ? (
            <DiagnosticPanel
              step={(request) => diagnosticTurn(topic.id, request)}
              onDone={(result) => {
                setDiagnosing(false);
                setKnownCount(result.transcript.priorKnowledge.length);
              }}
            />
          ) : knownCount !== null && knownCount > 0 ? (
            <p className="la-muted" data-testid="diagnostic-done">
              Thanks — the plan will build on the {knownCount === 1 ? 'thing' : `${knownCount} things`} you
              already know.
            </p>
          ) : null}
          {diagnosing ? null : planning || work.awaiting ? (
            progress === null ? (
              <p className="la-muted" role="status" data-testid="planning-started">
                Work has started. You can carry on using the app while it runs.
              </p>
            ) : null
          ) : (
            <p>
              Nothing has been written yet. When you are ready, we can plan the lessons for you — it
              starts as soon as you say so.
            </p>
          )}
          <div className="la-row">
            {diagnosing || planning || work.awaiting ? null : (
              <button type="button" data-testid="plan-lessons" onClick={plan}>
                Plan the lessons
              </button>
            )}
            <Link href={`/topics/${topic.id}`} data-testid="go-to-topic">
              Go to <MathText text={topic.subject} />
            </Link>
          </div>
          {progress === null ? null : (
            <p data-testid="generation-progress">
              {progress.modulesDone} of {progress.modulesTotal} lessons written so far.
            </p>
          )}
        </section>
      )}

      {error === null && work.error === null ? null : (
        <p className="la-error" role="alert" data-testid="new-topic-error">
          {error ?? work.error}
        </p>
      )}
    </>
  );
}
