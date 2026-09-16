// FRACTAL: implements (none) | component C0

/**
 * WHY this file is a two-line dispatcher: Next compiles `instrumentation.ts` into BOTH the
 * Node and the Edge layer, and it does so unconditionally — declaring `runtime = 'nodejs'`
 * on the middleware keeps `next build` happy but does not stop `next dev` from building the
 * edge copy. The real handler imports `node:fs`, which webpack cannot resolve for the edge
 * target, so the edge build failed with `UnhandledSchemeError: Reading from "node:fs"` and
 * dev then answered EVERY request with a 500 ModuleBuildError. `next build` hid this; only
 * the dev server surfaced it, and the dev server was undocumented.
 *
 * `process.env.NEXT_RUNTIME` is substituted as a literal per layer, so the edge bundle drops
 * this branch — and with it the import — before webpack ever resolves `node:fs`. The Node
 * bundle keeps it. See `instrumentation-node.ts` for the handler itself.
 */
export async function register(): Promise<void> {
  // WHY the positive `if` and not an early `return`: webpack only prunes the dynamic import
  // when it sits inside a block whose condition folds to `false`. An early-return guard leaves
  // the import in the graph, the edge build resolves `node:fs` anyway, and the 500 comes back.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node');
    mod.register();
  }
}
