// Processor versioning (stabilization §12). Bump a segment whenever parser
// or matching behavior changes in a way that affects staged output or match
// results; revision hashes embed the version, so it must stay deterministic
// (no timestamps). Format: milestone:parser+matcher.
export const PARSER_VERSIONS = { txt: 'txt-1', epub: 'epub-1' } as const;
export const MATCH_ENGINE_VERSION = 'match-1';

export function processorVersion(format: 'txt' | 'epub'): string {
  return `m3:${PARSER_VERSIONS[format]}+${MATCH_ENGINE_VERSION}`;
}
