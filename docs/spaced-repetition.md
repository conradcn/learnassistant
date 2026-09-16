# Spaced repetition: what we take from FSRS, and what we do not

> Research note backing **F7 (Spaced review)** and **C7 (Review scheduler & interleaved
> practice)**. Written 2026-08-28 against FSRS-6 / `ts-fsrs` 5.4.1.

Our review intervals were hand-rolled SM-2: a fixed `ease` of 2.5, multiply on a pass,
subtract 0.15 on a miss, floor at 1.3, cap at 180 days. The open-source spaced-repetition
field has moved on, and this note works out how much of that move applies to us.

The short version: **we adopt FSRS-6's memory model wholesale, and we decline almost
everything built on top of it.** The model is a strictly better interval function than what
we had. The apparatus around it — four self-reported grades, per-user weight optimisation,
retention dashboards — is built for flashcards and does not survive contact with what we
actually measure.

---

## 1. What FSRS is

FSRS (Free Spaced Repetition Scheduler) is a scheduler built on the **DSR memory model**,
descended from MaiMemo's DHP model and published by Jarrett Ye et al. It tracks three
quantities per item:

- **Stability (S)** — the number of days after which recall probability falls to 0.9. Not a
  "score"; a time constant, measured in days.
- **Difficulty (D)** — a value in [1, 10], how resistant this item is to gaining stability.
- **Retrievability (R)** — the probability of recall right now, derived from S and elapsed
  time, not stored.

The forgetting curve from FSRS-4.5 onward is a power function rather than an exponential:

```
R(t, S) = (1 + FACTOR · t/S)^(-DECAY)
```

with `FACTOR` chosen so `R(S, S) = 0.9`. FSRS-6 makes `DECAY` a trainable parameter (`w20`,
default 0.1542). Scheduling inverts it: given a desired retention `r`,

```
I(r, S) = (S / FACTOR) · (r^(-1/DECAY) - 1)
```

On each review, S and D are updated from `(D, S, R, grade)`. The three update paths that
matter to us:

- **Successful recall** — `S' = S · (1 + e^(w8) · (11 − D) · S^(−w9) · (e^(w10·(1−R)) − 1) · …)`.
  Two properties fall out of this and both are things our SM-2 code did not have. First,
  **stability gain grows as R falls**: reviewing something you had nearly forgotten is worth
  more than reviewing something you just saw. Second, **gains shrink as S grows** — the
  spacing effect saturating, so intervals stop compounding geometrically forever.
- **Forgetting** — `S' = w11 · D^(−w12) · ((S+1)^w13 − 1) · e^(w14·(1−R))`. A lapse does not
  reset to 1 day; the post-lapse stability remembers how strong the memory was.
- **Difficulty** — updated with **mean reversion** toward `D₀(Easy)`, which is what stops the
  "ease hell" that SM-2's monotonically-decreasing ease factor produces. Our old code had
  exactly that failure mode: `ease` only ever went down, floored at 1.3, and never recovered
  no matter how many times the learner subsequently got it right.

FSRS-6 has 21 parameters trained on ~700M reviews from ~20k Anki users. FSRS-7 (fractional
intervals, better same-day modelling) exists in the benchmark and in open PRs but has **no
frozen weights and no stable release** as of mid-2026, so it is not a candidate.

### The evidence

The [srs-benchmark](https://github.com/open-spaced-repetition/srs-benchmark) evaluates ~350M
reviews across ~10,000 collections with time-series cross-validation. Log loss / RMSE(bins) /
AUC, lower-lower-higher being better:

| Algorithm | Log loss ↓ | RMSE(bins) ↓ | AUC ↑ |
|---|---|---|---|
| RWKV-P (neural) | 0.2773 | 0.0250 | 0.8329 |
| FSRS-7 | 0.3437 | 0.0655 | 0.7069 |
| **FSRS-6** | **0.3460** | **0.0653** | **0.7034** |
| FSRS-5 | 0.3560 | 0.0741 | 0.7011 |
| FSRS-4.5 | 0.3624 | 0.0764 | 0.6893 |
| FSRS v4 | 0.3726 | 0.0838 | 0.6853 |
| FSRS v3 | 0.4364 | 0.1097 | 0.6605 |
| HLR (Duolingo) | 0.4694 | 0.1275 | 0.6369 |
| ACT-R | 0.4033 | 0.1074 | 0.5225 |
| AVG (constant baseline) | 0.3945 | 0.1034 | 0.4997 |

FSRS-6 beats SM-2 on ~99.6% of user collections by log loss. The commonly-quoted "20–30%
fewer reviews at equal retention" is a **simulation on logged data, not a controlled trial** —
there is no published RCT of FSRS against SM-2 with live learners. We should quote the
calibration numbers, which are real, and not the efficiency number, which is a projection.

Three caveats the benchmark authors state, all of which apply to us:

1. SM-2 was never designed to emit probabilities; the comparison bolts a conversion onto it.
2. The benchmark cannot evaluate anything needing features beyond intervals and grades.
3. Absolute metric values depend on methodology; the *ranking* is the robust result.

And a fourth, from the algorithm's own maintainers: **neither FSRS-5 nor FSRS-6 has a real
model of short-term memory** — same-day reviews are handled by a heuristic. Difficulty is
described by them as "a crude heuristic" that does not take R into account.

---

## 2. What our signal actually is, and where it does not fit

This is the part that does not transfer, and it is worth being precise about rather than
hand-waving past.

FSRS assumes:

| FSRS assumes | We have |
|---|---|
| An **atomic item** — one fact, one prompt, one answer | A **lesson or concept** — composite, several objectives, an eval script with multiple angles |
| A **binary recall event** — you produced the answer or you did not | An **evaluator's judgement of understanding** over a Socratic exchange, with a `pass` / `assisted-pass` / `fail` outcome |
| A **self-reported grade** in 1–4 | A **third-party assist level** in 0–3, recorded per exchange by the evaluator, plus F10's predicted-vs-actual calibration |
| Weights **trained on this user's own history** | ~600 modules under review and ~15 reviews/day at declared steady state — three orders of magnitude short of what training 21 parameters needs |
| Reviews are **the only learning event** | F3 lessons, F8 interleaved practice, F9 synthesis prompts and F12 detours all touch the same material off-schedule |

The consequences, one at a time.

**The unit is not atomic, so S is not a recall probability.** When our scheduler says a
concept has stability 40, that does not mean "90% chance of recalling this in 40 days" the way
it does for a flashcard, because there is no single "this" to recall. What it means is
narrower and still useful: *this is the point at which revisiting the concept is likely to be
productive rather than redundant*. We keep the arithmetic and we downgrade the claim. Nowhere
in the product do we assert a retention probability, and F5 already forbids the surface where
we would be tempted to.

**The grade is a judgement, not a self-report.** This cuts both ways. Our signal is *less
biased* than Anki's — the learner cannot flatter themselves into longer intervals, because
they are not the one grading. It is also *noisier*: an LLM evaluator's assist level varies run
to run in a way a keypress does not, and the evaluator is judging a conversation, not checking
a string. Since FSRS's sensitivity to grade noise is concentrated in the Hard/Easy distinction
and the Again/Good split dominates the fit, the mitigation is to use fewer grades, not more —
see §3.

**The weights are a prior from a different population.** FSRS-6's defaults are fit to people
memorising vocabulary and medical facts. Our items are conceptual and our reviews are
conversations. Using those weights is importing a prior that does not describe our learners.
We do it anyway, and the reason is comparative rather than absolute: the alternative on offer
was SM-2's constants, which are a prior from *SuperMemo's 1987 word-pair experiments on one
person*, additionally uncalibrated and additionally afflicted by ease hell. A well-fit prior
from the wrong population beats a badly-fit prior from a smaller wrong population. This is the
weakest link in the adoption and it should be stated as such rather than dressed up.

**Off-schedule exposure is unmodelled.** F8 practice, F9 synthesis and re-reading a lesson all
strengthen a memory that FSRS thinks has been decaying since the last graded review. FSRS has
no notion of this, and neither did our old scheduler. F8 at least reports its answers into the
scheduler already; F9 and re-reads do not, and we are not going to invent a model for them.

---

## 3. The mapping, which is the whole design problem

Our outcomes must become FSRS grades. The mapping is where the honesty lives, so here it is
explicitly, with the reasoning for each line.

| Our event | Grade | Why |
|---|---|---|
| Module completion (F4), assist level 0–1 | **Good** | A clean or lightly-hinted pass is the ordinary case. FSRS's initial stability for Good is 2.31 days → a **3-day** first interval, which is exactly what F7 already specified. |
| Module completion (F4), assist level ≥2 (`assisted-pass`) | **Hard** | Initial stability 1.29 → a **2-day** first interval. This preserves F4's assisted-pass-schedules-earlier rule *derivationally* rather than by a hand-set constant, and it also sets initial difficulty to 5.11 instead of 2.12, so the shortening persists into later intervals instead of washing out after one review. |
| Review passed, assist level 0–1 | **Good** | |
| Review passed with heavy help (`assisted-pass`, assist ≥2) | **Hard** | This is new information the old scheduler discarded: it multiplied by `ease` regardless of how much help the pass took. |
| Review failed | **Again** | |
| "I had forgotten this" on a queue card, or a wrong F8 practice answer | **Again** | |
| "I remembered this" on a queue card, or a correct F8 practice answer | **Good** | |

Four decisions inside that table deserve defending.

**Never Easy.** FSRS's own tutorial reports that the model is *more* accurate for users who
mostly press Again and Good than for users who exercise all four buttons, and Easy is
discouraged in practice. More to the point, we have no signal that means "easier than
expected". The nearest candidate is F10's predicted confidence, and that is the learner's
*prior* about the material, not evidence about *this retrieval* — see below. And the case Easy
exists to serve is already handled: a learner who nails a badly overdue review gets a large
stability gain automatically, because the recall-stability term scales with `(1 − R)`.

**An assisted pass is Hard, not Again.** FSRS treats Again as a lapse: it increments the lapse
count, routes through the post-forgetting stability formula, and drives difficulty up hard.
An `assisted-pass` is a pass — the learner got there. Grading it as a failure would both
misrepresent the history and overcorrect the schedule. Hard is the honest encoding: passed,
with more effort than expected. This aligns with FSRS's own rule that Hard is a *passing*
grade and that using Hard as a failure inflates intervals — we are using it as intended.

**Module completion never grades Again, even at assist level 3.** Completion is an *encoding*
event, not a retrieval attempt; there was no memory to fail to retrieve. Recording a lapse for
a module that has never been reviewed would poison the item's history before it starts. Heavy
assist at completion caps out at Hard.

**F10 calibration data does not enter the scheduler.** This is a deliberate decline, and the
reason is not that the data is bad. It is that predicted confidence is a *self-report about
the future*, and letting it move intervals means a confidently-wrong learner schedules their
own material further out — the precise failure mode retrieval practice exists to correct.
Miscalibration is a legitimate signal, but it is a signal about the *learner*, not about the
*item*, and the memory model has no slot for it. There is a defensible future use — ordering
same-day due items so the ones the learner was most overconfident about come first — but that
means joining C8's calibration rows into C7's due query, which has a "one query, no N+1" perf
budget at 600 items. Not now, and not silently.

### Why the grades collapse rather than expand

The instinct on seeing a richer signal is to build a richer grade scale — map assist level 0/1/2/3
onto four buttons, add a fifth for confidence. That is backwards. The benchmark result is that
FSRS fits *better* on two-grade histories than on four-grade ones, because Hard and Easy are
where self-report noise concentrates and the Again/Good boundary carries almost all of the
information. Our signal is noisier per-observation than a keypress, not less. So the richer
input gets compressed into three grades, with the extra resolution spent on *which* of the
three we pick and on when the review is offered at all — not on inventing grades the model
cannot use.

---

## 4. Same-day reviews, and an unexpectedly good fit for F8

F8 practice answers already feed the scheduler: a practice question is a retrieval attempt, so
it moves the same schedule a queue card would. Under the old code this was a bug waiting to
happen — five practice questions drawn from one module in one session multiplied that module's
interval by `ease` five times, pushing a 3-day interval to 117 days on a single afternoon.

Running FSRS with `enable_short_term: false` fixes this for free, and for a principled reason
rather than by a guard. With short-term steps disabled, a same-day review takes the ordinary
recall path with elapsed time `t = 0`, so `R = 1`, so the stability-gain term
`e^(w10·(1 − R)) − 1` is exactly zero and `S' = S`. Meanwhile a same-day **failure** still
goes through the forgetting branch and still drops stability and increments lapses.

That asymmetry is exactly what interleaved practice needs: repeated same-day retrievals cannot
inflate the schedule, but a miss always registers. It is a property of the model, it is
deterministic, and it is covered by a test.

`enable_short_term: false` is also right for us on its own terms — learning steps are
sub-hour, intra-session constructs for flashcard drilling. Our smallest interval is a day.

---

## 5. Decisions

### Adopt

- **FSRS-6 as the interval function**, via [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs)
  5.4.1 — MIT, zero runtime dependencies, Node ≥20, ships FSRS-6 with the reference weights.
  We do not reimplement the algorithm.
- **The DSR state per review item** — stability, difficulty, reps, last-reviewed instant —
  persisted, replacing `ease`.
- **`enable_short_term: false`**, for §4.
- **`enable_fuzz: false`**. Fuzz randomises intervals ±5% to spread Anki's daily load. We
  have a daily cap that already spreads load, and a hard requirement that scheduling be
  deterministic and testable without a provider call. Randomness buys us nothing and costs us
  reproducibility.
- **Difficulty mean reversion**, which comes with the model and fixes ease hell.
- **Post-lapse stability that remembers**, replacing "reset the interval to 1 day".

### Adapt

- **A three-grade mapping** from evaluator judgement, per §3, instead of self-reported 1–4.
- **The 180-day cap is enforced by us, not by `maximum_interval`.** `ts-fsrs`'s long-term
  scheduler applies `good ≥ hard + 1` and `easy ≥ good + 1` *after* clamping, so
  `maximum_interval: 180` can return 181. F7 says the cap is a maximum interval and never an
  exit, and 181 quietly breaking a stated invariant is worse than the extra clamp. We clamp
  the interval ourselves and derive `dueAt` as `now + intervalDays`, which also keeps due
  instants exact rather than day-truncated.
- **The failure path needed a call site that did not exist.** `Again` is in the table above,
  but nothing in the app could produce it from an evaluator judgement: reviews reach the
  scheduler through C1's `completeModule`, and that transaction refuses any non-passing
  verdict, so a review failed in the chat used to leave the schedule untouched while its
  interval kept growing. The only route that registered a miss was the queue card's "I had
  forgotten this". C6 now reports a terminal `fail` on a `review` target straight to C7 —
  once per session, since every turn after the hint ladder is exhausted is also a `fail` and a
  learner who keeps trying has had one failed retrieval, not four. Mapping an outcome onto a
  grade is only half the work; the other half is making sure something can emit it.
- **The memory state is not part of the UI contract.** `ReviewItem` carries it; a new
  `ReviewCue` — module id, due instant, needs-another-look flag — is what crosses the HTTP
  boundary. F5 forbids progress-as-grades, and S/D/R are exactly the numbers that grow a
  dashboard if you let them within reach of one.
- **Migration derives the memory state from the old fields** rather than resetting. Stability
  seeds from the current interval — S is *defined* as the interval at which R = 0.9, and the
  old scheduler's interval was its own estimate of when the item needed revisiting, so the
  units line up. Difficulty seeds by interpolating the old `ease` between FSRS's initial
  difficulty for Good (ease 2.5, never lapsed → D 2.12) and the maximum (ease 1.3, floored by
  lapses → D 10). A learner mid-course keeps their schedule.

### Decline

- **Per-user weight optimisation.** The optimiser wants review histories in the thousands to
  fit 21 parameters; F7's declared steady state is ~15 reviews/day. It would also add
  `@open-spaced-repetition/binding`, a native/WASM dependency, to a local-first app, in
  exchange for overfitting. Default FSRS-6 weights, with the caveat in §2 stated plainly.
- **FSRS-7.** No frozen weights, no stable release. Revisit when there is one; the adapter is
  one module and `ts-fsrs` handles the version bump.
- **A four-grade scale.** §3.
- **F10 calibration as a scheduling input.** §3.
- **Exposing desired retention as a setting.** It is a real FSRS feature and a real knob
  (0.70–0.97, default 0.90). But it is a workload/retention trade expressed as a number, and
  every honest way to explain it to a learner is a sentence about their expected failure rate
  — which is F5's forbidden framing wearing a hat. It stays a constant at 0.9, the documented
  default, adjustable in `ScheduleParams` for tests.
- **Retrievability in the UI.** We compute it (it is useful for ordering and for logs) and it
  never leaves the process. "You have a 78% chance of remembering this" is a grade.
- **Neural schedulers (RWKV-P, GRU-P).** They win the benchmark decisively. They also need a
  trained model shipped and run per learner, on data we do not have. Not a candidate at our
  scale.
- **Replacing anything F8/F9 does.** The scheduler supplements the material. Interleaved
  practice still mixes across topics on its own rule, synthesis prompts are still additive and
  ungated, and the review queue is still a queue and not a gate.

---

## 6. What we would need to know to do better

Stated so that the limits above are falsifiable rather than rhetorical:

- **Whether the FSRS-6 weights are wrong for conceptual items, and how.** Answerable by
  logging predicted retrievability at review time against the observed outcome and computing
  RMSE(bins) locally, the same metric the benchmark uses. Cheap, purely internal, and it would
  tell us whether the imported prior is fit for purpose before we ever consider fitting our own.
- **Whether the evaluator's assist level is stable enough to grade on.** Answerable by
  re-running an evaluator over the same transcript and measuring assist-level variance.
- **Whether off-schedule exposure (F8, F9, re-reads) materially shifts retention.** Would need
  a within-learner comparison we do not have the volume for.

None of these block the change. All of them are things this document is currently guessing at.

---

## Sources

- FSRS algorithm spec — [awesome-fsrs wiki, The Algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)
- Implementation — [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) · [awesome-fsrs](https://github.com/open-spaced-repetition/awesome-fsrs)
- Benchmark — [srs-benchmark](https://github.com/open-spaced-repetition/srs-benchmark) · [Expertium, Benchmark](https://expertium.github.io/Benchmark.html)
- Technical explanation and stated limitations — [Expertium, A technical explanation of FSRS](https://expertium.github.io/Algorithm.html)
- Grade semantics, desired retention, learning steps — [fsrs4anki tutorial](https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md)
- Underlying research — Ye, Su & Cao, [*A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling*](https://dl.acm.org/doi/10.1145/3534678.3539081), KDD 2022 · [*Optimizing Spaced Repetition Schedule by Capturing the Dynamics of Memory*](https://dl.acm.org/doi/10.1109/TKDE.2023.3251721), IEEE TKDE 2023
- Desirable difficulties, and the boundary condition behind the assisted-pass rule — [Bjork & Bjork, *Introducing Desirable Difficulties Into Practice and Instruction*](https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-introducing-desirable-difficulties-into-practice-and-instruction-bjork-and-bjork.pdf)
