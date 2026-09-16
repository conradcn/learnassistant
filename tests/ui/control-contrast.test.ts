import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WCAG 2.2 SC 1.4.11 Non-text Contrast: the visual boundary of a user interface
 * component must reach 3:1 against adjacent colours. For a bordered control that
 * means BOTH sides of the border -- the surface the control sits on, and the
 * control's own fill -- because a border that only clears the page background is
 * still invisible where it meets the button it is drawing.
 */

const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8')

const vars: Record<string, string> = (() => {
  const start = css.indexOf(':root')
  const root = css.slice(start, css.indexOf('\n}', start))
  const found: Record<string, string> = {}
  for (const line of root.split('\n')) {
    const [name, ...rest] = line.split(':')
    const value = rest.join(':').trim().replace(/;$/, '')
    if (name.trim().startsWith('--') && value.startsWith('#')) found[name.trim()] = value
  }
  return found
})()

/** Resolves `var(--line-strong)` or a literal `#222a36` to a hex string. */
function resolve(value: string): string {
  const trimmed = value.trim()
  const hex = trimmed.startsWith('var(')
    ? vars[trimmed.slice(4, trimmed.indexOf(')')).trim()]
    : trimmed
  if (!hex || hex.length !== 7 || !hex.startsWith('#')) {
    throw new Error(`could not resolve colour ${JSON.stringify(value)}`)
  }
  return hex
}

/** The body of the first rule whose selector list is written exactly as `selector`. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {\n`)
  if (at < 0) throw new Error(`no rule for selector ${JSON.stringify(selector)}`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('\n}', open))
}

/** Reads one declaration out of that rule, ignoring comments and shorthand look-alikes. */
function declaration(selector: string, property: string): string {
  for (const line of ruleBody(selector).split('\n')) {
    const code = line.split('/*')[0].trim()
    if (code.startsWith(`${property}:`)) {
      return code.slice(property.length + 1).replace(/;$/, '').trim()
    }
  }
  throw new Error(`no ${property} in rule for ${JSON.stringify(selector)}`)
}

/** `border: 1px solid <colour>` -- the colour is the last space-separated part. */
function borderColor(selector: string): string {
  const parts = declaration(selector, 'border').split(' ')
  return resolve(parts[parts.length - 1])
}

function channel(component: number): number {
  const c = component / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const INPUTS = 'input,\nselect,\ntextarea'
const INPUTS_HOVER = 'input:hover,\nselect:hover,\ntextarea:hover'
const INPUTS_FOCUS = 'input:focus,\nselect:focus,\ntextarea:focus'

/** Every surface a control is painted on somewhere in the app. */
const SURFACES = ['--bg', '--panel', '--panel-sunk'] as const

const CONTROLS = [
  {
    name: 'button',
    border: borderColor('button'),
    fills: {
      'rest fill': resolve(declaration('button', 'background')),
      'hover fill': resolve(declaration('button:hover', 'background')),
    },
  },
  {
    name: '.la-btn-link',
    border: borderColor('.la-btn-link'),
    fills: { fill: resolve(declaration('.la-btn-link', 'background')) },
  },
  {
    name: 'input, select, textarea',
    border: borderColor(INPUTS),
    fills: { fill: resolve(declaration(INPUTS, 'background')) },
  },
  {
    name: 'input, select, textarea (hover)',
    border: resolve(declaration(INPUTS_HOVER, 'border-color')),
    fills: { fill: resolve(declaration(INPUTS, 'background')) },
  },
]

describe('control boundaries meet WCAG 1.4.11 (3:1 non-text contrast)', () => {
  for (const control of CONTROLS) {
    for (const token of SURFACES) {
      it(`${control.name}: border ${control.border} against surface ${token}`, () => {
        expect(contrastRatio(control.border, resolve(`var(${token})`))).toBeGreaterThanOrEqual(3)
      })
    }

    for (const [label, fill] of Object.entries(control.fills)) {
      it(`${control.name}: border ${control.border} against its own ${label} ${fill}`, () => {
        expect(contrastRatio(control.border, fill)).toBeGreaterThanOrEqual(3)
      })
    }
  }

  it('does not weaken the focus ring', () => {
    // The focus indicator was already well past the floor; regressing it to buy
    // border contrast would trade one failure for another.
    const ring = resolve(declaration(INPUTS_FOCUS, 'border-color'))
    expect(contrastRatio(ring, resolve('var(--panel-sunk)'))).toBeGreaterThanOrEqual(3)
  })

  it('never draws a control boundary with the decorative --line token', () => {
    for (const selector of ['button', '.la-btn-link', INPUTS]) {
      expect(declaration(selector, 'border')).not.toContain('var(--line)')
    }
  })
})

/**
 * SC 1.4.3 Contrast (Minimum): text needs 4.5:1. Two colours in this app are text that
 * a reader has to actually read -- the placeholder (settings uses one to say a blank
 * second API-key field inherits the first) and KaTeX's error colour, which paints the
 * raw source of an unparseable formula and so is the entire content of that formula.
 */
describe('informative text meets WCAG 1.4.3 (4.5:1)', () => {
  it('placeholder text against the field it sits in', () => {
    const placeholder = resolve(declaration('::placeholder', 'color'))
    expect(contrastRatio(placeholder, resolve('var(--panel-sunk)'))).toBeGreaterThanOrEqual(4.5)
  })

  const errorColor = (() => {
    const math = readFileSync(join(process.cwd(), 'src', 'ui', 'math.ts'), 'utf8')
    const match = math.match(/errorColor:\s*'(#[0-9a-fA-F]{6})'/)
    if (!match) throw new Error('no errorColor in src/ui/math.ts')
    return match[1]
  })()

  // Math is typeset inside cards (--panel) and directly on the page (--bg); the inline
  // style KaTeX emits survives sanitising, so this colour is what the learner sees.
  for (const token of ['--panel', '--bg'] as const) {
    it(`KaTeX error colour ${errorColor} against ${token}`, () => {
      expect(contrastRatio(errorColor, resolve(`var(${token})`))).toBeGreaterThanOrEqual(4.5)
    })
  }
})
