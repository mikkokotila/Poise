const TYPO_KEY = 'poise-typo'
/* Bump this when DEFAULTS shifts in a way old saved prefs should be wiped.
   ds-v1 = bound the defaults to Design System v1 neutrals/accents. */
const TYPO_VERSION_KEY = 'poise-typo-version'
const TYPO_VERSION = 'ds-v1'

interface TypoConfig {
  archetype: string
  baseFontSize: number      // html font-size (px) — scales everything
  lineHeight: number        // body line-height
  // Editor — gap below paragraphs and headings in the writer view.
  // Controls margin-bottom on .editor-line[data-kind="body"] and on
  // h1/h2 respectively. Default paragraph spacing is 0 because the
  // editor's natural paragraph break is an empty markdown line; users
  // can dial it up if they want CSS-driven spacing without empty lines.
  paragraphSpacing: number  // editor body line margin-bottom (px)
  headingSpacing: number    // editor h1/h2 line margin-bottom (px)
  rowFontSize: number       // td font-size (rem)
  rowPadding: number        // td vertical padding (px)
  titleWeight: number       // title link font-weight
  headerSize: number        // thead th font-size (rem)
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
}

const ARCHETYPES: Record<string, Archetype> = {
  engineer:   { label: 'Engineer',   body: 'IBM Plex Sans',    heading: 'Rajdhani' },
  editor:     { label: 'Editor',     body: 'Lato',             heading: 'Playfair Display' },
  minimalist: { label: 'Minimalist', body: 'Manrope',          heading: 'Space Grotesk' },
  companion:  { label: 'Companion',  body: 'Nunito',           heading: 'Rubik' },
  auteur:     { label: 'Auteur',     body: 'Work Sans',        heading: 'Syne' },
}

const DEFAULTS: TypoConfig = {
  archetype: 'engineer',
  baseFontSize: 15,
  lineHeight: 1.5,
  paragraphSpacing: 0,      // no extra gap by default (markdown-empty-line idiom)
  headingSpacing: 8,         // mild after-heading breathing room
  rowFontSize: 0.8125,
  rowPadding: 11,
  titleWeight: 600,         // sans-semibold per DS (400 and 600 only)
  headerSize: 0.6875,
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
      { key: 'paragraphSpacing', label: 'Paragraph spacing', min: 0, max: 32, step: 1, fmt: fPx },
      { key: 'headingSpacing',   label: 'Heading spacing',   min: 0, max: 32, step: 1, fmt: fPx },
    ],
  },
  {
    label: 'Tables',
    sliders: [
      { key: 'contentWidth', label: 'Content width', min: 600,    max: 1400,  step: 20,     fmt: fPx },
      { key: 'rowFontSize',  label: 'Row text size', min: 0.6875, max: 1.0,   step: 0.0625, fmt: fRem },
      { key: 'rowPadding',   label: 'Row density',   min: 6,      max: 18,    step: 1,      fmt: fPx },
      /* DS sans allows 400 and 600 only — step 200 keeps the slider snapped to those */
      { key: 'titleWeight',  label: 'Title weight',  min: 400,    max: 600,   step: 200,    fmt: f0 },
      { key: 'headerSize',   label: 'Header size',   min: 0.5625, max: 0.875, step: 0.0625, fmt: fRem },
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

  // Font
  root.style.setProperty('--typo-body', `'${arch.body}', sans-serif`)
  root.style.setProperty('--typo-heading', `'${arch.heading}', sans-serif`)
  root.style.setProperty('--typo-size', `${config.baseFontSize}px`)
  root.style.setProperty('--typo-lh', `${config.lineHeight}`)
  root.style.setProperty('--typo-row-size', `${config.rowFontSize}rem`)
  root.style.setProperty('--typo-row-pad', `${config.rowPadding}px`)
  root.style.setProperty('--typo-title-weight', `${config.titleWeight}`)
  root.style.setProperty('--typo-header-size', `${config.headerSize}rem`)
  root.style.setProperty('--typo-width', `${config.contentWidth}px`)
  root.style.setProperty('--typo-comment-lines', `${config.commentLines}`)
  root.style.setProperty('--typo-comment-size', `${config.commentFontSize}rem`)
  root.style.setProperty('--typo-comment-weight', `${config.commentFontWeight}`)

  // Editor-specific derived sizes. The editor needs prose-friendly
  // sizes that scale WITH the panel's base size — typography controls
  // need to actually move the editor — but its size hierarchy is its
  // own (body larger than dashboard text; H1/H2 in heading-typical
  // proportions). We derive from baseFontSize via fixed +offsets so
  // the relationships stay constant across the slider's range:
  //   body = base + 4   (15→19, 12→16, 20→24)
  //   h1   = base + 13  (15→28)
  //   h2   = base + 7   (15→22)
  // Line-heights stay pinned to whole pixels — fractional line-height
  // breaks contenteditable cursor alignment when different lines
  // have different font sizes (the wrap-and-baseline math diverges).
  // We multiply by the panel's lineHeight ratio and floor.
  const editorBody = config.baseFontSize + 4
  const editorH1   = config.baseFontSize + 13
  const editorH2   = config.baseFontSize + 7
  root.style.setProperty('--editor-body-size', `${editorBody}px`)
  root.style.setProperty('--editor-h1-size',   `${editorH1}px`)
  root.style.setProperty('--editor-h2-size',   `${editorH2}px`)
  root.style.setProperty('--editor-body-lh', `${Math.floor(editorBody * config.lineHeight)}px`)
  root.style.setProperty('--editor-h1-lh',   `${Math.floor(editorH1   * config.lineHeight)}px`)
  root.style.setProperty('--editor-h2-lh',   `${Math.floor(editorH2   * config.lineHeight)}px`)

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
