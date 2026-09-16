// FRACTAL: implements F1 | component C2
import { describe, it, expect } from 'vitest';
import { unwrapCliOutput } from '@/cli/run-session';

describe('CLI result envelope', () => {
  it('takes the lesson out of the envelope the CLI actually prints', () => {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: '{"learningGoals":["a"]}' };
    expect(unwrapCliOutput(envelope)).toEqual({ ok: true, output: { learningGoals: ['a'] } });
  });

  it('reads a fenced answer', () => {
    const envelope = { type: 'result', is_error: false, result: 'Here it is:\n```json\n{"learningGoals":["a"]}\n```\n' };
    expect(unwrapCliOutput(envelope)).toEqual({ ok: true, output: { learningGoals: ['a'] } });
  });

  it('refuses an envelope the CLI flagged as an error', () => {
    const out = unwrapCliOutput({ type: 'result', is_error: true, result: 'boom' });
    expect(out.ok).toBe(false);
  });

  it('refuses prose where JSON was asked for', () => {
    const out = unwrapCliOutput({ type: 'result', is_error: false, result: 'I could not do that.' });
    expect(out.ok).toBe(false);
  });

  // WHY: the real outline sessions answered with a prose plan whose FIRST fenced block
  // was a graph drawn in ASCII art. Taking that first fence and parsing only it threw
  // away the json block further down and reported the whole session as unreadable.
  it('skips an unlabelled fence to find the json one behind it', () => {
    const result = [
      '# A plan',
      '',
      'Graph shape:',
      '',
      '```',
      '1 -> 2 -> 3',
      '```',
      '',
      '```json',
      '{"drivingQuestion":"why?"}',
      '```',
    ].join('\n');
    expect(unwrapCliOutput({ type: 'result', is_error: false, result })).toEqual({
      ok: true,
      output: { drivingQuestion: 'why?' },
    });
  });

  it('finds a bare object that prose wrapped itself around', () => {
    const result = 'Sure - here is the plan:\n{"drivingQuestion":"why?"}\nHope that helps.';
    expect(unwrapCliOutput({ type: 'result', is_error: false, result })).toEqual({
      ok: true,
      output: { drivingQuestion: 'why?' },
    });
  });

  it('still refuses an answer with no JSON anywhere in it', () => {
    const result = '# A plan\n\n| # | Title |\n|---|---|\n| 1 | Entropy |\n';
    expect(unwrapCliOutput({ type: 'result', is_error: false, result }).ok).toBe(false);
  });

  it('passes a bare payload through untouched', () => {
    expect(unwrapCliOutput({ learningGoals: ['a'] })).toEqual({ ok: true, output: { learningGoals: ['a'] } });
  });

  /**
   * WHY these five: on the run this covers, seven of twelve lessons were lost to "the
   * session answered with text that was not the JSON we asked for". Capturing the raw
   * CLI output showed the answers were not prose and were not truncated mid-lesson —
   * they were complete lessons, every block and every learning goal present, missing
   * only the closing brace of the outer object. A 20KB lesson was being thrown away,
   * and a session the learner had authorised spent, over one character.
   */
  describe('an answer that stopped one character short', () => {
    const lesson = {
      learningGoals: ['Read $W \\in \\mathbb{R}^{k \\times d}$ as a type signature'],
      warmUp: { prompt: 'What shape is $Wx$?', expectedStruggle: 'Transposing by reflex.' },
      explanation: { kind: 'text', markdown: 'A matrix is a linear map.' },
      blocks: [{ kind: 'prose', markdown: 'Shapes compose.' }],
      visualization: { kind: 'none' },
      evalScript: { objectives: [], seedQuestions: [], angles: [], misconceptions: [], passCriteria: ['Names the shape.'] },
    };

    it('recovers a lesson whose final closing brace never arrived', () => {
      const whole = JSON.stringify(lesson);
      const result = whole.slice(0, -1);
      expect(unwrapCliOutput({ type: 'result', is_error: false, result })).toEqual({ ok: true, output: lesson });
    });

    it('recovers one that dropped a nested closer as well', () => {
      const whole = JSON.stringify(lesson);
      const result = whole.slice(0, whole.lastIndexOf(']'));
      const out = unwrapCliOutput({ type: 'result', is_error: false, result });
      expect(out.ok).toBe(true);
      expect((out as { output: typeof lesson }).output.blocks).toEqual(lesson.blocks);
    });

    // WHY: closing a string would save half a sentence as though the model meant to stop
    // there. An answer cut mid-word is a failure, and it stays one.
    it('refuses an answer cut off inside a string', () => {
      const whole = JSON.stringify(lesson);
      const result = whole.slice(0, whole.indexOf('linear map') + 6);
      expect(unwrapCliOutput({ type: 'result', is_error: false, result }).ok).toBe(false);
    });

    // WHY: a handful of missing closers is a dropped tail. A pile of them is an answer
    // that stopped in the middle, and guessing the rest of its shape would turn an
    // honest failure into a lesson with most of it silently missing.
    it('refuses an answer missing more closers than a dropped tail could explain', () => {
      const result = `{"a":${'{"b":['.repeat(9)}1`;
      expect(unwrapCliOutput({ type: 'result', is_error: false, result }).ok).toBe(false);
    });

    it('leaves an answer that already parses alone', () => {
      const result = JSON.stringify(lesson);
      expect(unwrapCliOutput({ type: 'result', is_error: false, result })).toEqual({ ok: true, output: lesson });
    });
  });
});
