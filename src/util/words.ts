/**
 * Words too common to tell one thing from another, left out of the small keyword
 * searches: which earlier conversations a question is about (brain/recall.ts), and
 * which of selfhub's files it is about (core/context.ts).
 */
export const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "what", "was", "were", "did", "about",
  "we", "i", "you", "a", "an", "to", "of", "on", "in", "is", "it", "my", "me",
]);
