/**
 * JSON Schema counts string lengths in Unicode code points, while JavaScript's
 * String.length counts UTF-16 code units. Keep hand-written runtime guards in
 * lockstep with the authoritative wire contract without allocating an array.
 */
export function exceedsUnicodeCodePointLimit(
  value: string,
  maximum: number
): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) return true;
  }
  return false;
}

export function truncateUnicodeCodePoints(
  value: string,
  maximum: number
): string {
  let result = "";
  let length = 0;
  for (const codePoint of value) {
    if (length === maximum) break;
    result += codePoint;
    length += 1;
  }
  return result;
}
