import { describe, expect, it } from 'vitest'

import {
  GitHubError, REQUIRED_CONTEXTS, assertPullRequestIdentity, assertRepositoryIdentity, createGitHubClient,
  evaluateCi, isUncertain, verifyMergeCommit,
} from '../scripts/self-update/github.mjs'

const HEAD = 'b'.repeat(40)
const MAIN = 'a'.repeat(40)
const MERGE = 'c'.repeat(40)
const TREE = 'd'.repeat(40)

function workflowRun(overrides = {}) {
  return {
    path: '.github/workflows/ci.yml', head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'success',
    run_number: 7, created_at: '2026-09-19T10:00:00Z', check_suite_id: 55, html_url: 'https://github.com/mikkokotila/Poise/actions/runs/7',
    head_repository: { full_name: 'mikkokotila/Poise' }, ...overrides,
  }
}

function checkRuns(overrides = {}) {
  return REQUIRED_CONTEXTS.map((name) => ({
    name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 55 }, ...overrides,
  }))
}

describe('CI gate', () => {
  it('passes only when the trusted workflow and every required Node check succeeded on the exact head', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun()] })).toMatchObject({ status: 'success' })
  })

  it('is pending until the workflow starts, completes and every check reports', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: [], workflowRuns: [] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ status: 'in_progress', conclusion: null })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns().slice(0, 2), workflowRuns: [workflowRun()] })).toMatchObject({ status: 'pending', reason: /Node 24/ })
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ status: 'queued', conclusion: null }), workflowRuns: [workflowRun()] }).status).toBe('pending')
  })

  it('fails on a failed run or check', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ conclusion: 'failure' })] })).toMatchObject({ status: 'failure' })
    const runs = checkRuns()
    runs[1].conclusion = 'failure'
    expect(evaluateCi({ headSha: HEAD, checkRuns: runs, workflowRuns: [workflowRun()] })).toMatchObject({ status: 'failure', reason: /Node 22/ })
  })

  it('ignores runs for other heads, other workflows, other events, forks and other apps', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ head_sha: MAIN })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ path: '.github/workflows/other.yml' })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ event: 'push' })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ head_repository: { full_name: 'fork/Poise' } })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ app: { slug: 'some-other-app' } }), workflowRuns: [workflowRun()] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ check_suite: { id: 99 } }), workflowRuns: [workflowRun()] }).status).toBe('pending')
  })

  it('judges the latest run when the workflow re-ran', () => {
    const runs = [workflowRun({ run_number: 7, conclusion: 'failure' }), workflowRun({ run_number: 8, check_suite_id: 56 })]
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ check_suite: { id: 56 } }), workflowRuns: runs }).status).toBe('success')
  })
})

describe('repository identity', () => {
  it('rejects repository and pull request identity mismatches', () => {
    expect(() => assertRepositoryIdentity({ full_name: 'mikkokotila/Poise', default_branch: 'main' })).not.toThrow()
    expect(() => assertRepositoryIdentity({ full_name: 'mikkokotila/poise-fork', default_branch: 'main' })).toThrow(/identity mismatch/)
    expect(() => assertRepositoryIdentity({ full_name: 'mikkokotila/Poise', default_branch: 'develop' })).toThrow(/default branch/)
    const pull = {
      number: 3, draft: false,
      base: { ref: 'main', repo: { full_name: 'mikkokotila/Poise' } },
      head: { ref: 'poise/change-x', sha: HEAD, repo: { full_name: 'mikkokotila/Poise' } },
    }
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-x', headSha: HEAD })).not.toThrow()
    expect(() => assertPullRequestIdentity({ ...pull, base: { ref: 'release', repo: pull.base.repo } }, { branch: 'poise/change-x' })).toThrow(/base branch is release/)
    expect(() => assertPullRequestIdentity({ ...pull, head: { ...pull.head, repo: { full_name: 'x/Poise' } } }, { branch: 'poise/change-x' })).toThrow(/head repository/)
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-x', headSha: MAIN })).toThrow(/PR head moved/)
    expect(() => assertPullRequestIdentity({ ...pull, draft: true }, { branch: 'poise/change-x' })).toThrow(/draft/)
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-y' })).toThrow(/head branch/)
  })
})

describe('merge commit verification', () => {
  const commit = (overrides = {}) => ({ sha: MERGE, parents: [{ sha: MAIN }, { sha: HEAD }], commit: { tree: { sha: TREE } }, ...overrides })

  it('accepts exactly [base, head] with the verified head tree', () => {
    expect(verifyMergeCommit({ commit: commit(), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toBe(MERGE)
  })

  it('rejects reordered, missing or extra parents and a different tree', () => {
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: HEAD }, { sha: MAIN }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: MAIN }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: 'e'.repeat(40) }, { sha: HEAD }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ commit: { tree: { sha: 'f'.repeat(40) } } }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/tree/)
    expect(() => verifyMergeCommit({ commit: null, expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow()
  })
})

describe('GitHub client', () => {
  function client(handler, options = {}) {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    }
    return { calls, api: createGitHubClient({ fetch, loadToken: async () => 'github_pat_TESTTOKEN0123456789abcdef', timeoutMs: 1_000, ...options }) }
  }
  const response = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('sends the release token as a bearer header to the pinned repository only', async () => {
    const { api, calls } = client(() => response(200, { object: { sha: MAIN } }))
    expect(await api.getBranchSha()).toBe(MAIN)
    expect(calls[0].url).toBe('https://api.github.com/repos/mikkokotila/Poise/git/ref/heads/main')
    expect(calls[0].init.headers.authorization).toBe('Bearer github_pat_TESTTOKEN0123456789abcdef')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports 4xx as definite errors and network or 5xx failures as uncertain', async () => {
    const notFound = client(() => response(404, { message: 'Not Found' }))
    await expect(notFound.api.getPullRequest(1)).rejects.toMatchObject({ status: 404, code: 'http' })
    const down = client(() => response(502))
    const error = await down.api.getPullRequest(1).catch((caught) => caught)
    expect(error).toBeInstanceOf(GitHubError)
    expect(isUncertain(error)).toBe(true)
    const offline = client(() => { throw new TypeError('fetch failed') })
    const netError = await offline.api.mergePullRequest(4, { sha: HEAD }).catch((caught) => caught)
    expect(isUncertain(netError)).toBe(true)
    expect(isUncertain(new Error('other'))).toBe(false)
  })

  it('merges with the exact head and merge_method merge, and refuses without a SHA', async () => {
    const { api, calls } = client(() => response(200, { merged: true, sha: MERGE }))
    expect(await api.mergePullRequest(12, { sha: HEAD })).toEqual({ merged: true, sha: MERGE })
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toBe('https://api.github.com/repos/mikkokotila/Poise/pulls/12/merge')
    expect(JSON.parse(calls[0].init.body)).toEqual({ sha: HEAD, merge_method: 'merge' })
    await expect(api.mergePullRequest(12, { sha: 'abc' })).rejects.toThrow(/exact head SHA/)
  })

  it('finds a pull request by exact head branch and opens one without maintainer edits', async () => {
    const pulls = [{ number: 1, head: { ref: 'poise/change-other' } }, { number: 2, head: { ref: 'poise/change-x' } }]
    const { api, calls } = client((url) => (url.includes('/pulls?') ? response(200, pulls) : response(201, { number: 3 })))
    expect((await api.findPullRequest('poise/change-x')).number).toBe(2)
    expect(calls[0].url).toContain('head=mikkokotila%3Apoise%2Fchange-x')
    expect(await api.findPullRequest('poise/change-none')).toBeNull()
    await api.createPullRequest({ title: 't', body: 'b', head: 'poise/change-x' })
    expect(JSON.parse(calls.at(-1).init.body)).toEqual({ title: 't', body: 'b', head: 'poise/change-x', base: 'main', maintainer_can_modify: false })
  })

  it('normalises list responses', async () => {
    const { api } = client((url) => (url.includes('check-runs') ? response(200, { check_runs: [{ name: 'x' }] }) : response(200, {})))
    expect(await api.listCheckRuns(HEAD)).toEqual([{ name: 'x' }])
    expect(await api.listWorkflowRuns(HEAD)).toEqual([])
  })

  it('requires a token loader', () => {
    expect(() => createGitHubClient({ fetch: async () => response(200, {}) })).toThrow(/loadToken/)
  })
})
