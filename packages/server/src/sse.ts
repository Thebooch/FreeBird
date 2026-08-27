/**
 * Serialize a single ChatStreamEvent (or anything JSON-serializable) as an
 * SSE data frame. Every event is one line of `data:` plus a blank line.
 */
export const serializeSseEvent = (event: unknown): string => {
  const line = JSON.stringify(event);
  return `data: ${line}\n\n`;
};

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
