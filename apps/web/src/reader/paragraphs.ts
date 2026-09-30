// Canonical body contract (M2 parser): paragraphs joined with \n\n.
// Splitting is the ONLY client-side content transform; paragraph indexes are
// the reader's positioning currency (§12).
export function splitParagraphs(body: string): string[] {
  if (body === '') return [];
  return body.split('\n\n');
}
