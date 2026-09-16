// FRACTAL: implements F1 | component C10
'use client';
import { useState, type ChangeEvent, type ReactNode } from 'react';
import type { Level, StagedSource } from '@/shapes';
import { stagePastedSource, uploadSourceFile } from '@/ui/api-client';
import { levelClash, materialSummary, noUnitsNote, oversizeNote } from '@/ui/source-material';

/** What the file picker offers. The server checks the bytes; this only saves a round trip. */
const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,text/plain,text/markdown,application/pdf';
/** Matches `sourceIds.max(10)` on the intake shape, so the form refuses before the API does. */
const MAX_MATERIALS = 10;

export type SourceMaterialProps = {
  materials: StagedSource[];
  onChange: (materials: StagedSource[]) => void;
  /** The paste box is lifted so the form can send text the learner never pressed "read" on. */
  pastedText: string;
  onPastedTextChange: (text: string) => void;
  level: Level;
  /** Called with a subject read out of the material, for the form to pre-fill with. */
  onSubjectInferred: (subject: string, from: string) => void;
  /** True while a read is in flight, so the form can hold "Add it" until it lands. */
  onBusyChange: (busy: boolean) => void;
};

/**
 * The optional half of intake: the syllabus, textbook or slide deck the learner was
 * actually assigned.
 *
 * WHY it is optional and quiet: a learner with nothing to upload must reach "Add it" on
 * exactly the path they had before, so this whole block is skippable and never blocks the
 * submit button when it is empty.
 *
 * WHY the reading happens here rather than at submit: extraction is local and free, so the
 * learner can see what we got — the units, the page count, the subject we read off it —
 * while they are still on the form, and correct the subject before a single session is
 * dispatched. A read that fails says so here too, next to the paste box that is the way
 * around it.
 */
export default function SourceMaterial({
  materials,
  onChange,
  pastedText,
  onPastedTextChange,
  level,
  onSubjectInferred,
  onBusyChange,
}: SourceMaterialProps): ReactNode {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The exact text that was staged, so an edit after the read is not attached twice: the
  // staged copy is dropped and the new text rides along on the intake payload instead.
  const [stagedPaste, setStagedPaste] = useState<string | null>(null);

  const busy = (next: boolean): void => {
    setReading(next);
    onBusyChange(next);
  };

  const accept = (staged: StagedSource, next: StagedSource[]): void => {
    onChange(next);
    if (staged.inferredSubject !== null) {
      onSubjectInferred(staged.inferredSubject, staged.filename);
    }
  };

  const addFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])];
    // Clearing the picker is what lets the same file be chosen again after a failure.
    event.target.value = '';
    if (chosen.length === 0) return;
    if (materials.length + chosen.length > MAX_MATERIALS) {
      setError(
        `That is more than ${MAX_MATERIALS} files. Upload the syllabus and the chapters you need.`,
      );
      return;
    }
    setError(null);
    busy(true);

    // WHY one at a time: each read holds a whole PDF in memory, and a learner dropping six
    // textbooks at once should not decide how much of it is resident at once.
    void (async (): Promise<void> => {
      let current = materials;
      for (const file of chosen) {
        const response = await uploadSourceFile(file);
        if (!response.ok) {
          setError(response.error.message);
          break;
        }
        current = [...current, response.data];
        accept(response.data, current);
      }
      busy(false);
    })();
  };

  const readPaste = (): void => {
    const text = pastedText.trim();
    if (text.length === 0) {
      setError('Paste the syllabus into the box first.');
      return;
    }
    setError(null);
    busy(true);
    void stagePastedSource(text).then((response) => {
      busy(false);
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      // A previous read of the same box is replaced, not stacked.
      const kept = materials.filter((m) => m.kind !== 'pasted');
      accept(response.data, [...kept, response.data]);
      setStagedPaste(text);
    });
  };

  const editPaste = (text: string): void => {
    onPastedTextChange(text);
    if (stagedPaste !== null && text.trim() !== stagedPaste) {
      // The staged copy no longer matches what is on screen, so it stops being what gets
      // attached; the text in the box is sent instead and the server reads it there.
      onChange(materials.filter((m) => m.kind !== 'pasted'));
      setStagedPaste(null);
    }
  };

  const remove = (id: string): void => {
    const dropped = materials.find((m) => m.id === id);
    if (dropped !== undefined && dropped.kind === 'pasted') {
      setStagedPaste(null);
      onPastedTextChange('');
    }
    onChange(materials.filter((m) => m.id !== id));
  };

  const clash = levelClash(materials, level);
  const oversize = oversizeNote(materials);
  const noUnits = noUnitsNote(materials);

  return (
    <fieldset data-testid="source-material">
      <legend>Have the material already?</legend>
      <p className="la-muted">
        If you were given a syllabus, a textbook or a set of slides, add it and the lessons will
        cover what it covers, in its words. Skip this and we research the subject from scratch.
      </p>

      <div className="la-field">
        <label htmlFor="source-file">Upload a file (PDF, Word, text or Markdown)</label>
        <input
          id="source-file"
          type="file"
          multiple
          accept={ACCEPT}
          data-testid="source-file"
          disabled={reading}
          onChange={addFiles}
        />
      </div>

      <div className="la-field">
        <label htmlFor="source-paste">Or paste it here</label>
        <textarea
          id="source-paste"
          rows={4}
          data-testid="source-paste"
          value={pastedText}
          onChange={(event) => editPaste(event.target.value)}
        />
        <div className="la-row">
          <button
            type="button"
            data-testid="source-read-paste"
            disabled={reading}
            onClick={readPaste}
          >
            Read this text
          </button>
          <span className="la-muted">
            You can also just leave it there — we read it when you add the subject.
          </span>
        </div>
      </div>

      {reading ? (
        <p className="la-muted" role="status" data-testid="source-reading">
          Reading it here on this computer. Nothing is sent anywhere.
        </p>
      ) : null}

      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="source-error">
          {error}
        </p>
      )}

      {materials.length === 0 ? null : (
        <ul className="la-list" data-testid="source-list">
          {materials.map((source) => (
            <li key={source.id} data-testid="source-item">
              <strong>{source.filename}</strong>
              <span className="la-muted"> — {materialSummary(source)}</span>
              {source.units.length === 0 ? null : (
                <ul className="la-list" data-testid="source-units">
                  {source.units.slice(0, 8).map((unit) => (
                    <li key={`${unit.label}:${unit.title}`}>
                      {unit.label === unit.title ? unit.title : `${unit.label}: ${unit.title}`}
                    </li>
                  ))}
                  {source.units.length > 8 ? (
                    <li className="la-muted">and {source.units.length - 8} more</li>
                  ) : null}
                </ul>
              )}
              <button
                type="button"
                className="la-btn-link"
                data-testid={`source-remove-${source.id}`}
                onClick={() => remove(source.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {noUnits === null ? null : (
        <p className="la-muted" data-testid="source-no-units">
          {noUnits}
        </p>
      )}
      {oversize === null ? null : (
        <p className="la-warn" data-testid="source-oversize">
          {oversize}
        </p>
      )}
      {clash === null ? null : (
        <p className="la-warn" data-testid="source-level-clash">
          {clash}
        </p>
      )}
    </fieldset>
  );
}
