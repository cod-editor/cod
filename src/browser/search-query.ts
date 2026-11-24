/** Network autocomplete is limited to short phrases that look like search terms. */
export function eligibleSearchPhrase(query: string): boolean {
  return (
    query.length >= 4 &&
    query.length <= 96 &&
    /^[\p{L}\p{M}]{1,24}(?: [\p{L}\p{M}]{1,24}){1,7}$/u.test(query) &&
    !/\b(?:password|passphrase|secret|token|api key|private key)\b/i.test(query)
  );
}
