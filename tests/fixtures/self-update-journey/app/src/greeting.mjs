// The one behaviour the journey test changes: a release that serves a
// different greeting proves the candidate bundle, not the baseline, answers.
export const GREETING = 'Hello'

export function greeting(name) {
  return `${GREETING}, ${name}!`
}
