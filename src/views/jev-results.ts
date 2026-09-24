import { escapeHtml as esc } from '../markdown'
import type { JevRun, JevAnswer } from '../jev-types'
const percent = (n: number) => `${(n * 100).toFixed(1)}%`
function distribution(answer: Exclude<JevAnswer, { type: 'noul' }>): string {
  const items = Object.entries(answer.probabilities)
  if (answer.type === 'choice') items.sort((a, b) => b[1] - a[1])
  return `<details class="jev-distribution" open><summary>Probability distribution</summary>${items.map(([name, probability]) => {
    const description = answer.type === 'score' ? answer.legend[name] : name
    const label = typeof description === 'string' ? description : JSON.stringify(description)
    return `<div class="jev-probability"><div><span>${esc(answer.type === 'score' ? `${name} · ${label}` : label)}</span><strong>${percent(probability)}</strong></div><meter min="0" max="1" value="${probability}" aria-label="${esc(name)} probability">${probability}</meter></div>`
  }).join('')}</details>`
}
export function renderJevRun(run: JevRun): string {
  if (run.status !== 'completed' || !run.result) return `<div class="jev-run-status" role="status"><strong>${run.status === 'running' ? 'Evaluating primitives…' : run.status === 'cancelled' ? 'Evaluation stopped' : run.status === 'interrupted' ? 'Evaluation interrupted' : 'Evaluation failed'}</strong><p>${esc(run.error || 'Your inputs are saved. You can continue editing while JEV evaluates this snapshot.')}</p></div>`
  return `${run.storageWarning ? `<p class="st-help st-help-error" role="alert">${esc(run.storageWarning)}</p>` : ''}<div class="jev-result-meta"><span class="chat-pill">${esc(run.result.model)}</span><span>${((run.durationMs || 0) / 1000).toFixed(2)} s</span><span>${run.result.usage.input_tokens.toLocaleString()} input tokens · ${run.result.usage.output_tokens.toLocaleString()} output tokens</span></div>
    <div class="jev-results-grid">${Object.entries(run.result.answers).map(([id, answer]) => `<article class="jev-result-card"><header><strong>${esc(id)}</strong><span class="chat-pill">${answer.type}</span></header><p class="jev-result-question">${esc(typeof (run.input || run.request).questions[id]?.instructions === 'string' ? (run.input || run.request).questions[id].instructions as string : 'Structured question · see exact request')}</p>
      ${answer.type === 'noul' ? `<div class="jev-result-value">${percent(answer.noul)}</div><p>Probability of yes</p><meter min="0" max="1" value="${answer.noul}" aria-label="Probability of yes">${answer.noul}</meter><small>0 = no · 0.5 = uncertain · 1 = yes</small>` : answer.type === 'choice' ? `<div class="jev-result-value">${esc(answer.choice)}</div><p>Selected option · ${percent(answer.probabilities[answer.choice])} probability</p>${distribution(answer)}` : `<div class="jev-result-value">${answer.score.toFixed(2)} <small>/ ${Object.keys(answer.legend).length - 1}</small></div><p>Position on your scale</p>${distribution(answer)}`}
      ${answer.type !== 'noul' ? `<div class="jev-confidence">Confidence <strong>${percent(answer.confidence)}</strong><small>Distribution certainty, not the selected option’s probability.</small></div>` : ''}
    </article>`).join('')}</div>`
}
