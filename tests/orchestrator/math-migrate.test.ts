// FRACTAL: covers F3 | type unit
import { describe, expect, it } from 'vitest';
import { classifySpan, convertContent, convertMarkdown, toLatex, validateMath } from '../../scripts/migrate-math.mjs';

describe('toLatex', () => {
  it('maps Unicode transposes, roots and relations', () => {
    expect(toLatex('Qᵀ = Q⁻¹')).toBe('Q^\\top = Q^{-1}');
    expect(toLatex('‖x‖₂')).toBe('\\|x\\|_2');
    expect(toLatex('σ₁ ≥ σ₂ ≥ ... ≥ 0')).toBe('\\sigma _1 \\ge \\sigma _2 \\ge \\dots \\ge 0');
  });

  // WHY: mapping Unicode scripts one at a time yields `M_i_i`, which is a LaTeX
  // double-subscript error, and `A_i_j`, which is not the tensor the author wrote.
  it('collapses a run of sub/superscripts into one group', () => {
    expect(toLatex('Mᵢᵢ')).toBe('M_{ii}');
    expect(toLatex('Aᵢⱼ')).toBe('A_{ij}');
    expect(toLatex('W_ij')).toBe('W_{ij}');
  });

  // WHY: `U\SigmaV^\top` is not `U \Sigma V^\top` — it is an undefined command, and KaTeX
  // does not reliably reject it, so the lesson would render wrong rather than loudly broken.
  it('never lets a command run into the following letter', () => {
    expect(toLatex('M = UΣVᵀ')).toBe('M = U\\Sigma V^\\top');
    expect(toLatex('wᵀAw')).toBe('w^\\top Aw');
  });

  // WHY: Σ is the summation operator indexed by i/j, and the SVD's singular-value matrix
  // otherwise. Reading one as the other changes what the lesson claims.
  it('distinguishes summation from the SVD matrix', () => {
    expect(toLatex('Σᵢ Mᵢᵢ')).toBe('\\sum _i M_{ii}');
    expect(toLatex('M_k = U_k Σ_k V_kᵀ')).toBe('M_k = U_k \\Sigma _k V_k^\\top');
    expect(toLatex('Σ')).toBe('\\Sigma');
  });

  it('sets function names upright without matching them inside words', () => {
    expect(toLatex('tr(M)')).toBe('\\operatorname{tr}(M)');
    expect(toLatex('the matrix A')).toBe('the matrix A');
  });

  it('reads a bare x as multiplication only inside a dimension group', () => {
    expect(toLatex('(d x n)(n x 1) -> (d x 1)')).toBe('(d \\times n)(n \\times 1) \\to (d \\times 1)');
    expect(toLatex('x^T y')).toBe('x^\\top y');
  });
});

describe('classifySpan', () => {
  it('keeps genuine code as code', () => {
    expect(classifySpan("einsum('ik,jk->ij', Q, K)")).toBe('code');
    expect(classifySpan("'bik,bkj->bij'")).toBe('code');
    expect(classifySpan('(d_out, d_in)')).toBe('code');
    expect(classifySpan('(d_in,)')).toBe('code');
  });

  it('treats symbols and formulas as maths', () => {
    expect(classifySpan('wᵀAw')).toBe('math');
    expect(classifySpan('A')).toBe('math');
    expect(classifySpan('Y = XW')).toBe('math');
  });
});

describe('convertMarkdown', () => {
  it('converts a backtick formula and leaves a fenced block alone', () => {
    expect(convertMarkdown('the value `wᵀAw` matters')).toBe('the value $w^\\top Aw$ matters');
    const fenced = '```\nsoftmax(QK^T)\n```';
    expect(convertMarkdown(fenced)).toBe(fenced);
  });

  it('promotes a standalone bold formula line to display maths', () => {
    expect(convertMarkdown('**L(w) = wᵀAw − 2bᵀw**')).toBe('$$L(w) = w^\\top Aw - 2b^\\top w$$');
  });

  it('leaves a bold line that is not a formula as emphasis', () => {
    expect(convertMarkdown('**Why worked examples**')).toBe('**Why worked examples**');
  });

  // WHY (the scope limit this migration deliberately accepts): maths loose in prose is not
  // delimited by the author, so its boundaries cannot be found lexically and it is skipped.
  it('does not touch bare maths in prose', () => {
    const prose = 'Compute the gradient of x^T A x by hand.';
    expect(convertMarkdown(prose)).toBe(prose);
  });
});

describe('convertContent', () => {
  it('walks every learner-facing field and produces parseable maths', async () => {
    const content = {
      learningGoals: ['Compute `wᵀAw` by hand'],
      warmUp: { prompt: 'What is `∇L(w)`?', expectedStruggle: 'forgetting the `2Aw` term' },
      explanation: { kind: 'text', markdown: 'Recall `M = UΣVᵀ`.' },
      visualization: { kind: 'table', headers: ['`σ₁`'], rows: [['`σ₂`']], caption: 'about `‖M‖_F`' },
      evalScript: {
        objectives: ['state `Qᵀ = Q⁻¹`'],
        seedQuestions: [],
        angles: [],
        misconceptions: [{ id: 'm1', statement: '`AB ≠ BA`', correction: 'order matters' }],
        passCriteria: [],
      },
    };
    const out = convertContent(content);
    expect(out.learningGoals[0]).toBe('Compute $w^\\top Aw$ by hand');
    expect(out.warmUp.prompt).toBe('What is $\\nabla L(w)$?');
    expect(out.explanation.markdown).toBe('Recall $M = U\\Sigma V^\\top$.');
    expect(out.visualization.headers[0]).toBe('$\\sigma _1$');
    expect(out.evalScript.misconceptions[0].statement).toBe('$AB \\ne BA$');
    expect(await validateMath(out)).toEqual([]);
  });

  it('reports maths that would not typeset', async () => {
    const broken = { learningGoals: ['$\\frac{1$'], warmUp: null, evalScript: null };
    expect((await validateMath(broken)).length).toBe(1);
  });
});
