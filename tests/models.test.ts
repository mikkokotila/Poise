import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG, CATALOG_STDOUT, NARROW_CATALOG } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))

const models = await import('../server/models')
const catalog = CATALOG as any
const narrow = NARROW_CATALOG as any

beforeEach(() => {
  models.invalidateCatalog()
  mocks.runFile.mockReset().mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
})

describe('the catalog Poise reads from Caller', () => {
  it('is read once per minute, not per launch', async () => {
    await models.loadCatalog()
    await models.loadCatalog()
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--models'], expect.objectContaining({ timeoutMs: 30_000 }))
  })

  it('refuses a Caller that does not export identities', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ opus: 'opus-5-high', astra: 'gpt-6-astra-xhigh', policy: 'bounded-v1' }), stderr: '' })
    await expect(models.loadCatalog()).rejects.toThrow('Update Caller')
    mocks.runFile.mockResolvedValue({ stdout: 'not json', stderr: '' })
    await expect(models.loadCatalog()).rejects.toThrow('Update Caller')
  })

  it('knows the provider behind every identity, and the retired Claude ones by prefix', () => {
    expect(models.isClaudeModel(catalog, 'opus-5-max')).toBe(true)
    expect(models.isClaudeModel(catalog, 'fable-5.1-xhigh')).toBe(true)
    expect(models.isClaudeModel(catalog, 'gpt-6-astra-ultra')).toBe(false)
    expect(models.isClaudeModel(catalog, 'grok-4.6-xhigh')).toBe(false)
    expect(models.isClaudeModel(catalog, 'gemini-3.8-flash-high')).toBe(false)
    expect(models.isClaudeModel(catalog, 'muse-spark-1.3-contributor-max')).toBe(false)
    // Rows the log still carries from before this catalog.
    expect(models.isClaudeModel(catalog, 'opus-4.8-max')).toBe(true)
    expect(models.isClaudeModel(catalog, 'opus-5-high')).toBe(true)
    expect(models.isClaudeModel(catalog, 'gpt-5.6-sol-ultra')).toBe(false)
    expect(models.isClaudeModel(null, 'opus-5-max')).toBe(true)
  })
})

describe('resolving a place against the live catalog', () => {
  it('seeds every place from the Caller default and the recovery model', () => {
    expect(models.resolveChoice(catalog, 'chat', undefined)).toEqual({ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', notes: [] })
    expect(models.resolveChoice(catalog, 'pr_approve', undefined)).toEqual({ default: 'opus-5-xhigh', fallback: 'gpt-6-astra-ultra', notes: [] })
  })

  it('seeds the PR review panel with one family per reviewer, the default first', () => {
    expect(models.resolveChoice(catalog, 'pr_review', undefined)).toEqual({
      default: 'opus-5-xhigh',
      fallback: 'gpt-6-astra-ultra',
      secondary: 'gpt-6-astra-ultra',
      tertiary: 'grok-4.6-xhigh',
      notes: [],
    })
    // A default from another family walks the debate participants from it outward.
    expect(models.resolveChoice(catalog, 'pr_review', { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' })).toMatchObject({
      secondary: 'opus-5-max',
      tertiary: 'gpt-6-astra-ultra',
    })
    // Fewer families than seats: the panel is still three different models.
    const claudeOnly = { ...catalog, review_providers: ['claude'] }
    expect(models.seedReviewers(claudeOnly, 'opus-5-max')).toEqual({ secondary: 'opus-5-xhigh', tertiary: 'fable-5.1-max' })
  })

  it('keeps stored reviewers and replaces a retired one with its seed', () => {
    const stored = { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'muse-spark-1.3-contributor-max', tertiary: 'gemini-3.8-flash-high' }
    expect(models.resolveChoice(catalog, 'pr_review', stored)).toEqual({ ...stored, notes: [] })
    const resolved = models.resolveChoice(catalog, 'pr_review', { ...stored, tertiary: 'gemini-3.1-pro-high' })
    expect(resolved.tertiary).toBe('grok-4.6-xhigh')
    expect(resolved.notes).toEqual(['gemini-3.1-pro-high is no longer in the catalog; using grok-4.6-xhigh.'])
  })

  it('lists the reviewers Behaviors asks for, primary first', () => {
    const choice = { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh', tertiary: 'muse-spark-1.3-contributor-max' }
    expect(models.reviewerModels(choice, 1)).toEqual([{ slot: 'primary', model: 'opus-5-max' }])
    expect(models.reviewerModels(choice, 2)).toEqual([{ slot: 'primary', model: 'opus-5-max' }, { slot: 'secondary', model: 'grok-4.6-xhigh' }])
    expect(models.reviewerModels(choice, 3).map((r) => r.slot)).toEqual(['primary', 'secondary', 'tertiary'])
    expect(models.reviewerModels(choice, 7).length).toBe(3)
    expect(models.reviewerModels({ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra' }, 3)).toEqual([{ slot: 'primary', model: 'opus-5-max' }])
  })

  it('keeps a stored choice while the catalog still has it', () => {
    const stored = { default: 'grok-4.6-xhigh', fallback: 'muse-spark-1.3-contributor-max' }
    expect(models.resolveChoice(catalog, 'chat', stored)).toEqual({ ...stored, notes: [] })
  })

  it('replaces a retired identity with the seed and says so', () => {
    const resolved = models.resolveChoice(catalog, 'pr_approve', { default: 'opus-5-high', fallback: 'gpt-6-astra-xhigh' })
    expect(resolved).toEqual({
      default: 'opus-5-xhigh',
      fallback: 'gpt-6-astra-ultra',
      notes: [
        'opus-5-high is no longer in the catalog; using opus-5-xhigh.',
        'gpt-6-astra-xhigh is no longer in the catalog; using gpt-6-astra-ultra.',
      ],
    })
  })

  it('lets a review place use any provider Caller lists as reviewing', () => {
    const stored = { default: 'grok-4.6-xhigh', fallback: 'muse-spark-1.3-contributor-max' }
    expect(models.resolveChoice(catalog, 'pr_review', stored)).toMatchObject({ ...stored, notes: [] })
    expect(models.resolveChoice(catalog, 'pr_approve', { default: 'gemini-3.8-flash-high', fallback: 'gpt-5.6-sol-ultra' })).toEqual({ default: 'gemini-3.8-flash-high', fallback: 'gpt-5.6-sol-ultra', notes: [] })
  })

  it('never resolves a review place to a model its providers cannot review with', () => {
    const resolved = models.resolveChoice(narrow, 'pr_review', { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' })
    expect(resolved.default).toBe('opus-5-xhigh')
    expect(resolved.fallback).toBe('opus-5-max')
    expect(resolved.notes[0]).toContain('grok-4.6-xhigh is no longer in the catalog')
  })
})

describe('validating what the settings pane saves', () => {
  it('accepts catalog identities per known place and returns only those', () => {
    const next = models.validateModelSettings(catalog, {
      chat: { default: 'gemini-3.8-flash-high', fallback: 'opus-5-max', extra: 'ignored' },
      pr_review: { default: 'muse-spark-1.3-contributor-max', fallback: 'grok-4.6-high' },
    })
    expect(next).toEqual({
      chat: { default: 'gemini-3.8-flash-high', fallback: 'opus-5-max' },
      pr_review: { default: 'muse-spark-1.3-contributor-max', fallback: 'grok-4.6-high' },
    })
  })

  it('accepts reviewers for the PR review place only, each a different model', () => {
    const saved = models.validateModelSettings(catalog, {
      pr_review: { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh', tertiary: 'muse-spark-1.3-contributor-max' },
      pr_approve: { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh' },
    })
    expect(saved.pr_review).toEqual({ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh', tertiary: 'muse-spark-1.3-contributor-max' })
    expect(saved.pr_approve).toEqual({ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra' })
    expect(models.validateModelSettings(catalog, { pr_review: { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh' } }).pr_review)
      .toEqual({ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh' })
    for (const [choice, message] of [
      [{ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'opus' }, /PR review secondary must be a model from the catalog/],
      [{ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'opus-5-max' }, /secondary reviewer must differ from its default/],
      [{ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh', tertiary: 'grok-4.6-xhigh' }, /tertiary reviewer must differ/],
      [{ default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', tertiary: 'opus-5-max' }, /tertiary reviewer must differ/],
    ] as const) {
      expect(() => models.validateModelSettings(catalog, { pr_review: choice })).toThrow(message)
    }
    expect(() => models.validateModelSettings(narrow, { pr_review: { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh' } }))
      .toThrow(/PR review secondary must be a claude or codex model/)
  })

  it('holds a review place to the providers an older Caller lists', () => {
    expect(() => models.validateModelSettings(narrow, { pr_review: { default: 'muse-spark-1.3-contributor-max', fallback: 'opus-5-xhigh' } }))
      .toThrow(/PR review default must be a claude or codex model/)
  })

  it.each([
    [{ chat: { default: 'opus', fallback: 'opus-5-max' } }, /Chat default must be a model from the catalog/],
    [{ pr_approve: { default: 'opus-5-xhigh', fallback: 'opus-5-xhigh' } }, /PR approval fallback must differ/],
    [{ canary: { default: 'opus-5-max', fallback: 'opus-5-xhigh' } }, /unknown model place canary/],
    ['opus-5-max', /object of places/],
  ])('rejects %j', (value, message) => {
    expect(() => models.validateModelSettings(catalog, value)).toThrow(message)
  })
})
