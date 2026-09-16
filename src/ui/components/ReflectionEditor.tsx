// FRACTAL: implements F11 | component C10
'use client';
import { useId, useState, type ReactNode } from 'react';
import { isoDateStringSchema, type ISODateString, type ModuleId, type Reflection, type TopicId } from '@/shapes';
import { editReflection, saveReflection } from '@/ui/api-client';
import { JOURNAL_EDIT_SAVE, JOURNAL_NOTE_LABEL, JOURNAL_PLACEHOLDER, JOURNAL_SAVE } from '@/ui/journal-copy';

export type ReflectionEditorProps = {
  topicId: TopicId;
  moduleId: ModuleId | null;
  existing: Reflection | null;
  onApply: (draft: Reflection) => void;
  onSettle: (draftId: string, saved: Reflection | null) => void;
};

let draftCounter = 0;

export function nextDraftId(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

function nowStamp(): ISODateString {
  return isoDateStringSchema.parse(new Date().toISOString());
}

/**
 * WHY (F11): the note appears in the journal on the same tick it is saved, and the typed
 * text is never taken away — a failed save leaves it in the box with the reason beside it.
 */
export function ReflectionEditor({
  topicId,
  moduleId,
  existing,
  onApply,
  onSettle,
}: ReflectionEditorProps): ReactNode {
  const fieldId = useId();
  const [text, setText] = useState(existing === null ? '' : existing.text);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const value = text;
    if (value.length === 0) return;
    setError(null);
    const draftId = existing === null ? nextDraftId() : existing.id;
    const stamp = nowStamp();
    onApply({
      id: draftId,
      topicId,
      moduleId,
      text: value,
      createdAt: existing === null ? stamp : existing.createdAt,
      updatedAt: stamp,
    });
    if (existing === null) setText('');
    const request =
      existing === null
        ? saveReflection({ topicId, moduleId, text: value })
        : editReflection(existing.id, value);
    void request.then((response) => {
      if (response.ok) {
        onSettle(draftId, response.data);
        return;
      }
      onSettle(draftId, null);
      setText(value);
      setError(response.error.message);
    });
  };

  return (
    <div className="la-card" data-testid="reflection-editor">
      <div className="la-field">
        <label htmlFor={fieldId}>{JOURNAL_NOTE_LABEL}</label>
        <textarea
          id={fieldId}
          rows={4}
          value={text}
          placeholder={JOURNAL_PLACEHOLDER}
          data-testid="reflection-text"
          onChange={(event): void => setText(event.target.value)}
        />
      </div>
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="reflection-error">
          {error}
        </p>
      )}
      <div className="la-row">
        <button type="button" data-testid="reflection-save" onClick={submit}>
          {existing === null ? JOURNAL_SAVE : JOURNAL_EDIT_SAVE}
        </button>
      </div>
    </div>
  );
}
