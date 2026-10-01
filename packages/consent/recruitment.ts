// Recruitment consent (the Join form) — a SEPARATE namespace from the cookie categories in
// ./gate.ts. `hasConsent()` answers "may this browser be measured"; this answers "what did
// an applicant agree to when they sent their CV". The two never share a store: cookie
// consent is logged to `consent_log` (Admin + Developer read it), recruitment consent is
// recorded on the application row itself (`job_applications`, Admin only — owner decision
// J6), so a Developer can never read who applied.
//
// Two checkboxes, not the design's one (owner decision J4, 2026-09-30): under PDPL a
// required box that also covers "future roles" bundles an optional purpose into a
// required one. The required box covers THIS application; the optional box covers future
// roles and lengthens retention from 12 to 24 months.
//
// Bump the version whenever these words change — APPEND to RECRUITMENT_POLICY_VERSIONS,
// never replace: the version a form showed is stored with the consent, so an application
// can always be read against its text (each version's text is in git at the commit that
// added it). The endpoint accepts only a version on this list, so a stored version always
// names a notice that existed; older ones stay accepted because an edge-cached page can
// keep showing its notice long after a deploy.

/** Every recruitment notice ever published, oldest first. Append-only. */
export const RECRUITMENT_POLICY_VERSIONS = ['2026-09-30'] as const;
/** The notice the form shows now. */
export const RECRUITMENT_POLICY_VERSION: (typeof RECRUITMENT_POLICY_VERSIONS)[number] =
  RECRUITMENT_POLICY_VERSIONS[RECRUITMENT_POLICY_VERSIONS.length - 1]!;

/** `{brand}` is filled from site_profile (the brand is data — CLAUDE.md §1); see recruitmentConsent(). */
export interface RecruitmentConsentCopy {
  application: string;
  futureRoles: string;
  /** The link text to the recruitment section of the privacy notice. */
  noticeLink: string;
}

/** MSA for the Arabic legal text (UI v2 decision 6: legal and system text stays MSA). */
export const RECRUITMENT_CONSENT: Record<'en' | 'ar', RecruitmentConsentCopy> = {
  en: {
    application:
      'I agree that {brand} can store and review this application, including my CV, to consider me for this role.',
    futureRoles: 'Also keep my application on file and contact me about future roles.',
    noticeLink: 'How we handle applications',
  },
  ar: {
    application:
      'أوافق على أن تحفظ {brand} هذا الطلب وتراجعه، بما في ذلك سيرتي الذاتية، للنظر في ترشيحي لهذه الوظيفة.',
    futureRoles: 'احتفظوا بطلبي أيضاً وتواصلوا معي بخصوص وظائف مستقبلية.',
    noticeLink: 'كيف نتعامل مع طلبات التوظيف',
  },
};

/** The consent copy for a locale with the brand (or legal name) filled in. */
export function recruitmentConsent(locale: 'en' | 'ar', brand: string): RecruitmentConsentCopy {
  const c = RECRUITMENT_CONSENT[locale];
  return { ...c, application: c.application.replaceAll('{brand}', brand) };
}
