// The GitHub gate. A thin REST client bound to one repository, plus the pure
// rules that decide whether a pull request has earned a merge: the repository
// identity matches, its independently required CI checks pass, the
// trusted CI workflow ran the required Node matrix on this exact head, and the
// merge commit that comes back is the one we asked for.
import { BASE_BRANCH, REPOSITORY, isSha } from './paths.mjs'

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const REQUIRED_CONTEXTS = ['Verify (Node 20)', 'Verify (Node 22)', 'Verify (Node 24)']
export const GITHUB_ACTIONS_APP = 'github-actions'
export const DEFAULT_API_URL = 'https://api.github.com'
const MAX_BODY_BYTES = 4 * 1024 * 1024

export class GitHubError extends Error {
  constructor(message, { status = 0, code = 'github', body = null } = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.code = code
    this.body = body
  }
}

/** Network-level uncertainty: the request may or may not have been applied. */
export function isUncertain(error) {
  return error instanceof GitHubError && error.code === 'network'
}

export function createGitHubClient({
  fetch = globalThis.fetch,
  loadToken,
  baseUrl = DEFAULT_API_URL,
  timeoutMs = 20_000,
  repository = REPOSITORY,
} = {}) {
  if (typeof loadToken !== 'function') throw new Error('GitHub client requires a loadToken function')
  const repo = `/repos/${repository}`

  async function request(method, path, body = undefined) {
    const token = await loadToken()
    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'poise-self-update',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (error) {
      throw new GitHubError(`GitHub request ${method} ${path} failed: ${error?.message || error}`, { code: 'network' })
    }
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) throw new GitHubError('GitHub response too large', { status: response.status })
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (response.status >= 500) {
      throw new GitHubError(`GitHub ${method} ${path} returned ${response.status}`, { status: response.status, code: 'network', body: parsed })
    }
    if (response.status >= 400) {
      const message = parsed?.message || `HTTP ${response.status}`
      throw new GitHubError(`GitHub ${method} ${path}: ${message}`, { status: response.status, code: 'http', body: parsed })
    }
    return parsed
  }

  return {
    repository,
    request,
    async getRepository() {
      return request('GET', repo)
    },
    async getBranchSha(branch = BASE_BRANCH) {
      const ref = await request('GET', `${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
      const sha = ref?.object?.sha
      if (!isSha(sha)) throw new GitHubError(`branch ${branch} did not resolve to a SHA`)
      return sha
    },
    async compare(base, head) {
      return request('GET', `${repo}/compare/${base}...${head}`)
    },
    async findPullRequest(branch) {
      const owner = repository.split('/')[0]
      const pulls = await request('GET', `${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=20`)
      if (!Array.isArray(pulls)) return null
      return pulls.find((pull) => pull?.head?.ref === branch) || null
    },
    async createPullRequest({ title, body, head, base = BASE_BRANCH }) {
      return request('POST', `${repo}/pulls`, { title, body, head, base, maintainer_can_modify: false })
    },
    async getPullRequest(number) {
      return request('GET', `${repo}/pulls/${number}`)
    },
    async listCheckRuns(sha) {
      const page = await request('GET', `${repo}/commits/${sha}/check-runs?per_page=100`)
      return Array.isArray(page?.check_runs) ? page.check_runs : []
    },
    async listWorkflowRuns(sha) {
      const page = await request('GET', `${repo}/actions/runs?head_sha=${sha}&per_page=50`)
      return Array.isArray(page?.workflow_runs) ? page.workflow_runs : []
    },
    async mergePullRequest(number, { sha }) {
      if (!isSha(sha)) throw new GitHubError('merge requires the exact head SHA')
      return request('PUT', `${repo}/pulls/${number}/merge`, { sha, merge_method: 'merge' })
    },
    async getCommit(sha) {
      return request('GET', `${repo}/commits/${sha}`)
    },
  }
}

/** The repository the API answers for must be the one we are pinned to. */
export function assertRepositoryIdentity(repository) {
  if (repository?.full_name !== REPOSITORY) {
    throw new Error(`GitHub repository identity mismatch: ${repository?.full_name ?? 'unknown'} is not ${REPOSITORY}`)
  }
  if (repository?.default_branch !== BASE_BRANCH) {
    throw new Error(`GitHub default branch is ${repository?.default_branch ?? 'unknown'}, expected ${BASE_BRANCH}`)
  }
}

export function assertPullRequestIdentity(pull, { branch, headSha = null }) {
  const problems = []
  if (pull?.base?.repo?.full_name !== REPOSITORY) problems.push('base repository is not mikkokotila/Poise')
  if (pull?.head?.repo?.full_name !== REPOSITORY) problems.push('head repository is not mikkokotila/Poise')
  if (pull?.base?.ref !== BASE_BRANCH) problems.push(`base branch is ${pull?.base?.ref ?? 'unknown'}, not main`)
  if (pull?.head?.ref !== branch) problems.push(`head branch is ${pull?.head?.ref ?? 'unknown'}, not ${branch}`)
  if (headSha && pull?.head?.sha !== headSha) problems.push(`PR head moved to ${String(pull?.head?.sha).slice(0, 12)}`)
  if (pull?.draft) problems.push('pull request is a draft')
  if (problems.length) throw new Error(`pull request #${pull?.number ?? '?'} rejected: ${problems.join('; ')}`)
}

function latest(runs) {
  return runs.slice().sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0)
    || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null
}

/**
 * Decide whether the trusted CI workflow has passed for `headSha`.
 * Returns { status: 'success' | 'pending' | 'failure', reason, runUrl? }.
 */
export function evaluateCi({ headSha, checkRuns = [], workflowRuns = [] }) {
  const candidates = workflowRuns.filter((run) => run?.path === CI_WORKFLOW_PATH
    && run?.head_sha === headSha
    && run?.event === 'pull_request'
    && (run?.head_repository?.full_name === undefined || run.head_repository.full_name === REPOSITORY))
  const run = latest(candidates)
  if (!run) return { status: 'pending', reason: 'CI workflow has not started for this head' }
  const runUrl = run.html_url
  if (run.status !== 'completed') return { status: 'pending', reason: `CI run #${run.run_number} is ${run.status}`, runUrl }
  if (run.conclusion !== 'success') return { status: 'failure', reason: `CI run #${run.run_number} concluded ${run.conclusion}`, runUrl }
  for (const context of REQUIRED_CONTEXTS) {
    const check = checkRuns.find((candidate) => candidate?.name === context
      && candidate?.head_sha === headSha
      && (candidate?.app?.slug ?? GITHUB_ACTIONS_APP) === GITHUB_ACTIONS_APP
      && (run.check_suite_id === undefined || candidate?.check_suite?.id === run.check_suite_id))
    if (!check) return { status: 'pending', reason: `check ${context} has not reported for this head`, runUrl }
    if (check.status !== 'completed') return { status: 'pending', reason: `check ${context} is ${check.status}`, runUrl }
    if (check.conclusion !== 'success') return { status: 'failure', reason: `check ${context} concluded ${check.conclusion}`, runUrl }
  }
  return { status: 'success', reason: `CI run #${run.run_number} passed`, runUrl }
}

/** The merge commit must join exactly [current main, verified head] and carry head's tree. */
export function verifyMergeCommit({ commit, expectedBase, expectedHead, headTree }) {
  const parents = Array.isArray(commit?.parents) ? commit.parents.map((parent) => parent?.sha) : []
  if (parents.length !== 2 || parents[0] !== expectedBase || parents[1] !== expectedHead) {
    throw new Error(`merge commit ${String(commit?.sha).slice(0, 12)} parents [${parents.map((sha) => String(sha).slice(0, 12)).join(', ')}] do not match [${expectedBase.slice(0, 12)}, ${expectedHead.slice(0, 12)}]`)
  }
  const tree = commit?.commit?.tree?.sha
  if (!isSha(tree) || tree !== headTree) {
    throw new Error(`merge commit tree ${String(tree).slice(0, 12)} does not match the verified head tree ${String(headTree).slice(0, 12)}`)
  }
  return commit.sha
}
