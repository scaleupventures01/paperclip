export const CODEX_MAX_INPUT_CHARS = 1_048_576;

export function boundCodexPromptInput(
  prompt: string,
  maxChars: number = CODEX_MAX_INPUT_CHARS,
): string {
  if (prompt.length <= maxChars) return prompt;
  const omitted = "\n\n[PAPERCLIP_CONTEXT_BOUND: oversized middle context omitted]\n\n";
  const retainedChars = maxChars - omitted.length;
  const headChars = Math.floor(retainedChars * 0.65);
  const tailChars = retainedChars - headChars;
  return prompt.slice(0, headChars) + omitted + prompt.slice(-tailChars);
}
