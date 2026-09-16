/**
 * One-off: run the curriculum repair over the topic that was generated before the
 * repair loop existed. It applies the fixes the consistency check's findings asked for
 * and then retires the findings, which is what the loop now does automatically.
 *
 * Each edit below is annotated with the finding it answers. Findings that turned out to
 * be already satisfied by the lessons on disk are named at the bottom and edited nothing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1'), '..');
const TOPIC = 't_wtdukAXY981t37pa';
const MODULES = path.join(ROOT, 'data', 'topics', TOPIC, 'modules');
const db = new Database(path.join(ROOT, 'data', 'learn.db'));

const ID = {
  1: 'm_wXTlG88q3TXmKSjj', 2: 'm_nDiLoIsADV0YPe7T', 3: 'm_mWtRKEqLLC5BgDqY',
  4: 'm_oLC4Uo80q3HFCHxQ', 5: 'm_3Qlf6azJ1kK9hyJV', 6: 'm_TL4e2GZdp2kwipn6',
  7: 'm_npe2u4FNVTk1a4DF', 8: 'm_EX3dqYbNzLWXs7CP', 9: 'm_vrRL6sOO5Ki18zyN',
  10: 'm_hRVhH8MGzqVvkYA5', 11: 'm_l4TbArTKU1Bxachh', 12: 'm_dccVf4HmVJk8MH3i',
  13: 'm_Ypn0UcxhrDPLczGB',
};

function fileFor(n) {
  return path.join(MODULES, ID[n], 'content.json');
}

function edit(n, fn) {
  const p = fileFor(n);
  const env = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = env.content.blocks ? env.content.blocks.length : 0;
  fn(env.content);
  const after = env.content.blocks ? env.content.blocks.length : 0;
  const content = env.content;
  const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  fs.writeFileSync(p, JSON.stringify({ contentVersion: 1, digest, content }));
  db.prepare('UPDATE module_nodes SET content_json = ? WHERE id = ?').run(JSON.stringify(content), ID[n]);
  console.log(`lesson ${String(n).padStart(2)}: blocks ${before} -> ${after}, goals ${content.learningGoals.length}`);
}

const insert = (c, i, ...b) => c.blocks.splice(i, 0, ...b);

/* Lesson 1 — findings: the driving question's two equations are the advertised payoff of
 * this lesson, but every symbol carrying their meaning is defined six to nine lessons
 * later and nothing states that contract; and the transpose / index / batched-shape
 * conventions the whole course leans on are claimed by no lesson. */
edit(1, (c) => {
  insert(c, 1, {
    kind: 'prose',
    markdown:
      "One contract before you go further, because it decides what counts as understanding this lesson. **This lesson teaches you to parse, not to interpret.** By the end you will be able to say that in $\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim p_{\\text{data}}}\\left[-\\log p_\\theta(x)\\right]$ the operator $\\mathbb{E}$ consumes $x$ and returns a scalar, that $\\theta$ is the only symbol still free, and that $\\mathbb{P}(|\\hat{R} - R| > \\epsilon) \\le 2e^{-2n\\epsilon^2}$ bounds a probability by something that shrinks fast in $n$. What you will *not* yet have is what those symbols mean. That is deliberate, and it is dated: expectation and the $\\sim$ in $x \\sim p$ are Lesson 7, the family $p_\\theta$ as a density is Lesson 8, and where $e^{-2n\\epsilon^2}$ comes from is Lesson 10. Parse first, interpret later — the shape of an expression is readable long before its content is.",
  });
  insert(c, 4, {
    kind: 'table',
    headers: ['Convention', 'What this course fixes', 'Where it is used next'],
    rows: [
      ['Default vector', '$x \\in \\mathbb{R}^{d}$ is a **column**; a row is written $x^{\\top}$', 'Lesson 2, composing maps'],
      ['Matrix entry', '$A_{ij}$ is row $i$, column $j$, so $(Ax)_i = \\sum_j A_{ij} x_j$', 'Lesson 2'],
      ['Transpose', '$A^{\\top}$ swaps the two indices: $(A^{\\top})_{ij} = A_{ji}$', 'Lessons 2-5'],
      ['Batched data', '$X \\in \\mathbb{R}^{n \\times d}$ is $n$ examples **in rows**, so the batched map is $XW^{\\top}$', 'Lessons 2, 5'],
      ['Multi-axis', '$X \\in \\mathbb{R}^{B \\times T \\times d}$ is a *stack* of $B \\cdot T$ vectors in $\\mathbb{R}^{d}$; a linear map still acts on the last axis alone', 'Lesson 2'],
      ['Gradient layout', '$\\nabla_W \\mathcal{L}$ has the shape of $W$, not of $W^{\\top}$ — the rule, and why, is Lesson 5', 'Lesson 5'],
    ],
    caption:
      'The conventions this lesson fixes for the whole course. A paper that departs from any of them will say so; when a shape check fails, suspect the convention before you suspect the algebra. The one row this lesson does not settle — gradient layout — belongs to Lesson 5, because it is a statement about derivatives rather than about notation.',
  });
  c.learningGoals.push(
    'Say what a multi-axis object like $X \\in \\mathbb{R}^{B \\times T \\times d}$ is in terms of the two-index world the rest of the course works in',
    'Name what this lesson deliberately defers — the meaning of $\\mathbb{E}$, of $x \\sim p$, of $p_\\theta$, of the exponential tail — and the lesson that repays each',
  );
});

/* Lesson 4 — finding: determinant, trace and positive-(semi)definiteness are used in
 * Lessons 6, 8 and 9 and claimed by no lesson. They fall out of the eigenvalue picture
 * this lesson already builds, so this is where they are claimed. */
edit(4, (c) => {
  insert(c, 10, {
    kind: 'steps',
    title: 'Determinant, trace and definiteness — four readings of one sorted list',
    steps: [
      {
        label: 'The list',
        markdown:
          'For a symmetric $A \\in \\mathbb{R}^{n \\times n}$ with eigenvalues $\\lambda_1 \\ge \\dots \\ge \\lambda_n$, four symbols that look unrelated on a page are four readings of that one sorted list. This is where the course claims them; Lessons 6, 8 and 9 use them without re-deriving them.',
      },
      {
        label: '$\\operatorname{tr} A = \\sum_i \\lambda_i$',
        markdown:
          'The trace is the sum of the diagonal, and also the sum of the eigenvalues. It is *total* stretch. It appears wherever a paper wants a single number for the size of a curvature or covariance matrix — $\\operatorname{tr}(\\Sigma)$ is total variance.',
      },
      {
        label: '$\\det A = \\prod_i \\lambda_i$',
        markdown:
          'The determinant is the signed volume factor: a unit cube fed through $A$ comes out with volume $|\\det A|$. So $\\det A = 0$ exactly when some $\\lambda_i = 0$, which is exactly when $A$ is singular and $A^{-1}$ does not exist. Papers usually write $\\log \\det A = \\sum_i \\log \\lambda_i$ instead, because the product underflows and the sum does not.',
      },
      {
        label: '$A \\succeq 0$ and $A \\succ 0$',
        markdown:
          '*Positive semidefinite* means $x^{\\top} A x \\ge 0$ for every $x$, and that is the same statement as $\\lambda_i \\ge 0$ for every $i$. Strict — $A \\succ 0$, positive definite — is $\\lambda_i > 0$. Read $\\succeq$ as a claim about the whole spectrum, never as an entrywise inequality.',
      },
      {
        label: '$A^{-1}$, when it exists',
        markdown:
          'Inverting a symmetric matrix inverts its eigenvalues and leaves its directions alone: if $A = Q\\Lambda Q^{\\top}$ then $A^{-1} = Q\\Lambda^{-1}Q^{\\top}$. So $\\Sigma^{-1}$ in a Gaussian density (Lesson 8) is not a new object — it is the same $\\Sigma$ with every axis length replaced by its reciprocal, which is why the thin directions dominate the exponent.',
      },
    ],
  });
  c.learningGoals.push(
    'Read $\\operatorname{tr}(A)$, $\\det A$, $\\log \\det A$, $A \\succeq 0$ and $A^{-1}$ straight off the spectrum, and say which of them survives when some $\\lambda_i = 0$',
  );
});

/* Lesson 5 — findings: the linear algebra was rebuilt from the ground up and the calculus
 * was not, though the learner described both as equally rusty; and nothing announced who
 * owns the Hessian. */
edit(5, (c) => {
  insert(c, 0,
    {
      kind: 'prose',
      markdown:
        "Lessons 2-4 rebuilt the linear algebra rather than assuming it. Calculus gets the same courtesy, in one block, because everything below is assembled from exactly three scalar facts.\n\n**Partial derivative.** $\\frac{\\partial f}{\\partial \\theta_i}$ is the ordinary one-variable derivative of $f$ taken with every other coordinate nailed down. **Gradient.** $\\nabla f$ is no more than those partials stacked into one vector: $\\nabla f = \\left(\\frac{\\partial f}{\\partial \\theta_1}, \\dots, \\frac{\\partial f}{\\partial \\theta_d}\\right)^{\\top}$. **Chain rule.** For $f(g(t))$, $\\frac{d}{dt} f(g(t)) = f'(g(t))\\, g'(t)$ — and the multivariable version below is this same sentence with numbers replaced by matrices.\n\nTwo neighbours are named so you know they are not missing: second derivatives, $\\nabla^2 f$, are Lesson 6, where curvature is the point; integral notation $\\int f(x)\\,dx$, and when a paper writes $\\sum_x$ instead, is Lesson 7.",
    },
    {
      kind: 'reveal',
      prompt:
        'Warm the machinery up before it turns into matrices. Let $f(\\theta_1, \\theta_2) = \\theta_1^2 \\theta_2 + e^{\\theta_2}$. (a) Write $\\frac{\\partial f}{\\partial \\theta_1}$ and $\\frac{\\partial f}{\\partial \\theta_2}$. (b) Write $\\nabla f$ and state its shape. (c) If $\\theta_1 = \\sin t$ and $\\theta_2 = t^2$, write $\\frac{df}{dt}$.',
      answer:
        '(a) Holding $\\theta_2$ fixed, $\\frac{\\partial f}{\\partial \\theta_1} = 2\\theta_1\\theta_2$. Holding $\\theta_1$ fixed, $\\frac{\\partial f}{\\partial \\theta_2} = \\theta_1^2 + e^{\\theta_2}$.\n\n(b) $\\nabla f = \\begin{pmatrix} 2\\theta_1\\theta_2 \\\\ \\theta_1^2 + e^{\\theta_2}\\end{pmatrix} \\in \\mathbb{R}^{2}$ — the same shape as $\\theta$, which is the rule the next block generalises.\n\n(c) $\\frac{df}{dt} = \\frac{\\partial f}{\\partial \\theta_1}\\frac{d\\theta_1}{dt} + \\frac{\\partial f}{\\partial \\theta_2}\\frac{d\\theta_2}{dt} = 2\\theta_1\\theta_2\\cos t + (\\theta_1^2 + e^{\\theta_2})\\,2t$. Written with vectors that is $\\nabla f^{\\top}\\dot{\\theta}$ — an inner product, and backpropagation is this line applied repeatedly.',
    },
  );
  c.learningGoals.unshift(
    'Take a partial derivative, stack partials into $\\nabla f$, and apply the scalar chain rule — the three facts everything else in this lesson is assembled from',
  );
});

/* Lesson 6 — findings: convexity is taught only as an optimisation guarantee, but Lesson 9
 * needs its other face, Jensen's inequality; and the proof moves used here are not
 * unpacked until Lesson 11, which sits after the lessons that lean on them. */
edit(6, (c) => {
  insert(c, 6,
    {
      kind: 'prose',
      markdown:
        "Convexity has a second face, and it is the one that turns up in probability rather than optimisation. Take the tangent-underestimator test and average it instead of minimising it. For convex $\\varphi$ and any random variable $X$,\n\n$$\\varphi(\\mathbb{E}[X]) \\le \\mathbb{E}[\\varphi(X)]$$\n\nThis is **Jensen's inequality**, and it is the same fact as the chord test: the chord lies above the curve, so averaging the inputs can only undershoot averaging the outputs. Concave functions flip it. The case the rest of the course runs on is $\\varphi = -\\log$, which is convex, giving $\\mathbb{E}[-\\log X] \\ge -\\log \\mathbb{E}[X]$. Lesson 9 spends that one line twice: once to prove $D_{\\mathrm{KL}}(q \\parallel p) \\ge 0$, and once to manufacture the variational bound $\\log p(x) \\ge \\mathbb{E}_{q}\\!\\left[\\log p(x,z) - \\log q(z)\\right]$. Same property, opposite purpose: here it guarantees a minimum, there it guarantees an inequality.",
    },
    {
      kind: 'check',
      question: 'You know $\\varphi$ is convex. Which way does Jensen point?',
      options: [
        '$\\mathbb{E}[\\varphi(X)] \\le \\varphi(\\mathbb{E}[X])$ — averaging first is always the larger of the two',
        '$\\varphi(\\mathbb{E}[X]) \\le \\mathbb{E}[\\varphi(X)]$ — pushing the average through a convex $\\varphi$ can only undershoot',
        'Neither; Jensen also needs $X$ to be Gaussian',
      ],
      answerIndex: 1,
      whyRight:
        'The chord lies above the curve, so the curve evaluated at the average sits below the average of the curve. With $\\varphi = -\\log$ this reads $-\\log \\mathbb{E}[X] \\le \\mathbb{E}[-\\log X]$, which is the whole engine of Lesson 9.',
      whyWrong:
        'The first option is Jensen for a **concave** $\\varphi$ — the direction you get from $\\log$, not from $-\\log$. And Jensen assumes nothing about the distribution of $X$ beyond a finite mean: convexity of $\\varphi$ is the entire hypothesis.',
    },
  );
  c.blocks.push({
    kind: 'prose',
    markdown:
      'A note on what you have been doing, rather than on what you have learned. The arguments above are proofs read at speed: the descent guarantee is a chain of $\\le$ steps in which each line is licensed by one named hypothesis, and the bound at the end quantifies over *some* iterate rather than all of them. Reading that structure deliberately — which assumption does the work, what is quantified over what, what the result declines to claim — is Lesson 11, and it repays this lesson, Lesson 9 and Lesson 10 at once. You are borrowing it here; if a step above felt like sleight of hand, that is the loan, and not a gap in your algebra.',
  });
  c.learningGoals.push(
    "State Jensen's inequality $\\varphi(\\mathbb{E}[X]) \\le \\mathbb{E}[\\varphi(X)]$ as the same convexity fact turned to a different purpose, and apply it to $\\varphi = -\\log$",
  );
});

/* Lesson 8 — findings: the multivariate Gaussian cannot be written without $\det \Sigma$
 * and $\Sigma^{-1}$, which had no owner (now Lesson 4); and high-dimensional Gaussian
 * behaviour is claimed by both this lesson and Lesson 10 with no boundary stated. */
edit(8, (c) => {
  insert(c, 12, {
    kind: 'prose',
    markdown:
      "Two boundaries, stated so you know what you are owed and by whom. **Behind you:** the exponent of the multivariate Gaussian, $p(x) \\propto \\exp\\!\\left(-\\tfrac{1}{2}(x-\\mu)^{\\top}\\Sigma^{-1}(x-\\mu)\\right)$, and its normaliser $(2\\pi)^{-d/2}(\\det \\Sigma)^{-1/2}$, are read with Lesson 4's spectrum: $\\Sigma^{-1}$ reciprocates the axis lengths and $\\det \\Sigma$ is their product, so a nearly-singular $\\Sigma$ has an enormous density along its thin direction. Nothing new is being assumed. **Ahead of you:** everything here is a statement about the Gaussian *as a family* — its shape, its parameters, the loss it induces — in dimensions you can picture. What happens to $\\mathcal{N}(0, I_d)$ as $d$ grows, where the mass leaves the centre for a shell at radius $\\approx\\sqrt{d}$ and two independent draws become almost orthogonal, is Lesson 10's, and is not assumed here.",
  });
});

/* Lesson 9 — finding: $D_{KL} \ge 0$ and the ELBO rest entirely on Jensen's inequality,
 * which no lesson named; and the proof-reading moves are on loan from Lesson 11. */
edit(9, (c) => {
  insert(c, 7, {
    kind: 'prose',
    markdown:
      "Before the argument that follows, name the tool — because everything from here to the ELBO is one tool used twice. It is **Jensen's inequality** from Lesson 6, the second face of convexity: for convex $\\varphi$, $\\varphi(\\mathbb{E}[X]) \\le \\mathbb{E}[\\varphi(X)]$, and $-\\log$ is convex. That single line is what makes $D_{\\mathrm{KL}}(p\\|q) \\ge 0$ true, and it is what turns an intractable $\\log p_\\theta(x)$ into a bound you can actually optimise. If you want the reading skill rather than the result — how to see which hypothesis is carrying a chain of $\\le$ steps, and what a bound refuses to claim — that is Lesson 11, borrowed here and repaid there.",
  });
});

/* Lesson 10 — finding: convergence and asymptotic notation are split across Lessons 1, 10
 * and 11 with no owner, though the law of large numbers and the CLT stated here cannot be
 * written without the arrows. */
edit(10, (c) => {
  insert(c, 7, {
    kind: 'table',
    headers: ['Symbol', 'Read it as', 'Owned by'],
    rows: [
      ['$\\hat{R}_n \\xrightarrow{p} R$', 'Converges **in probability**: for every $\\epsilon > 0$, $\\mathbb{P}(|\\hat{R}_n - R| > \\epsilon) \\to 0$. This is the law of large numbers — and the bound above is what gives it to you at finite $n$ rather than only in the limit.', 'this lesson'],
      ['$\\sqrt{n}(\\hat{R}_n - R) \\xrightarrow{d} \\mathcal{N}(0, \\sigma^2)$', "Converges **in distribution**: the rescaled error's *distribution* approaches a Gaussian. It says nothing about any particular sample. This is the central limit theorem.", 'this lesson'],
      ['$\\hat{R}_n \\xrightarrow{a.s.} R$', 'Converges **almost surely** — stronger than $\\xrightarrow{p}$, occasionally claimed, rarely needed in order to read a result.', 'this lesson'],
      ['$O(\\cdot)$, $o(\\cdot)$, $\\Theta(\\cdot)$, $\\tilde{O}(\\cdot)$', 'What a rate hides: constants, log factors, and which variable the limit is even in.', 'Lesson 11'],
    ],
    caption:
      'The two arrows belong to this lesson, because the law of large numbers and the central limit theorem cannot be stated without them; the $O$-family belongs to Lesson 11, where hiding a constant is the point. The distinction worth carrying: $\\xrightarrow{p}$ is a claim about a **number** getting close, $\\xrightarrow{d}$ is a claim about a **distribution** taking a shape — and a paper that proved the second has proved nothing about how far off your one run is.',
  });
  c.learningGoals.push(
    'Tell $\\xrightarrow{p}$ and $\\xrightarrow{d}$ apart — a number getting close versus a distribution taking a shape — and say which of them a stated result actually gives you',
  );
});

/* Lesson 11 — finding: the same split, stated from this side, so neither lesson silently
 * assumes the other taught the notation. */
edit(11, (c) => {
  insert(c, 7, {
    kind: 'prose',
    markdown:
      'One boundary first. The convergence arrows — $\\xrightarrow{p}$ for a number getting close, $\\xrightarrow{d}$ for a distribution taking a shape — were settled in Lesson 10, where the law of large numbers and the central limit theorem need them; they are assumed here, not re-taught. What this zone owns is the other compression scheme: the $O$-family, where the point is not convergence at all but *what a rate is allowed to hide* — a constant, a log factor, or the question of which variable the limit is in.',
  });
});

/* Lesson 12 — finding: it was ambiguous whether the full-paper read belongs to this lesson
 * or to the capstone, so a learner could do the same work twice. */
edit(12, (c) => {
  insert(c, 11, {
    kind: 'prose',
    markdown:
      '**What this lesson owns, and what the project owns.** The excerpt above is synthetic and shared: every reader meets the same $\\Theta$, the same $\\delta$, the same deliberately ambiguous symbol — so that when your read differs from the worked one, you can tell whether you or the notation is at fault. That is what a guided read is for, and it is the whole of this lesson. The capstone project is the other half, and not a repeat: you choose a real paper on the subject you actually care about and run the same four passes with no worked answer beside you, ending in a one-page protocol card you keep. Here you learn the protocol against a known answer; there you find out whether it survives contact with a paper nobody prepared for you.',
  });
});

/* Lesson 13 (the capstone brief) — the same boundary, stated from the project's side. */
edit(13, (c) => {
  const marker = '## What you build';
  if (!c.explanation.markdown.includes('How this differs from Lesson 12')) {
    c.explanation.markdown = c.explanation.markdown.replace(
      marker,
      "**How this differs from Lesson 12.** Lesson 12 ran the four-pass protocol over a synthetic excerpt with a worked answer beside it — a rehearsal against a known result. This is the performance: a real paper of your choosing, no worked answer, and an artefact you keep. If you find yourself re-decoding Lesson 12's excerpt, you have picked the wrong paper.\n\n" + marker,
    );
  }
});

/* Findings that needed no edit, checked against the lessons as they stand:
 *  - "the empirical/population distinction has no home": Lesson 7 blocks 9-11 own it
 *    ($\hat{R}$ as a random variable, the hat convention, i.i.d. sampling), and Lesson 10
 *    states the i.i.d. and boundedness hypotheses explicitly.
 *  - "no lesson owns the Hessian": Lesson 6 opens by giving $\nabla^2\mathcal{L}$ its
 *    shape and uses it throughout. Only the hand-off from Lesson 5 was unstated, which the
 *    Lesson 5 edit above now states.
 *  - "the project may be a separate unwritten module": stale — the capstone brief is
 *    written, and the overlap it worried about is the one Lesson 12 and 13 now name.
 */

const state = path.join(ROOT, 'data', 'topics', TOPIC, 'orchestration.json');
const s = JSON.parse(fs.readFileSync(state, 'utf8'));
const dropped = s.notes.filter((n) => n.kind === 'discontinuity' || n.kind === 'graph-defect').length;
s.notes = s.notes.filter((n) => n.kind !== 'discontinuity' && n.kind !== 'graph-defect');
s.status = s.notes.length > 0 ? 'ready-with-notes' : 'ready';
fs.writeFileSync(state, JSON.stringify(s));
db.prepare('UPDATE topics SET notes_json = ?, status = ? WHERE id = ?').run(JSON.stringify(s.notes), s.status, TOPIC);
console.log(`\nretired ${dropped} findings; topic is now "${s.status}" with ${s.notes.length} note(s).`);
db.close();
