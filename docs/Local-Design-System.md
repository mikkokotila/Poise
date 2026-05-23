# Local Design System v1

The visual contract for Poise. Every view should resolve through these
tokens — never raw hex values, never one-off shadows, never mid-weights
of sans, never italics.

The CSS implementation lives in [`src/style.css`](../src/style.css)
under `:root` (search for `Design System v1`).

---

## Color · Neutrals

| Token | Hex     | Use |
|-------|---------|-----|
| N0    | #F7F8F9 | app background |
| N1    | #EEF0F2 | panels, raised surfaces |
| N2    | #DEE2E6 | light dividers, hairlines |
| N3    | #C5CBD1 | borders, disabled fills |
| N4    | #8E959E | muted icons, dark-mode secondary text |
| N5    | #5C636D | secondary text on light |
| N6    | #2F353D | primary text on light |
| N7    | #161A20 | dark surfaces, maximum contrast |

## Color · Accents

| Token | Name   | Hex     | Use |
|-------|--------|---------|-----|
| A1    | Blue   | #3A72B0 | info, primary data, focus ring, drop indicator |
| A2    | Teal   | #3D8E84 | stable, active, secondary data |
| A3    | Green  | #4A8E5E | success, positive |
| A4    | Amber  | #A8792B | warning, pending |
| A5    | Red    | #B85048 | error, destructive |
| A6    | Rose   | #B0537B | risk, exception, categorical |
| A7    | Violet | #7560A8 | categorical, special state |
| A8    | Slate  | #6E7886 | neutral category, unknown, "other" |

### Dark-mode principle

Neutrals invert (N7 → N0 stack). Accents hold; raise surface tints
~25% alpha for badges.

---

## Typography

### Families

| Token | Primary  | Fallback        |
|-------|----------|-----------------|
| sans  | TBD      | IBM Plex Sans   |
| mono  | TBD      | IBM Plex Mono   |

### Weights (v1)

| Token         | Weight | Use |
|---------------|--------|-----|
| sans-regular  | 400    | body text |
| sans-semibold | 600    | titles, emphasis, primary buttons |
| mono-regular  | 400    | IDs, timestamps, hashes |
| mono-medium   | 500    | numeric emphasis only (optional) |

### Rules (v1)

- **No italics anywhere.**
- **No sans 500.** Only 400 and 600.
- Mono is for IDs, timestamps, hashes, serials, aligned numerics, and
  technical filter tokens. Mono ≠ texture, ≠ decoration.

---

## Spacing · 4-base scale

| Token | px |
|-------|----|
| sp-1  | 4  |
| sp-2  | 8  |
| sp-3  | 12 |
| sp-4  | 16 |
| sp-5  | 20 |
| sp-6  | 24 |
| sp-7  | 32 |
| sp-8  | 48 |
| sp-9  | 64 |

---

## Density

### Default — "calm" (shipped)

| Property        | Value |
|-----------------|-------|
| row height      | 36    |
| card padding    | 12    |
| card gap        | 10    |
| column padding  | 12    |

### Toggles

| Mode          | row | padding | gap |
|---------------|-----|---------|-----|
| compact       | 28  | 8       | 6   |
| comfortable   | 44  | 16      | 14  |

### Density rule — *rooms before furniture*

> Container padding ≥ row padding.

---

## Radii

| Token  | px  | Use |
|--------|-----|-----|
| r-0    | 0   | table cells, dividers, tight grids |
| r-sm   | 4   | buttons, inputs, **cards**, badges |
| r-md   | 8   | panels, modals, raised surfaces, table outer wrapper |
| r-full | 999 | avatars, status dots, single-line pills |

### Rules

- Inner radius = outer − padding.
- Table rows + cells: r-0 always.
- Pill (r-full): single-line short content only.

---

## Borders

| Token   | Spec                    | Use |
|---------|-------------------------|-----|
| b-hair  | 0.5px solid N2 (#DEE2E6) | table rows, internal dividers |
| b-base  | 1px solid N3 (#C5CBD1)   | cards, inputs, panels |
| b-focus | 2px solid A1 (#3A72B0)   | focus-visible only |

---

## Elevation · ladder

| Token | Spec                                                                        | Use |
|-------|-----------------------------------------------------------------------------|-----|
| e-0   | none                                                                        | resting cards, panels, table rows |
| e-1   | `0 1px 2px rgba(22,26,32,.06), 0 2px 4px rgba(22,26,32,.04)`                | hover, drag-active, inline popover |
| e-2   | `0 4px 8px rgba(22,26,32,.08), 0 2px 4px rgba(22,26,32,.05)`                | dropdowns, menus, tooltips |
| e-3   | `0 12px 24px rgba(22,26,32,.14), 0 4px 8px rgba(22,26,32,.06)`              | dialogs, modals |

### Depth rules

- Borders carry resting depth.
- Shadows appear on interaction, disappear on release.
- **Resting cards never carry shadow.**
- **Board card budget: e-0 at rest → e-1 on drag, nothing more.**

---

## Focus ring

| Property | Value |
|----------|-------|
| color    | A1 (#3A72B0) |
| width    | 2px |
| offset   | 2px from element edge |
| shape    | inherits element radius |

Never share token with `b-base` or `b-hair`. Implement with longhand
`outline-width / outline-style / outline-color / outline-offset`
because `var()` inside the `outline` shorthand expands inconsistently
across browsers.

---

## CSS variables

```css
:root {
  /* Neutrals */
  --n0: #F7F8F9; --n1: #EEF0F2; --n2: #DEE2E6; --n3: #C5CBD1;
  --n4: #8E959E; --n5: #5C636D; --n6: #2F353D; --n7: #161A20;

  /* Accents */
  --a1: #3A72B0; --a2: #3D8E84; --a3: #4A8E5E; --a4: #A8792B;
  --a5: #B85048; --a6: #B0537B; --a7: #7560A8; --a8: #6E7886;

  /* Borders */
  --b-hair:  0.5px solid var(--n2);
  --b-base:  1px   solid var(--n3);
  --b-focus: 2px   solid var(--a1);

  /* Elevation */
  --e-0: none;
  --e-1: 0 1px 2px rgba(22, 26, 32, .06), 0 2px 4px rgba(22, 26, 32, .04);
  --e-2: 0 4px 8px rgba(22, 26, 32, .08), 0 2px 4px rgba(22, 26, 32, .05);
  --e-3: 0 12px 24px rgba(22, 26, 32, .14), 0 4px 8px rgba(22, 26, 32, .06);
}
```

---

## Migration status

| View      | Status |
|-----------|--------|
| Pipe      | ✓ migrated |
| Main      | shared prose tokens, view-specific TBD |
| Flow      | shared prose tokens, view-specific TBD |
| Trust     | shared prose tokens, view-specific TBD |
| Swarm     | shared prose tokens, view-specific TBD |
| Settings  | shared prose tokens |
| Typography panel | shared prose tokens |

The legacy `--bg / --text / --border / --hover / --hairline / --accent /
--text-secondary / --text-tertiary` aliases are now bound to DS values
so unmigrated views inherit the DS look without per-rule edits. Per-view
migration replaces those aliases with DS tokens directly.
