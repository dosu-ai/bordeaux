// Stand-in for @vercel/connect/chat, aliased in at bundle time (spec 06, Q7).
// bordeaux always passes its own Chat SDK adapter, so these are never called.
const refuse = (name: string) => () => {
  throw new Error(`bordeaux uses your own Chat SDK adapter: ${name} (Vercel Connect) isn't available`)
}
export const connectSlackAdapter = refuse('connectSlackAdapter')
export const connectGitHubAdapter = refuse('connectGitHubAdapter')
export const connectLinearAdapter = refuse('connectLinearAdapter')
