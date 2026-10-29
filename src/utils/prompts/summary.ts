export function getArticleSummaryPrompt(
  title: string,
  preparedText: string,
): { systemPrompt: string; prompt: string } {
  return {
    systemPrompt:
      "Summarize the following article in 2-3 sentences. Focus on the main topic and key points. Return ONLY the summary, no explanations or formatting.",
    prompt: `Title: ${title}\n\nContent:\n${preparedText}`,
  }
}

/**
 * Constraints live in the system message and the task in the user message so a
 * future custom-instruction feature can replace the task without letting users
 * override the tone and anti-leak rules.
 */
