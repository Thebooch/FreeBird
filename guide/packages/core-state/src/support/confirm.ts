/** User affirmed a pending support ticket draft in chat. */
export const isAffirmativeSupportConfirmation = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (isSupportDraftCancellation(t)) return false;
  return (
    /^(yes|yeah|yep|yup|sure|ok|okay|k|great|good|perfect|sounds good|looks good|go ahead|do it|submit|file it|file the ticket|confirm|approved|please do|that works|ship it)\b/.test(
      t,
    ) ||
    /\b(submit|file|confirm)\s+(the\s+)?ticket\b/.test(t) ||
    /\blooks?\s+good\b/.test(t)
  );
};

/** User wants to discard or revise a pending ticket draft. */
export const isSupportDraftCancellation = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  return (
    /^(no|nope|cancel|stop|wait|hold on|nevermind|never mind|don't|do not)\b/.test(
      t,
    ) || /\b(cancel|discard|don't file|do not file)\b/.test(t)
  );
};
