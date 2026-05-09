const TYPO_KEY = 'poise-typo'
/* Bump this when DEFAULTS shifts in a way old saved prefs should be wiped.
   ds-v1 = bound the defaults to Design System v1 neutrals/accents. */
const TYPO_VERSION_KEY = 'poise-typo-version'
/* ds-v2 = renamed headerSize → headingSize (rem→px), titleWeight →
   headingWeight (range 400-600→400-800), added Writer archetype.
   Version bump wipes prefs once so the new unit / range / archetype
   defaults take effect without unit-mismatched stored values. */
const TYPO_VERSION = 'ds-v2'

interface TypoConfig {
  archetype: string
  baseFontSize: number      // html font-size (px) — scales everything
  lineHeight: number        // body line-height
  // Editor — gap below paragraphs and around headings in the writer
  // view. Both can go negative (down to -16) so the writer can pull
  // lines closer than the natural line-height alone permits — the
  // CSS engine subtracts margin from the inter-line distance, so a
  // negative paragraphSpacing produces tighter-than-leading rhythm.
  paragraphSpacing: number  // editor body line margin-bottom (px)
  headingSpacing: number    // editor h1/h2 margin-top + bottom (px)
  // Heading line-height is independent of the global Type "Line
  // height" — that one stays the body-line multiplier; this one
  // multiplies just heading sizes. Default 1.5 matches what Type's
  // line-height was producing for headings before this slider
  // existed, so the visual is preserved on first open.
  headingLineHeight: number // editor h1/h2 line-height multiplier
  rowFontSize: number       // td font-size (rem)
  rowPadding: number        // td vertical padding (px)
  headingWeight: number     // editor h1/h2 + kanban title-link weight
  headingSize: number       // editor h1 size (px); h2 derives as h1 - 6
  contentWidth: number      // #app max-width (px)
  commentLines: number      // inline-comment line clamp
  commentFontSize: number   // inline-comment font-size (rem)
  commentFontWeight: number // inline-comment font-weight
  textColor: string         // --text
  textSecondary: string     // --text-secondary
  textTertiary: string      // --text-tertiary
  bgColor: string           // --bg
  borderColor: string       // --border
  hoverColor: string        // --hover
  accentColor: string       // --accent
}

interface Archetype {
  label: string
  body: string
  heading: string
  // Generic fallback class for the body / heading. The hardcoded
  // `sans-serif` fallback that was here before mis-classified any
  // serif archetype while the Google Font was loading; explicit
  // per-archetype fallback fixes that and lets Writer (serif body)
  // degrade gracefully to a system serif rather than a system sans.
  bodyFallback: 'sans-serif' | 'serif' | 'monospace'
  headingFallback: 'sans-serif' | 'serif' | 'monospace'
}

const ARCHETYPES: Record<string, Archetype> = {
  engineer:   { label: 'Engineer',   body: 'IBM Plex Sans',    heading: 'Rajdhani',         bodyFallback: 'sans-serif', headingFallback: 'sans-serif' },
  editor:     { label: 'Editor',     body: 'Lato',             heading: 'Playfair Display', bodyFallback: 'sans-serif', headingFallback: 'serif' },
  // Writer — purposefully single-family. Every other archetype pairs
  // two contrasting faces; Writer's distinction in the set IS that
  // it doesn't pair. Lora (Cyreal, 2011, Google Fonts) was designed
  // specifically as a screen-reading body serif: calligraphic roots,
  // four weights, a paired italic that's actually drawn rather than
  // sloped, vertical metrics tuned for prose density. Lora at 700
  // is dramatic enough to hold a heading without needing a separate
  // display face — and the same letterforms above and below give
  // the writer's page the unbroken consistency that feels right for
  // long-form work.
  writer:     { label: 'Writer',     body: 'Lora',             heading: 'Lora',             bodyFallback: 'serif',      headingFallback: 'serif' },
  minimalist: { label: 'Minimalist', body: 'Manrope',          heading: 'Space Grotesk',    bodyFallback: 'sans-serif', headingFallback: 'sans-serif' },
  companion:  { label: 'Companion',  body: 'Nunito',           heading: 'Rubik',            bodyFallback: 'sans-serif', headingFallback: 'sans-serif' },
  auteur:     { label: 'Auteur',     body: 'Work Sans',        heading: 'Syne',             bodyFallback: 'sans-serif', headingFallback: 'sans-serif' },
}

const DEFAULTS: TypoConfig = {
  archetype: 'engineer',
  baseFontSize: 15,
  lineHeight: 1.5,
  paragraphSpacing: 0,      // no extra gap by default (markdown-empty-line idiom)
  headingSpacing: 8,        // mild after-heading breathing room
  headingLineHeight: 1.5,    // matches what Type's line-height produced before
  rowFontSize: 0.8125,
  rowPadding: 11,
  headingWeight: 700,       // 700 (bold) for editor h1; h2 derives as 700-100=600
  headingSize: 28,          // editor h1 px; h2 = h1 - 6 = 22 by default
  contentWidth: 960,
  commentLines: 4,
  commentFontSize: 0.75,
  commentFontWeight: 400,
  /* DS v1 colors — match :root --n0..--n7 / --a*. Users can still
     customize from the panel; "Reset to defaults" returns to these. */
  textColor: '#2F353D',         // N6
  textSecondary: '#5C636D',     // N5
  textTertiary: '#8E959E',      // N4
  bgColor: '#F7F8F9',           // N0
  borderColor: '#C5CBD1',       // N3
  hoverColor: '#EEF0F2',        // N1
  accentColor: '#161A20',       // N7
}

interface SliderDef {
  key: keyof TypoConfig
  label: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
}

const f0 = (v: number) => String(Math.round(v))
const f2 = (v: number) => v.toFixed(2)
const fPx = (v: number) => `${Math.round(v)}px`
// Show rem rounded + effective px (assumes base = config.baseFontSize)
const fRem = (v: number) => {
  const base = config.baseFontSize
  const px = Math.round(v * base)
  return `${px}px`
}

interface SliderGroup {
  label: string
  sliders: SliderDef[]
}

// Sliders are organised into named groups so the panel reads as four
// separate concerns rather than a flat ladder of unrelated knobs.
// Order matters — the panel renders groups top-down. Type controls
// the global feel; Editor is writer-view-only; Tables covers the
// kanban / archive list density; Comments tunes the inline-comment
// snippets on cards.
const SLIDER_GROUPS: SliderGroup[] = [
  {
    label: 'Type',
    sliders: [
      { key: 'baseFontSize', label: 'Base font size', min: 12,  max: 20,  step: 1,    fmt: fPx },
      { key: 'lineHeight',   label: 'Line height',    min: 1.2, max: 2.0, step: 0.05, fmt: f2 },
    ],
  },
  {
    label: 'Editor',
    sliders: [
      // Spacing ranges allow negative values down to -16 so the writer
      // can pull lines tighter than the natural leading. Negative
      // margin subtracts from inter-line distance; with body
      // line-height around 28-32px there's headroom to compress
      // without overlap, and headings (with their own line-height +
      // surrounding margins) can compress further.
      { key: 'paragraphSpacing',  label: 'Paragraph spacing',   min: -16, max: 32,  step: 1,    fmt: fPx },
      { key: 'headingSpacing',    label: 'Heading spacing',     min: -16, max: 32,  step: 1,    fmt: fPx },
      // Heading line-height multiplier — independent of the global
      // Type "Line height" (which now controls only body lines). At
      // the default 1.5 the editor's headings render exactly as they
      // did when the global slider drove them; tighten to 1.1-1.2 for
      // dense display headings, loosen up to 2.0 for airy chapter
      // openers. Values get floor-multiplied with headingSize for a
      // whole-pixel line-height (cursor-alignment requirement).
      { key: 'headingLineHeight', label: 'Heading line height', min: 1.0, max: 2.0, step: 0.05, fmt: f2 },
      // Heading size sets the editor's H1 in pixels; H2 derives as
      // H1 - 6 (matching the prior 28/22 default delta). Range 20–48
      // covers austere prose-headings through dramatic display sizes
      // without leaving the prose page.
      { key: 'headingSize',       label: 'Heading size',        min: 20,  max: 48,  step: 1,    fmt: fPx },
      // Heading weight drives both editor H1 (= weight + 100, capped
      // at 900) and editor H2 (= weight). Range 400–800 step 100
      // covers the loaded weights from Google Fonts (400/500/600/700/
      // 800) without exposing weights that aren't in the linked CSS.
      // The same value also powers --typo-heading-weight which the
      // kanban title-link uses, so heading visual coherence holds
      // across the writer view and the dashboard.
      { key: 'headingWeight',     label: 'Heading weight',      min: 400, max: 800, step: 100,  fmt: f0 },
    ],
  },
  {
    label: 'Tables',
    sliders: [
      { key: 'contentWidth', label: 'Content width', min: 600,    max: 1400, step: 20,     fmt: fPx },
      { key: 'rowFontSize',  label: 'Row text size', min: 0.6875, max: 1.0,  step: 0.0625, fmt: fRem },
      { key: 'rowPadding',   label: 'Row density',   min: 6,      max: 18,   step: 1,      fmt: fPx },
    ],
  },
  {
    label: 'Comments',
    sliders: [
      { key: 'commentLines',      label: 'Comment lines',  min: 1,     max: 10,     step: 1,      fmt: f0 },
      { key: 'commentFontSize',   label: 'Comment size',   min: 0.625, max: 0.9375, step: 0.0625, fmt: fRem },
      { key: 'commentFontWeight', label: 'Comment weight', min: 300,   max: 600,    step: 100,    fmt: f0 },
    ],
  },
]

interface ColorDef {
  key: keyof TypoConfig
  label: string
}

const COLORS: ColorDef[] = [
  { key: 'textColor',     label: 'Text' },
  { key: 'textSecondary', label: 'Secondary' },
  { key: 'textTertiary',  label: 'Tertiary' },
  { key: 'accentColor',   label: 'Accent' },
  { key: 'bgColor',       label: 'Background' },
  { key: 'borderColor',   label: 'Borders' },
  { key: 'hoverColor',    label: 'Hover' },
]

let config: TypoConfig = { ...DEFAULTS }
let panelEl: HTMLElement | null = null
const fontsLoaded = new Set<string>()

function load(): TypoConfig {
  try {
    const stored = localStorage.getItem(TYPO_VERSION_KEY)
    if (stored !== TYPO_VERSION) {
      // Stale prefs from a previous default palette — wipe so the user
      // picks up the DS defaults. Their explicit customizations will be
      // lost; this only happens once per major DS revision.
      localStorage.removeItem(TYPO_KEY)
      localStorage.setItem(TYPO_VERSION_KEY, TYPO_VERSION)
      return { ...DEFAULTS }
    }
    const raw = localStorage.getItem(TYPO_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULTS }
}

function save() {
  localStorage.setItem(TYPO_KEY, JSON.stringify(config))
}

function loadFont(name: string) {
  if (fontsLoaded.has(name)) return
  fontsLoaded.add(name)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;500;600;700;800&display=swap`
  document.head.appendChild(link)
}

function apply() {
  const root = document.documentElement
  const arch = ARCHETYPES[config.archetype] || ARCHETYPES.engineer

  loadFont(arch.body)
  loadFont(arch.heading)

  // Font — per-archetype fallback, so a serif archetype degrades to a
  // system serif (and vice versa) rather than always sans-serif while
  // the Google Font is in flight or if the network blocks Google.
  root.style.setProperty('--typo-body',    `'${arch.body}', ${arch.bodyFallback}`)
  root.style.setProperty('--typo-heading', `'${arch.heading}', ${arch.headingFallback}`)
  root.style.setProperty('--typo-size', `${config.baseFontSize}px`)
  root.style.setProperty('--typo-lh', `${config.lineHeight}`)
  root.style.setProperty('--typo-row-size', `${config.rowFontSize}rem`)
  root.style.setProperty('--typo-row-pad', `${config.rowPadding}px`)
  // Heading weight — single var that drives editor headings and the
  // kanban title-link. Coherent "make headings bolder" affects both.
  root.style.setProperty('--typo-heading-weight', `${config.headingWeight}`)
  root.style.setProperty('--typo-width', `${config.contentWidth}px`)
  root.style.setProperty('--typo-comment-lines', `${config.commentLines}`)
  root.style.setProperty('--typo-comment-size', `${config.commentFontSize}rem`)
  root.style.setProperty('--typo-comment-weight', `${config.commentFontWeight}`)

  // Editor-specific sizes.
  //   - Body still scales with --typo-size (base + 4) — body text
  //     should follow the global size choice.
  //   - H1 / H2 are now driven by the explicit "Heading size" slider
  //     (config.headingSize), no longer a fixed offset off base. H2
  //     stays 6px below H1 to preserve hierarchy.
  // Line-heights are pinned to whole pixels — fractional line-height
  // breaks contenteditable cursor alignment when lines have different
  // font sizes (the baseline math diverges). We multiply by the
  // panel's lineHeight ratio and floor.
  const editorBody = config.baseFontSize + 4
  const editorH1   = config.headingSize
  const editorH2   = Math.max(config.baseFontSize, config.headingSize - 6)
  root.style.setProperty('--editor-body-size', `${editorBody}px`)
  root.style.setProperty('--editor-h1-size',   `${editorH1}px`)
  root.style.setProperty('--editor-h2-size',   `${editorH2}px`)
  root.style.setProperty('--editor-body-lh', `${Math.floor(editorBody * config.lineHeight)}px`)
  // Heading line-heights use config.headingLineHeight (the Editor
  // group's "Heading line height" slider), not the global lineHeight,
  // so the writer can tighten leading on display text without
  // affecting body rhythm. Whole-pixel floor preserves cursor
  // alignment when lines of different sizes share the page.
  root.style.setProperty('--editor-h1-lh', `${Math.floor(editorH1 * config.headingLineHeight)}px`)
  root.style.setProperty('--editor-h2-lh', `${Math.floor(editorH2 * config.headingLineHeight)}px`)
  // Editor heading weights — H1 is one step heavier than the slider's
  // value (capped at 900); H2 is the slider value. The +100 keeps the
  // visual hierarchy without a second slider; the cap stops the math
  // from sliding off the loaded font weights (Google Fonts loads up
  // to 800 in our link tag).
  root.style.setProperty('--editor-h1-weight', `${Math.min(900, config.headingWeight + 100)}`)
  root.style.setProperty('--editor-h2-weight', `${config.headingWeight}`)

  // After-paragraph and after-heading spacing — applied as
  // margin-bottom on the matching line kinds in the editor. These
  // are deliberately separate from line-height: line-height is
  // intra-paragraph leading, the spacing below is the inter-block
  // gap that decides how the document breathes between paragraphs
  // and headings.
  root.style.setProperty('--editor-paragraph-spacing', `${config.paragraphSpacing}px`)
  root.style.setProperty('--editor-heading-spacing',   `${config.headingSpacing}px`)

  // Colors are governed by the DS / theme system (see [data-theme="dark"]
  // overrides in style.css). Setting them inline here would beat the
  // theme cascade because inline-style specificity is (1,0,0,0). The
  // typo config still carries color fields for forward compatibility,
  // but writing them as inline overrides is suppressed by default.
  // (If we want a per-user color customizer later, reintroduce these
  // setProperty calls behind a "dirty" flag that tracks whether the
  // user has actually deviated from DS defaults.)
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'typo-panel'
  panel.innerHTML = `<div class="tp-header"><span class="tp-title">Typography</span></div><div class="tp-body"></div>`

  const body = panel.querySelector('.tp-body')!

  // Archetype selector
  const archSection = document.createElement('div')
  archSection.className = 'tp-section'
  archSection.innerHTML = `<label class="tp-label">Archetype</label><select class="tp-select"></select>`
  const sel = archSection.querySelector('select')!
  for (const [key, arch] of Object.entries(ARCHETYPES)) {
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = arch.label
    if (key === config.archetype) opt.selected = true
    sel.appendChild(opt)
  }
  sel.addEventListener('change', () => {
    config.archetype = sel.value
    save()
    apply()
  })
  body.appendChild(archSection)

  // Section label
  const addLabel = (text: string) => {
    const lbl = document.createElement('div')
    lbl.className = 'tp-group-label'
    lbl.textContent = text
    body.appendChild(lbl)
  }

  // Helper: render a single slider section.
  const addSlider = (def: SliderDef) => {
    const section = document.createElement('div')
    section.className = 'tp-section'
    const val = config[def.key] as number
    section.innerHTML = `
      <div class="tp-row"><label class="tp-label">${def.label}</label><span class="tp-val">${def.fmt(val)}</span></div>
      <input type="range" class="tp-range" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
    `
    const input = section.querySelector('input')!
    const valEl = section.querySelector('.tp-val')!
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      (config[def.key] as number) = v
      valEl.textContent = def.fmt(v)
      save()
      apply()
    })
    body.appendChild(section)
  }

  // Render each slider group with its label.
  for (const group of SLIDER_GROUPS) {
    addLabel(group.label)
    for (const def of group.sliders) addSlider(def)
  }

  addLabel('Colors')

  // Color pickers
  for (const def of COLORS) {
    const section = document.createElement('div')
    section.className = 'tp-section tp-color-section'
    section.innerHTML = `
      <label class="tp-label">${def.label}</label>
      <input type="color" class="tp-color" value="${config[def.key]}">
    `
    const input = section.querySelector('input')!
    input.addEventListener('input', () => {
      (config[def.key] as string) = input.value
      save()
      apply()
    })
    body.appendChild(section)
  }

  // Reset
  const reset = document.createElement('button')
  reset.className = 'tp-reset'
  reset.textContent = 'Reset to defaults'
  reset.addEventListener('click', () => {
    config = { ...DEFAULTS }
    save()
    apply()
    const parent = panel.parentElement!
    panel.remove()
    panelEl = buildPanel()
    parent.appendChild(panelEl)
    panelEl.classList.add('open')
  })
  body.appendChild(reset)

  return panel
}

export function initTypography() {
  config = load()
  apply()

  panelEl = buildPanel()
  document.body.appendChild(panelEl)
}

export function openTypographyPanel() {
  if (panelEl) panelEl.classList.add('open')
}

export function toggleTypographyPanel() {
  if (panelEl) panelEl.classList.toggle('open')
}
