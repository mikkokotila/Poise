// Natural-language recognition of a Poise self-change request typed into the
// composer: "Add a search box above the session list so I can filter sessions
// by their titles" should start a Poise change without a `/poise` prefix,
// while a discussion, a question, a quoted message, a pasted log or a request
// aimed at another repository stays ordinary chat.
//
// This is a set of conservative text heuristics, nothing more. It decides
// whether the person unambiguously asked for a Poise change; it is NOT an
// authorisation boundary. Which repository a change may touch, which paths are
// eligible and whether anything merges is enforced by the self-update
// controller regardless of what this file returns. It is meant to run on
// composer text the person submits — never on model output — and it makes no
// network or provider calls.
//
// `/poise <request>` and `Poise: <request>` (see self-update-command.ts) stay
// the explicit shortcuts and are parsed before this recogniser is consulted.
// Kept free of DOM imports so it runs under the node test environment.

export interface PoiseIntentContext {
  /** True only when the caller knows the active session is itself about
   *  changing Poise: its record has `workspaceKind === 'poise-change'`, or the
   *  previous message the person sent in it was accepted as a Poise change
   *  request. In that context a bare follow-up imperative ("also make the
   *  button blue") counts; elsewhere it never does. The recogniser does not
   *  infer this from text. Default false. */
  poiseChangeSession?: boolean
}

export interface PoiseIntent {
  /** The whole submitted message, trimmed: the implementation request as the person wrote it. */
  request: string
  /** Always `natural`; distinguishes this from the `slash` / `prefix` shortcuts. */
  form: 'natural'
  /** What made the text recognisable, for notice text and tests. */
  cue: 'explicit' | 'vocabulary' | 'followup'
}

const MAX_LENGTH = 64 * 1024
/** "Fix it" or "stop" is not a request anyone can implement on its own. */
const MIN_REQUEST_WORDS = 2

// Poise-specific interface vocabulary. Deliberately compound terms: a lone
// "sidebar", "transcript" or "settings" belongs to too many other apps.
const VOCABULARY = [
  /\bsessions?\s+(?:list|sidebar|pane|picker|panel|drawer|titles?|cards?)\b/i,
  /\b(?:chat|poise)\s+(?:console|composer|transcript|sidebar|view|tab|pane|window)\b/i,
  /\bthe\s+console\b/i,
  /\b(?:model|effort|agent|mode)\s+picker\b/i,
  /\bconsole\s+model\b/i,
  /\btranscript\s+controls?\b/i,
  /\bdeploy\s+card\b/i,
  /\b(?:behaviou?rs?|archive|swarm|editor|snippets?|settings|current|main|chat)\s+view\b/i,
  /\bbehaviou?rs?\s+(?:tab|page|memory|notes?|scratchpad)\b/i,
  /\bcurrent\s+cards?\b/i,
  /\bactivity\s+toggle\b/i,
  /\b(?:new\s+session|fork|hand\s*off|attach|send|stop|revert|refresh)\s+button\b/i,
  /\bhand\s*off\s+(?:agent|model|menu)\b/i,
  /\bsnippets?\s+(?:list|panel|editor)\b/i,
  /\bpoise\s+(?:ui|app|interface|frontend|backend|server|client|window|menu|settings)\b/i,
]

// Verbs that begin an implementation request when they open a sentence.
const CHANGE_VERBS = '(?:add|implement|fix|change|remove|delete|rename|move|make|build|create|update|improve|replace|hide|show|display|allow|let|support|enable|disable|tweak|adjust|redesign|restyle|style|refactor|introduce|put|place|drop|wire|hook\\s+up|persist|remember|keep|prevent|stop|ensure|convert|turn|switch|swap|reorder|sort|group|collapse|expand|resize|widen|narrow|shrink|shorten|increase|decrease|reduce|bump|extend|split|combine|align|cent(?:er|re)|highlight|label|colou?r|animate|debounce|throttle|cache|speed\\s+up|optimi[sz]e|clean\\s+up|tidy(?:\\s+up)?|simplify|polish|migrate|upgrade|restore|default|set|use|include|exclude|filter|paginate|truncate|wrap|indent|link|auto-?focus|focus|scroll|pin|unpin|dock|toggle|save|store|preload|lazy-?load|validate|sanitize|escape|handle|warn|notify|confirm|require|retry|poll|render|badge|give|provide|expose|offer|get\\s+rid\\s+of|bring\\s+back|port|locali[sz]e|format|round|clamp|limit|cap|bound|guard|write|teach|bold|dim|shade|rework|rebuild|rewrite|redo|clear|reset|trim|strip|hoist|lift|extract|inline|dedupe|deduplicate|memoi[sz]e|paralleli[sz]e|batch|queue|defer|delay|auto-?save|auto-?scroll|auto-?select|auto-?complete|surface|flag|mark|tag|annotate|prefix|suffix|pad|space|separate|outdent|nest|flatten|stack|tile|float|anchor|stick|freeze|unfreeze|lock|unlock)'

// Openers that may precede the verb without changing the meaning.
const LEAD_IN = '(?:(?:hi|hey|hello|ok|okay|yes|yeah|yep|right|so|alright|great|thanks|thank\\s+you|cool|nice|good|perfect|awesome)[,!.\\s]+)*'
  + '(?:(?:please|also|now|next|and|then|additionally|finally|first(?:ly)?|second(?:ly)?|lastly|actually|instead|kindly|just|simply|go\\s+ahead\\s+and)[,\\s]+)*'
  + '(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:also\\s+)?|i(?:\'d|\\s+would)\\s+like\\s+(?:you\\s+to\\s+)?|i\\s+(?:want|need)\\s+(?:you\\s+to\\s+)?|we\\s+(?:want|need)\\s+(?:you\\s+to\\s+)?|let\'?s\\s+|we\\s+should\\s+|you\\s+should\\s+|(?:please\\s+)+)*'

const IMPERATIVE = new RegExp(`^${LEAD_IN}(?:${CHANGE_VERBS}\\b|(?:let|allow)\\s+(?:me|us|users?|people|the\\s+user)\\b)`, 'i')
const WISH = new RegExp(`^${LEAD_IN}(?:i(?:'d|\\s+would)\\s+like|i\\s+(?:want|need)|we\\s+(?:want|need))\\s+(?:an?|the|to|some|more|less|no|my|our|this|that|poise)\\b`, 'i')
const SHOULD = /^(?:the\s+)?(?:[\w'-]+\s+){0,6}?(?:should|needs?\s+to|must|has\s+to|have\s+to|ought\s+to)\s+(?!be\s+(?:possible|fine|ok|okay)\b)\w+/i
const PRONOUN_SHOULD = /\b(?:i|we|you|they|it|that|this|one)\s+(?:should|must|needs?\s+to|ought\s+to)\b/i

// Sentences that open a request for information, a summary or an interruption
// rather than a change, even though they may begin with a change verb.
const NON_CHANGE_OPENER = new RegExp([
  `^${LEAD_IN}(?:show|give|tell|send|get|walk|remind|teach)\\s+(?:me|us)\\b`,
  `^${LEAD_IN}(?:explain|describe|discuss|outline|summari[sz]e|clarify|review|investigate|look|check|find|search|read|open|run|list|compare|analy[sz]e|debug|diagnose|figure|see|inspect|examine|audit|verify|test|try|help|answer|recommend|suggest|propose|estimate|assess|evaluate|consider|think|brainstorm|draft|plan|sketch)\\b`,
  `^${LEAD_IN}let\\s+me\\s+(?:know|see|think|check|understand|look|ask)\\b`,
  `^${LEAD_IN}(?:make|create|write|give|provide|produce|put\\s+together)\\s+(?:me\\s+)?(?:an?\\s+|the\\s+)?(?:list|summary|report|overview|rundown|explanation|description|note|poem|message|reply|email|commit\\s+message|pr\\s+description|changelog|write-?up|table|plan|proposal|doc|document)\\b`,
  `^${LEAD_IN}(?:stop|cancel|abort|pause|halt|wait|undo|kill)\\b(?:\\s+(?:it|now|this|that|everything|please|working|the\\s+(?:agent|turn|run|change|work|session|current)))?\\s*[.!]*$`,
].join('|'), 'i')

// --- Gates: any hit means "not unambiguous", regardless of positive cues. ---

const BLOCKQUOTE = /^\s*>/m
const LOG_LINE = /^\s*(?:at\s+\S+\s+\(|at\s+\S+:\d+|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[\d{2}:\d{2}:\d{2}|(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b|(?:Type|Reference|Syntax|Range)?Error:|npm\s+ERR!|Traceback\s+\(|\$\s+\S|PS\s+[A-Z]:|#\d+\s+0x)/m
const CODE_LINE = /^(?: {4,}|\t).*(?:[{};]|=>|==|\(\))|^\s*(?:const|let|var|function|import|export|return|if|for|while|def|class)\s+\S+.*[({=:;]\s*$/m
const REPORTED_SPEECH = /\b(?:said|wrote|replied|responded|quoting|quoted|pasted|pasting|copied|(?:told|asked)\s+(?:me|us|for|to)|(?:suggested|recommended|proposed|requested)\s+(?:that|adding|to|we|i|you|using|making|changing|removing|an?|the|this|it)|reported\s+(?:that|by|this|it)|mentioned\s+(?:that|adding|this|it)|from\s+the\s+(?:issue|ticket|email|thread|log|output|message|conversation|review|comment|report))\b/i
const HEDGE = /\b(?:i\s+think|i\s+feel|i\s+guess|i\s+wonder|i'?m\s+wondering|wondering|(?:would|could|might)\s+be\s+(?:nice|great|good|cool|useful|handy|better|worth)|thoughts|opinion|brainstorm|consider|considering|what\s+if|hypothetically|in\s+theory|would\s+it|could\s+we|should\s+we|should\s+i|do\s+you\s+think|any\s+chance|is\s+it\s+possible|worth\s+(?:it|doing|adding|trying)|eventually|someday|some\s+day|at\s+some\s+point|one\s+day|in\s+the\s+future|not\s+sure|unsure|curious|(?:quick|one|a|my)\s+question|question\s*:)\b/i
const DISCUSSION = /\b(?:explain|describe|discuss|outline|summari[sz]e|clarify)\s+(?:to\s+me\s+|me\s+|for\s+me\s+)?(?:how|why|what|which|whether|where|when|this|that|the|it|your|our)\b|\b(?:walk\s+me\s+through|tell\s+me|show\s+me|talk\s+(?:about|through|me)|think\s+(?:about|through)|plan\s+(?:this|it|out|first)|before\s+(?:you|we)\s+(?:implement|change|build|start|do|code|touch|write)|not\s+yet|hold\s+off|no\s+(?:code\s+)?changes?\b|nothing\s+to\s+change|read-?only|only\s+(?:explain|describe|discuss|plan|analy[sz]e|investigate|review|look|talk)|just\s+(?:explain|describe|discuss|plan|analy[sz]e|investigate|review|look|tell|asking|a\s+question|checking|thinking|curious|talk|wondering|an?\s+idea|a\s+thought|a\s+note|fyi)|for\s+now\s+(?:just|only)|do\s+nothing|no\s+action)\b/i
const NO_RELEASE = /\b(?:don'?t|do\s+not|never|no\s+need\s+to|without|not|avoid|skip|no)\s+(?:actually\s+|automatically\s+|auto-?)?(?:merge|merging|release|releasing|deploy|deploying|ship|shipping|push|pushing|commit|committing|open(?:ing)?\s+(?:a\s+|the\s+)?pr|auto-?release|auto-?merge|roll\s*out|rolling\s+out)\b|\b(?:manual(?:ly)?\s+merge|merge\s+(?:it\s+)?(?:myself|manually|by\s+hand|later)|i'?ll\s+(?:merge|review|deploy|release|ship)|review\s+(?:it\s+)?(?:first|before)|before\s+merging|pr\s+only|just\s+(?:open|create|make|prepare)\s+(?:a\s+|the\s+)?(?:pr|pull\s+request|branch|draft|patch|diff)|as\s+a\s+draft|draft\s+pr)\b/i
const NO_CHANGE = /\b(?:don'?t|do\s+not|never|no\s+need\s+to|not|please\s+don'?t)\s+(?:actually\s+|really\s+)?(?:implement|change|touch|modify|edit|code|build|write|do|make|start|fix|add|remove|alter)\s+(?:anything|it|this|that|yet|now|any|the\s+code|code|changes|files|things)\b|\b(?:don'?t|do\s+not|never)\s+(?:actually\s+)?(?:implement|code\s+it|make\s+(?:any\s+)?changes|write\s+(?:any\s+)?code|change\s+anything|touch\s+anything)\b|\bno\s+implementation\b/i
// Operating the release machinery is a controller action, not an implementation request.
const CONTROLLER_ACTION = /\b(?:revert|roll\s*back|rollback|redeploy|deploy|release|ship|publish|restart)\s+(?:poise\b|prod(?:uction)?\b|the\s+(?:app|server|last|latest|previous|current|change|release|pr)\b|(?:that|this)\s+(?:change|release|pr)\b|it\b)/i

// Requests explicitly aimed elsewhere. Hyphenated sibling names are unambiguous;
// "caller" is an English word, so it only counts as a repository in those frames.
const OTHER_TARGET = /\b(?:agent-interface|github-interface|bit-mis)\b|\bcaller\s+(?:repo|repository|package|project|codebase|release|pr|main|branch|checkout)\b|\b(?:in|to|into|for|of|on)\s+(?:the\s+)?caller\b|github\.com\/(?!mikkokotila\/poise\b)[\w.-]+\/[\w.-]+|\b(?:repo|repository)\s+(?!mikkokotila\/poise\b)[\w.-]+\/[\w.-]+/i
const NAMED_TARGET = /\b(?:in|to|into|for|on|inside|within|of|from)\s+(?:the\s+|my\s+|our\s+)?([\w.-]+)\s+(?:repo|repository|package|project|codebase|library|extension|plugin|cli|monorepo|workspace)\b/gi
const THIS_TARGET = /\b(?:in|to|into|for|on|inside|within)\s+(?:this|that|the\s+current|my|our)\s+(?:repo|repository|package|project|codebase|library|module|app|application|site|website|service)\b/i
const TARGET_FILLERS = new Set(['this', 'that', 'the', 'a', 'an', 'my', 'our', 'your', 'its', 'current', 'same', 'other', 'another', 'new', 'existing', 'whole', 'entire', 'main', 'root', 'poise'])

// "like Poise's" or "the way Poise does it" names Poise as a comparison, not a target.
const POISE_AS_COMPARISON = /\b(?:(?<!(?:'d|would|\bi|\bwe|\byou|\bthey|\bnot|n't|\bdo|\bdon't)\s+)like|similar\s+to|as\s+in|the\s+way|unlike|compared\s+to|than|same\s+as|just\s+like|inspired\s+by|based\s+on)\s+(?:the\s+|what\s+|how\s+)?poise(?:'s|s')?\b/gi
const POISE_AS_TARGET = /\b(?:in|to|into|for|on|inside|within|across|throughout|from)\s+(?:the\s+)?poise\b|\bpoise(?:'s|s')\b|\bpoise\s+(?:should|must|needs?|so|itself|to|ui|app|interface|frontend|backend|server|client|window|menu|settings|chat|console|composer|sidebar|transcript|view|tab|sessions?|model|editor|behaviou?rs?|archive|swarm|snippets?|current|repo|repository|codebase|source|code)\b|\b(?:make|let|have|get|teach|give|stop|prevent|allow|keep|fix|update|change|improve|restyle|redesign|refactor|upgrade|tweak|build|rebuild)\s+poise\b|^\s*poise\b/i

function normalise(text: unknown): string {
  return String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
}

/** Text with quoted spans and inline code removed, so nothing inside a quote can act as a cue. */
function unquoted(text: string): string {
  return text
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/‘[^’\n]*’/g, ' ')
    .replace(/(^|[\s(])'[^'\n]*'(?=[\s).,;:!?]|$)/g, '$1 ')
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;,])\s+|\n+|:\s+|\s+[—–-]+\s+/).map((s) => s.replace(/^[\s\-*•\d.)]+/, '').trim()).filter(Boolean)
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /\w/.test(w)).length
}

function hasQuestion(plain: string, imperativeSentence: string | null): boolean {
  const marks = plain.match(/\?/g)?.length ?? 0
  if (!marks) return false
  // A single trailing "?" on a "can you add …?" is still an ask, not a question.
  if (marks === 1 && plain.endsWith('?') && imperativeSentence && /^[\s\S]{0,60}\b(?:can|could|would|will)\s+you\b/i.test(imperativeSentence)) return false
  return true
}

function mentionsOtherRepository(plain: string, ctx: PoiseIntentContext): boolean {
  if (OTHER_TARGET.test(plain)) return true
  if (!ctx.poiseChangeSession && THIS_TARGET.test(plain)) return true
  for (const m of plain.matchAll(NAMED_TARGET)) {
    const name = m[1].toLowerCase()
    if (TARGET_FILLERS.has(name)) continue
    return true
  }
  return false
}

function implementationSentence(plain: string): string | null {
  for (const s of sentences(plain)) {
    if (NON_CHANGE_OPENER.test(s)) continue
    if ((IMPERATIVE.test(s) || WISH.test(s)) && wordCount(s) >= MIN_REQUEST_WORDS) return s
  }
  return null
}

function declarativeRequirement(plain: string): string | null {
  for (const s of sentences(plain)) {
    if (SHOULD.test(s) && !PRONOUN_SHOULD.test(s) && wordCount(s) >= MIN_REQUEST_WORDS) return s
  }
  return null
}

/**
 * Recognise an unambiguous, person-authored request to change Poise. Returns
 * `null` for everything else: questions, discussion, hedged ideas, quoted or
 * pasted text, code and logs, requests aimed at another repository, and
 * requests that say not to implement, merge or release.
 *
 * Meant to be consulted after `parsePoiseCommand` finds no `/poise` or
 * `Poise:` shortcut, with the same composer text.
 */
export function recognisePoiseRequest(text: string, context: PoiseIntentContext = {}): PoiseIntent | null {
  const raw = normalise(text)
  if (!raw || raw.length > MAX_LENGTH) return null
  // Supporting examples and logs do not revoke an explicit request outside
  // them. Only person-authored prose participates in intent recognition.
  let fence: string | null = null
  const prose = raw.split('\n').filter(line => {
    const mark = line.trim().match(/^(`{3,}|~{3,})/)
    if (mark) { fence = fence ? null : mark[1][0]; return false }
    return !fence && !BLOCKQUOTE.test(line) && !LOG_LINE.test(line) && !CODE_LINE.test(line)
  }).join('\n')
  const plain = unquoted(prose).replace(/[ \t]+/g, ' ').trim()
  if (!plain || NO_RELEASE.test(plain) || NO_CHANGE.test(plain) || CONTROLLER_ACTION.test(plain)) return null
  if (/\b(?:no (?:code )?changes? (?:yet|now)|(?:only|just) (?:a )?plan|hold off|not yet)\b/i.test(plain)) return null
  const actionable = plain.split(/(?<=[.!?;])\s+|\n+/).filter(sentence =>
    !REPORTED_SPEECH.test(sentence) && !HEDGE.test(sentence) && !DISCUSSION.test(sentence),
  ).join('\n')
  if (!actionable) return null

  if (mentionsOtherRepository(plain, context)) return null

  const imperative = implementationSentence(actionable)
  if (hasQuestion(plain, imperative)) return null

  const explicit = POISE_AS_TARGET.test(plain.replace(POISE_AS_COMPARISON, ' '))
  const vocabulary = VOCABULARY.some((re) => re.test(plain))
  const requirement = imperative ? null : (explicit || vocabulary ? declarativeRequirement(actionable) : null)
  if (!imperative && !requirement) return null

  if (explicit) return { request: raw, form: 'natural', cue: 'explicit' }
  if (vocabulary) return { request: raw, form: 'natural', cue: 'vocabulary' }
  if (context.poiseChangeSession && imperative) return { request: raw, form: 'natural', cue: 'followup' }
  return null
}
