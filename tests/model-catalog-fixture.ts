// The shape of what `agent-interface --models` prints: one row per identity
// <family>-<version>-<effort>, the top efforts of the latest model per family
// (Claude keeps Opus and Fable, Codex Astra and Sol), the default per Caller
// behavior, and the providers that can review — every one of them since Caller
// #39, Claude with governed tools and the others with a structured verdict.

export const CATALOG = {
  schema_version: 2,
  path: '/caller/agent_interface/models.toml',
  models: [
    { identity: 'opus-5-max', provider: 'claude', selector: 'claude-opus-5', effort: 'max' },
    { identity: 'opus-5-xhigh', provider: 'claude', selector: 'claude-opus-5', effort: 'xhigh' },
    { identity: 'fable-5.1-max', provider: 'claude', selector: 'claude-fable-5-1', effort: 'max' },
    { identity: 'fable-5.1-xhigh', provider: 'claude', selector: 'claude-fable-5-1', effort: 'xhigh' },
    { identity: 'gpt-6-astra-ultra', provider: 'codex', selector: 'gpt-6-astra', effort: 'ultra' },
    { identity: 'gpt-6-astra-max', provider: 'codex', selector: 'gpt-6-astra', effort: 'max' },
    { identity: 'gpt-5.6-sol-ultra', provider: 'codex', selector: 'gpt-5.6-sol', effort: 'ultra' },
    { identity: 'gpt-5.6-sol-max', provider: 'codex', selector: 'gpt-5.6-sol', effort: 'max' },
    { identity: 'grok-4.6-xhigh', provider: 'grok', selector: 'grok-4.6', effort: 'xhigh' },
    { identity: 'grok-4.6-high', provider: 'grok', selector: 'grok-4.6', effort: 'high' },
    { identity: 'gemini-3.8-flash-high', provider: 'antigravity', selector: 'gemini-3.8-flash', effort: 'high' },
    { identity: 'gemini-3.8-flash-medium', provider: 'antigravity', selector: 'gemini-3.8-flash', effort: 'medium' },
    { identity: 'muse-spark-1.3-contributor-max', provider: 'muse', selector: 'muse-spark-1.3-contributor', effort: 'max' },
    { identity: 'muse-spark-1.3-contributor-xhigh', provider: 'muse', selector: 'muse-spark-1.3-contributor', effort: 'xhigh' },
  ],
  behaviors: {
    pr_review: 'opus-5-xhigh',
    pr_approve: 'opus-5-xhigh',
    review_recovery: 'gpt-6-astra-ultra',
    fix_failing_ci: 'opus-5-max',
    issue_simplify: 'opus-5-max',
    author_content: 'opus-5-max',
    debate_moderator: 'opus-5-max',
  },
  debate_participants: ['opus-5-max', 'gpt-6-astra-ultra', 'grok-4.6-xhigh', 'gemini-3.8-flash-high', 'muse-spark-1.3-contributor-max'],
  review_providers: ['antigravity', 'claude', 'codex', 'grok', 'muse'],
  // Every provider runs an issue review with full access (Caller's --issue-review).
  issue_review_providers: ['antigravity', 'claude', 'codex', 'grok', 'muse'],
  policy: 'bounded-v1',
}

export const CATALOG_STDOUT = JSON.stringify(CATALOG)

// An older Caller that reviews with Claude and Codex only; Poise reads the
// list rather than assuming it, so the narrowing still has to hold.
export const NARROW_CATALOG = { ...CATALOG, review_providers: ['claude', 'codex'] }

// A Caller from before --issue-review: it names no issue review providers.
export const PRE_ISSUE_REVIEW_CATALOG = (() => {
  const { issue_review_providers: _omitted, ...rest } = CATALOG
  return rest
})()
