export interface ChatTextSegment {
  kind: "text" | "bold";
  value: string;
}

/**
 * Parse a minimal safe subset of markdown for chat bubbles: `**bold**` only.
 */
export const parseChatBoldSegments = (text: string): ChatTextSegment[] => {
  const segments: ChatTextSegment[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ kind: "text", value: text.slice(last, m.index) });
    }
    segments.push({ kind: "bold", value: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: "text", value: text.slice(last) });
  }
  if (segments.length === 0 && text.length > 0) {
    segments.push({ kind: "text", value: text });
  }
  return segments;
};
