export const replyLanguages = ['en', 'es'] as const;
export type ReplyLanguage = (typeof replyLanguages)[number];

/** Existing profiles retain Spanish; interface language is a separate browser preference. */
export function replyText(language: ReplyLanguage | undefined, spanish: string, english: string) {
  return language === 'en' ? english : spanish;
}

/** Applied after saved personality prompts, without rewriting the stored prompt. */
export function replyLanguageInstruction(language: ReplyLanguage | undefined) {
  return replyText(
    language,
    'Idioma de respuesta de este perfil: español. Responde en español aunque la plantilla indique otro idioma; conserva nombres propios, citas y contenido que el usuario pida traducir a otro idioma.',
    'Reply language for this profile: English. Reply in English even if the personality template specifies another language; preserve proper names, quotations and content the user explicitly asks to translate into another language.',
  );
}
