import type { DiscussionPlanProposalDraft } from
  "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand } from
  "@convene-wire/contracts/execution-validation";

const openingTag = "<convenewire-plan-proposal>";
const closingTag = "</convenewire-plan-proposal>";
const maximumEnvelopeBytes = 512 * 1024;

function occurrences(value: string, token: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

// The envelope is a bounded machine channel on the exact final line. It does
// not interpret prose, Markdown, near-matches or partial tags.
export function parseDiscussionPlanProposalEnvelope(
  content: string
): DiscussionPlanProposalDraft | undefined {
  if (occurrences(content, openingTag) !== 1 ||
    occurrences(content, closingTag) !== 1) return undefined;
  const finalLine = content.split("\n").at(-1);
  if (!finalLine || finalLine.includes("\r") ||
    !finalLine.startsWith(openingTag) || !finalLine.endsWith(closingTag)) {
    return undefined;
  }
  const body = finalLine.slice(openingTag.length, -closingTag.length);
  if (body.length === 0 || Buffer.byteLength(body, "utf8") > maximumEnvelopeBytes) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(body);
    assertExecutionCommand("discussionPlanProposalDraft", value);
    return structuredClone(value) as DiscussionPlanProposalDraft;
  } catch {
    return undefined;
  }
}

