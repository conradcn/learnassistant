// FRACTAL: covers F3, F4 | type unit
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { exampleEvalTurn, type EvalTurn } from '@/shapes';
import { ChatPanel } from '@/ui/components/ChatPanel';

const reply = [
  'Close — two things to separate:',
  '',
  '- **Momentum** is conserved here.',
  '- *Energy* is not, because the collision is inelastic.',
  '',
  'So $p_1 + p_2$ stays fixed while `KE` drops.',
  '',
  '> Which of the two did your answer assume?',
].join('\n');

function turn(over: Partial<EvalTurn>): EvalTurn {
  return { ...exampleEvalTurn, assistLevel: null, angle: null, selfAssessment: null, ...over };
}

const turns: EvalTurn[] = [
  turn({ id: 't1', role: 'learner', text: 'Both are conserved, right?', mode: 'explanation' }),
  turn({ id: 't2', role: 'evaluator', text: reply, mode: 'question' }),
];

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('a tutor reply written in markdown', () => {
  // WHY this is the case worth a test: the evaluator writes the same markdown a lesson
  // does. Rendered as one text node it reached the learner as a wall of text with the
  // markers still in it.
  it('renders its structure rather than its markers', () => {
    render(
      <ChatPanel
        draftKey="chat-markdown-test"
        turns={turns}
        composerLabel="Your answer"
        sendLabel="Send"
        emptyMessage="Nothing yet"
        persist={() => Promise.reject(new Error('not used'))}
        onResult={() => {}}
      />,
    );

    const turn = screen.getAllByTestId('chat-turn-evaluator')[0];
    expect(turn.querySelectorAll('li')).toHaveLength(2);
    expect(turn.querySelector('strong')?.textContent).toBe('Momentum');
    expect(turn.querySelector('em')?.textContent).toBe('Energy');
    expect(turn.querySelector('code')?.textContent).toBe('KE');
    expect(turn.querySelector('blockquote')).not.toBeNull();
    // math in a reply is typeset for the same reason it is in a lesson
    expect(turn.innerHTML).toContain('katex');
    expect(turn.textContent).not.toContain('**');
    expect(turn.textContent).not.toContain('- ');
  });
});
