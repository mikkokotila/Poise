// Small, accessible-button glyphs; labels belong to their containing buttons.
const svg = (body: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
export const ICON_FORK = svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10v2a5 5 0 0 1-5 5H6"/>')
export const ICON_HANDOFF = svg('<path d="M14 4h6v6m0-6-9 9M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"/>')
export const ICON_ACTIVITY = svg('<path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/>')
export const ICON_AUTO_MERGE = svg('<circle cx="6" cy="5" r="2"/><circle cx="17" cy="19" r="2"/><path d="M6 7v2a8 8 0 0 0 8 8h3M17 4v11m-3-8 3-3 3 3M3 18l2 2 4-4"/>')
