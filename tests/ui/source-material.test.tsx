// FRACTAL: covers F1 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, StagedSource, Topic } from '@/shapes';
import { exampleStagedSource, exampleTopic, sourceIdSchema } from '@/shapes';

const uploadSourceFile = vi.fn<(file: File) => Promise<ApiResponse<StagedSource>>>();
const stagePastedSource = vi.fn<(text: string) => Promise<ApiResponse<StagedSource>>>();
const createTopic = vi.fn<(intake: Record<string, unknown>) => Promise<ApiResponse<Topic>>>();

vi.mock('@/ui/api-client', () => ({
  uploadSourceFile: (file: File) => uploadSourceFile(file),
  stagePastedSource: (text: string) => stagePastedSource(text),
  createTopic: (intake: Record<string, unknown>) => createTopic(intake),
  startGeneration: vi.fn(),
  subscribeProgress: () => () => undefined,
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const SourceMaterial = (await import('@/ui/components/SourceMaterial')).default;
const NewTopicPage = (await import('../../app/topics/new/page')).default;
const { levelClash, materialSummary, noUnitsNote, oversizeNote } = await import('@/ui/source-material');

const SYLLABUS: StagedSource = {
  ...exampleStagedSource,
  filename: 'phys340-syllabus.pdf',
  inferredSubject: 'Statistical Mechanics',
  levelSignal: null,
  units: [
    { label: 'Unit 1', title: 'Microstates and macrostates' },
    { label: 'Unit 2', title: 'The Boltzmann distribution' },
  ],
};

function staged(over: Partial<StagedSource> = {}): StagedSource {
  return { ...SYLLABUS, ...over };
}

/** The component on its own, with the form state it is lifted out of held here. */
function renderBlock(over: Partial<StagedSource>[] = [], level: StagedSource['levelSignal'] = null) {
  const materials = over.map((o) => staged(o));
  const onChange = vi.fn();
  const view = render(
    <SourceMaterial
      materials={materials}
      onChange={onChange}
      pastedText=""
      onPastedTextChange={vi.fn()}
      level={level ?? 'beginner'}
      onSubjectInferred={vi.fn()}
      onBusyChange={vi.fn()}
    />,
  );
  return { ...view, onChange };
}

function chooseFile(name = 'phys340-syllabus.pdf'): void {
  const input = screen.getByTestId('source-file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['%PDF-1.4'], name, { type: 'application/pdf' })] } });
}

beforeEach(() => {
  uploadSourceFile.mockReset();
  stagePastedSource.mockReset();
  createTopic.mockReset();
  createTopic.mockResolvedValue({ ok: true, data: exampleTopic });
});

afterEach(cleanup);

describe('the sentences the intake form says about material', () => {
  it('summarises one document in the learner’s terms, singular and plural', () => {
    expect(materialSummary(staged({ pageCount: 3, charCount: 6120 }))).toBe('3 pages · 2 units · 6,120 characters');
    expect(materialSummary(staged({ pageCount: 1, units: [SYLLABUS.units[0]], charCount: 1 }))).toBe(
      '1 page · 1 unit · 1 character',
    );
    expect(materialSummary(staged({ pageCount: null, units: [] }))).toContain('no unit list found');
  });

  it('says a book disagrees with the chosen level without changing the level', () => {
    const note = levelClash([staged({ levelSignal: 'advanced' })], 'beginner');

    expect(note).not.toBeNull();
    expect(note).toContain('phys340-syllabus.pdf');
    // The promise made here is that the lessons stay where the learner put them.
    expect(note).toMatch(/level you chose/i);
    expect(levelClash([staged({ levelSignal: 'beginner' })], 'beginner')).toBeNull();
    // Nothing to disagree with when the learner described the level themselves.
    expect(levelClash([staged({ levelSignal: 'advanced' })], 'self-described')).toBeNull();
  });

  it('says what was left out of material longer than one course, and nothing when it fits', () => {
    expect(oversizeNote([staged({ truncated: true })])).toContain('phys340-syllabus.pdf');
    expect(oversizeNote([staged({ truncated: true })])).toMatch(/longer than one course/i);
    expect(oversizeNote([staged()])).toBeNull();
  });

  it('says when nothing it read looked like a list of units', () => {
    expect(noUnitsNote([staged({ units: [] })])).toMatch(/could not find a list of units/i);
    expect(noUnitsNote([staged()])).toBeNull();
    expect(noUnitsNote([])).toBeNull();
  });
});

describe('the material block on the intake form', () => {
  it('shows an upload back with its units, so the learner can see we read it', async () => {
    uploadSourceFile.mockResolvedValue({ ok: true, data: SYLLABUS });
    const { onChange } = renderBlock();

    chooseFile();

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const attached = onChange.mock.calls[0][0] as StagedSource[];
    expect(attached.map((m) => m.id)).toEqual([SYLLABUS.id]);
  });

  it('lists each attached document with what came out of it', () => {
    renderBlock([{}]);

    expect(screen.getByTestId('source-item').textContent).toContain('phys340-syllabus.pdf');
    expect(screen.getByTestId('source-units').textContent).toContain('Unit 1: Microstates and macrostates');
  });

  it('renders a refusal next to the paste box rather than only failing', async () => {
    uploadSourceFile.mockResolvedValue({
      ok: false,
      error: {
        code: 'validation',
        message: 'That PDF is a picture of a page, not text — a scan. Paste the text into the box below instead.',
        correlationId: 'c_test',
      },
    });
    renderBlock();

    chooseFile('scan.pdf');

    const shown = await screen.findByTestId('source-error');
    expect(shown.textContent).toMatch(/scan/i);
    expect(shown.textContent).toMatch(/paste/i);
    // The way past the refusal is on screen with it.
    expect(screen.getByTestId('source-paste')).not.toBeNull();
  });

  it('says the reading is happening here, on this computer', async () => {
    let release: ((r: ApiResponse<StagedSource>) => void) | undefined;
    uploadSourceFile.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderBlock();

    chooseFile();

    const status = await screen.findByTestId('source-reading');
    expect(status.textContent).toMatch(/nothing is sent anywhere/i);
    release?.({ ok: true, data: SYLLABUS });
    await waitFor(() => expect(screen.queryByTestId('source-reading')).toBeNull());
  });

  it('shows the level clash, the oversize note and the no-units note where they apply', () => {
    cleanup();
    renderBlock([{ truncated: true, units: [], levelSignal: 'advanced' }]);

    expect(screen.getByTestId('source-oversize')).not.toBeNull();
    expect(screen.getByTestId('source-no-units')).not.toBeNull();
    expect(screen.getByTestId('source-level-clash')).not.toBeNull();
  });
});

describe('the subject the material pre-fills', () => {
  it('fills an untouched field and says where it came from', async () => {
    uploadSourceFile.mockResolvedValue({ ok: true, data: SYLLABUS });
    render(<NewTopicPage />);

    chooseFile();

    await waitFor(() =>
      expect((screen.getByTestId('subject') as HTMLInputElement).value).toBe('Statistical Mechanics'),
    );
    expect(screen.getByTestId('subject-inferred').textContent).toContain('phys340-syllabus.pdf');
  });

  it('never overwrites a subject the learner typed', async () => {
    uploadSourceFile.mockResolvedValue({ ok: true, data: SYLLABUS });
    render(<NewTopicPage />);

    fireEvent.change(screen.getByTestId('subject'), { target: { value: 'What I actually want' } });
    chooseFile();

    await waitFor(() => expect(screen.getByTestId('source-item')).not.toBeNull());
    expect((screen.getByTestId('subject') as HTMLInputElement).value).toBe('What I actually want');
    expect(screen.queryByTestId('subject-inferred')).toBeNull();
  });

  it('stays corrected once the learner edits an inferred subject', async () => {
    uploadSourceFile.mockResolvedValue({ ok: true, data: SYLLABUS });
    render(<NewTopicPage />);

    chooseFile();
    await waitFor(() =>
      expect((screen.getByTestId('subject') as HTMLInputElement).value).toBe('Statistical Mechanics'),
    );
    fireEvent.change(screen.getByTestId('subject'), { target: { value: 'Thermodynamics, really' } });

    expect(screen.queryByTestId('subject-inferred')).toBeNull();
    expect((screen.getByTestId('subject') as HTMLInputElement).value).toBe('Thermodynamics, really');
  });
});

describe('both intake paths stay first-class', () => {
  it('submits an empty form with no material at all, exactly as before', async () => {
    render(<NewTopicPage />);

    fireEvent.change(screen.getByTestId('subject'), { target: { value: 'Knots' } });
    fireEvent.submit(screen.getByTestId('subject').closest('form') as HTMLFormElement);

    await waitFor(() => expect(createTopic).toHaveBeenCalled());
    const intake = createTopic.mock.calls[0][0];
    expect(intake.subject).toBe('Knots');
    expect(intake.sourceIds).toEqual([]);
    expect(intake.pastedMaterial).toBe('');
  });

  it('sends the staged ids and leaves the paste box out when it was already read', async () => {
    const pasted = staged({ id: sourceIdSchema.parse('sd_9fQ2xK4mZa71bC0d'), kind: 'pasted', filename: 'Pasted material' });
    uploadSourceFile.mockResolvedValue({ ok: true, data: SYLLABUS });
    stagePastedSource.mockResolvedValue({ ok: true, data: pasted });
    render(<NewTopicPage />);

    chooseFile();
    await waitFor(() => expect(screen.getByTestId('source-item')).not.toBeNull());
    fireEvent.change(screen.getByTestId('source-paste'), { target: { value: 'Unit 3: Free energy' } });
    fireEvent.click(screen.getByTestId('source-read-paste'));
    await waitFor(() => expect(screen.getAllByTestId('source-item')).toHaveLength(2));

    fireEvent.submit(screen.getByTestId('subject').closest('form') as HTMLFormElement);

    await waitFor(() => expect(createTopic).toHaveBeenCalled());
    const intake = createTopic.mock.calls[0][0];
    expect(intake.sourceIds).toEqual([SYLLABUS.id, pasted.id]);
    // Exactly one of the two carries the pasted text, so it is never attached twice.
    expect(intake.pastedMaterial).toBe('');
  });

  it('sends the paste box as text when the learner never pressed read', async () => {
    render(<NewTopicPage />);

    fireEvent.change(screen.getByTestId('subject'), { target: { value: 'Statistical mechanics' } });
    fireEvent.change(screen.getByTestId('source-paste'), { target: { value: 'Unit 1: Microstates\nUnit 2: Entropy' } });
    fireEvent.submit(screen.getByTestId('subject').closest('form') as HTMLFormElement);

    await waitFor(() => expect(createTopic).toHaveBeenCalled());
    const intake = createTopic.mock.calls[0][0];
    expect(intake.sourceIds).toEqual([]);
    expect(intake.pastedMaterial).toBe('Unit 1: Microstates\nUnit 2: Entropy');
  });
});
