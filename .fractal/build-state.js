const fs = require('fs');
const crypto = require('crypto');

const norm = s => s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();

// WHY the spec files are read through this and not fs.readFileSync directly: this repo is
// checked out with core.autocrlf on Windows, so features.md and architecture.md arrive
// CRLF. Every heading pattern below ends in `$`, and `.` does not match `\r` — so on a
// CRLF checkout `sections()` matched nothing, and the script cheerfully wrote a state file
// with zero features, zero components and zero egress rows over the real one.
const readText = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const hash = s => crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);

function sections(text, re) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(re);
    if (m) { if (cur) out.push(cur); cur = { id: m[1], title: m[2].trim(), body: [] }; }
    else if (cur) cur.body.push(l);
  }
  if (cur) out.push(cur);
  return out.map(s => ({ ...s, body: s.body.join('\n') }));
}

// ---------- features ----------
const featText = readText('features.md');
const feats = sections(featText, /^## (F\d+(?:\.\d+)*): (.+)$/);
const features = {};
for (const f of feats) {
  const line = k => (f.body.match(new RegExp('^- ' + k + ':\\s*(.+)$', 'm')) || [])[1] || null;
  const paths = (line('paths') || '').split(' / ').map(s => s.trim()).filter(Boolean);
  const acs = [];
  for (const l of f.body.split('\n')) {
    if (!l.startsWith('- AC: ')) continue;
    for (const part of l.slice(2).split(/;\s*(?=AC:)/)) acs.push(part.trim().replace(/^AC:\s*/, ''));
  }
  const perf = [];
  const perfLine = line('perf');
  if (perfLine) for (const p of perfLine.split(';')) {
    const m = p.match(/(.+?)\s*<\s*([\d.]+)\s*(ms|min)\s*p(\d+)/);
    if (m) perf.push({ op: m[1].trim(), budgetMs: m[3] === 'min' ? Number(m[2]) * 60000 : Number(m[2]), percentile: Number(m[4]) });
  }
  features[f.id] = {
    title: f.title,
    hash: hash(f.body),
    parent: null,
    children: [],
    paths,
    acceptanceCriteria: acs,
    perfBudgets: perf,
    requiresE2E: (line('e2e') || '').trim() === 'yes',
    asserts: line('asserts'),
    scale: line('scale'),
    status: 'active',
    lastBuildStatus: null,
    uiConverged: false,
  };
}

// ---------- components ----------
const archText = readText('architecture.md');
const comps = sections(archText, /^## (C\d+(?:\.\d+)*): (.+)$/);
const components = {};
const shapes = {};
const files = {};
const tests = {};

const block = (body, label) => {
  const re = new RegExp('^\\*\\*' + label + ':?\\*\\*:?(.*)$', 'm');
  const m = body.match(re);
  if (!m) return null;
  const idx = body.indexOf(m[0]);
  const rest = body.slice(idx + m[0].length).split('\n');
  const rows = [];
  for (const l of rest) {
    if (l.startsWith('- ')) rows.push(l.slice(2).trim());
    else if (l.trim() === '' || l.trim().startsWith('<!--')) continue;
    else break;
  }
  return { inline: m[1].trim(), rows };
};

const bulletList = (body, header) => {
  const idx = body.indexOf(header);
  if (idx < 0) return [];
  const out = [];
  for (const l of body.slice(idx + header.length).split('\n')) {
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
    else if (l.trim() === '') continue;
    else break;
  }
  return out;
};

for (const c of comps) {
  const impl = ((c.body.match(/^\*\*Implements:\*\*\s*(.+)$/m) || [])[1] || '')
    .match(/F\d+(?:\.\d+)*/g) || [];
  const consumes = ((c.body.match(/^\*\*Consumes shapes:\*\*\s*(.+)$/m) || [])[1] || '')
    .match(/`([A-Za-z0-9_<>]+)`/g) || [];
  const depends = ((c.body.match(/^\*\*Depends on:\*\*\s*(.+)$/m) || [])[1] || '')
    .match(/C\d+/g) || [];

  // shape contracts owned here
  const shapeIdx = c.body.indexOf('**Shape contracts');
  if (shapeIdx >= 0) {
    const seg = c.body.slice(shapeIdx).split('\n**Depends on:**')[0];
    const lines = seg.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- `([A-Za-z0-9_<>]+)`\s*=\s*(.+)$/);
      if (!m) continue;
      let def = m[2];
      let example = null;
      for (let j = i + 1; j < lines.length && j < i + 4; j++) {
        const e = lines[j].match(/^\s+- example:\s*(.+)$/);
        if (e) { example = e[1]; break; }
      }
      // one line may declare two shapes: `A` = ...; `B` = ...
      for (const piece of lines[i].slice(2).split(/;\s+(?=`)/)) {
        const pm = piece.match(/^`([A-Za-z0-9_<>]+)`\s*=\s*(.+)$/);
        if (!pm) continue;
        const bare = pm[1].replace(/<.*>/, '');
        shapes[pm[1]] = { ownerComponent: c.id, definition: pm[2], example, consumers: [] };
        if (bare !== pm[1]) shapes[bare] = shapes[pm[1]];
      }
      void def;
    }
  }

  const planFiles = bulletList(c.body, '**Files (planned):**\n').map(s => s.replace(/`/g, '').split(' ')[0]);
  const planTests = bulletList(c.body, '**Tests (planned):**\n')
    .map(s => {
      const m = s.match(/^`?([^`\s]+\.(?:ts|tsx))`?\s*(?:\((.*)\))?/);
      if (!m) return null;
      return { path: m[1], note: m[2] || '' };
    }).filter(Boolean).filter(t => !t.note.includes('not applicable'));

  for (const f of planFiles) {
    if (files[f]) throw new Error('duplicate file ownership: ' + f + ' (' + files[f].components + ' and ' + c.id + ')');
    files[f] = { hash: '', implements: impl, components: [c.id], generatedBy: 'planned' };
  }
  for (const t of planTests) {
    const covers = (t.note.match(/F\d+(?:\.\d+)*/g) || []);
    let type = 'unit';
    if (t.path.startsWith('e2e/')) type = 'e2e';
    else if (/\.perf\.ts$/.test(t.path)) type = 'perf';
    else if (/^tests\/(release|durability|egress|claims|harness|sinks|recovery|lifecycle|supplychain|smoke|publication)\//.test(t.path)) type = 'hardening';
    else if (/^tests\/optimistic\//.test(t.path)) type = 'optimistic';
    else if (/integration/.test(t.note)) type = 'integration';
    const prev = tests[t.path];
    tests[t.path] = {
      hash: '',
      covers: [...new Set([...(prev ? prev.covers : []), ...covers])],
      type,
      components: [...new Set([...(prev ? prev.components : []), c.id])],
      note: prev ? prev.note : t.note,
      generatedBy: 'planned',
    };
  }

  const rows = l => { const b = block(c.body, l); return b ? b.rows : []; };
  const inline = l => { const b = block(c.body, l); return b ? b.inline : null; };

  components[c.id] = {
    title: c.title,
    hash: hash(c.body),
    implements: impl,
    dependsOn: depends,
    consumes: consumes.map(s => s.replace(/`/g, '')),
    ownsShapes: Object.keys(shapes).filter(k => shapes[k].ownerComponent === c.id),
    subDoc: null,
    releaseSurface: (inline('Release surface') || '').replace(/^\s*/, '') || null,
    excludedFromReleaseBy: inline('Excluded from release by'),
    failureModes: rows('Failure & recovery'),
    stateLifecycle: rows('State lifecycle'),
    egress: rows('Data & egress'),
    trustBoundaries: rows('Trust boundaries'),
    sinks: rows('Sinks'),
    longRunningWork: rows('Long-running work'),
    concurrencyModel: inline('Concurrency model'),
    offloaded: inline('Offloaded to a thread/process'),
    plannedFiles: planFiles,
    plannedTests: planTests.map(t => t.path),
    lastBuildStatus: null,
  };
}

// consumer index for shapes
for (const [cid, c] of Object.entries(components))
  for (const s of c.consumes)
    if (shapes[s] && !shapes[s].consumers.includes(cid)) shapes[s].consumers.push(cid);

// egress matrix (from C0's table)
const egressMatrix = [];
{
  const tbl = archText.split('### Egress matrix')[1] || '';
  for (const l of tbl.split('\n')) {
    const m = l.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (!m || /^-+$/.test(m[1]) || m[1] === 'Destination') continue;
    egressMatrix.push({
      destination: m[1],
      dataClasses: m[2].split(',').map(s => s.trim()),
      gate: m[3],
      default: m[4].replace(/\*/g, ''),
      owners: (m[5].match(/C\d+/g) || []),
    });
  }
}

// ---------- validation ----------
const errs = [];
for (const [fid, f] of Object.entries(features)) {
  const impls = Object.entries(components).filter(([, c]) => c.implements.includes(fid));
  if (!impls.length) errs.push(`F-ID ${fid} implemented by no component`);
  if (f.perfBudgets.length && !f.scale) errs.push(`${fid} has perf budgets but no scale:`);
}
for (const [cid, c] of Object.entries(components)) {
  if (cid !== 'C0' && !c.implements.length && cid !== 'C0') {
    if (cid !== 'C0') errs.push(`${cid} implements no F-ID`);
  }
  for (const b of ['releaseSurface', 'concurrencyModel']) if (!c[b]) errs.push(`${cid} missing ${b}`);
  for (const b of ['failureModes', 'egress', 'trustBoundaries']) if (!c[b].length) errs.push(`${cid} missing ${b}`);
  // "Long-running work: none — <justification>" is a valid declaration with no rows
  const lrw = block(comps.find(x => x.id === cid).body, 'Long-running work');
  if (!c.longRunningWork.length && !(lrw && /none/i.test(lrw.inline))) errs.push(`${cid} missing longRunningWork`);
  for (const s of c.consumes) if (!shapes[s]) errs.push(`${cid} consumes undeclared shape ${s}`);
}
for (const row of egressMatrix)
  if (row.dataClasses.some(d => /secret|pii/.test(d)) && /^on$/i.test(row.default) && /Anthropic|→|API/.test(row.destination))
    errs.push(`egress row "${row.destination}" defaults on for ${row.dataClasses}`);

// ---------- write ----------
const prev = JSON.parse(fs.readFileSync('.fractal/state.json', 'utf8'));
const state = {
  version: 1,
  createdAt: prev.createdAt,
  lastRecompile: null,
  lastArchitect: '2026-08-22T00:00:00Z',
  request: prev.request,
  stack: {
    // WHY carried forward: later phases (ui, delivery, smoke) write their own stack facts
    // here — startMarker, notFoundRoute, viewports — and tests read them. Rebuilding this
    // object from the literal alone silently deletes them. The literal still wins on every
    // key it names.
    ...(prev.stack || {}),
    language: 'typescript',
    framework: 'next@15 (App Router)',
    runtime: 'node>=20',
    store: 'sqlite (better-sqlite3)',
    testFramework: 'vitest',
    e2e: 'playwright',
    startCommand: 'npm run start',
    startPort: 31544,
    ports: { web: 31544 },
    portRange: [20000, 32767],
    externalTools: ['claude CLI'],
  },
  features,
  components,
  shapes,
  egressMatrix,
  files,
  tests,
  bugs: prev.bugs || {},
  hardening: {},
  delivery: null,
};

// WHY carried forward: uiRoutes is written by the ui phase from the routes a feature
// actually renders. It is not derivable from features.md, and the reachability test fails
// closed on a feature that declares e2e without them.
for (const [fid, f] of Object.entries(state.features)) {
  const before = (prev.features || {})[fid];
  if (before && before.uiRoutes && !f.uiRoutes) f.uiRoutes = before.uiRoutes;
}

if (errs.length) {
  console.error('VALIDATION FAILURES:\n' + errs.map(e => '  - ' + e).join('\n'));
  process.exit(1);
}
fs.writeFileSync('.fractal/state.json.tmp', JSON.stringify(state, null, 2));
fs.renameSync('.fractal/state.json.tmp', '.fractal/state.json');
console.log(`OK  features=${Object.keys(features).length} components=${Object.keys(components).length} shapes=${Object.keys(shapes).length} files=${Object.keys(files).length} tests=${Object.keys(tests).length} egressRows=${egressMatrix.length}`);
console.log('e2e tests planned:', Object.values(tests).filter(t => t.type === 'e2e').length);
