import { describe, expect, it } from 'vitest';
import {
  CALENDLY_URL,
  CalendlyUrlSchema,
  GA4_ID,
  GSC_TOKEN,
  Ga4IdSchema,
  INTEGRATION_MESSAGES,
  IntegrationsSchema,
  SearchConsoleTokenSchema,
  isCalendlyUrl,
  searchConsoleCode,
} from '@schemas/integrations';
import { IntegrationsSchema as FromAdmin } from '@schemas/admin';

// The integrations' typed values (Admin v2 U11): public identifiers only, each in the shape
// its database CHECK takes (tests/lib/integrationsSql.spec.ts holds the patterns equal), so a
// value that passes here is never a 23514 there, and no secret, markup or foreign host fits.

const issue = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : (result.error?.issues[0]?.message ?? 'refused');

describe('the GA4 measurement id', () => {
  it('takes G- and 4 to 15 capitals or digits, trimmed and upper-cased', () => {
    expect(Ga4IdSchema.parse('G-ABC123XYZ')).toBe('G-ABC123XYZ');
    expect(Ga4IdSchema.parse('  g-abc123xyz ')).toBe('G-ABC123XYZ');
    expect(Ga4IdSchema.parse('G-ABCD')).toBe('G-ABCD');
    expect(Ga4IdSchema.parse(`G-${'A'.repeat(15)}`)).toBe(`G-${'A'.repeat(15)}`);
  });

  it.each([
    'UA-12345-1',
    'G-ABC',
    `G-${'A'.repeat(16)}`,
    'G-ABC 123',
    'G-ABC-123',
    'GTM-ABC123',
    '',
    'G-ABC123"><script>',
  ])('refuses %j with the plain words', (value) => {
    expect(issue(Ga4IdSchema.safeParse(value))).toBe(INTEGRATION_MESSAGES.ga4);
  });
});

describe('the Search Console verification code', () => {
  const CODE = 'abcDEF012_-xyzVerification';

  it('takes the code itself, trimmed', () => {
    expect(SearchConsoleTokenSchema.parse(CODE)).toBe(CODE);
    expect(SearchConsoleTokenSchema.parse(`  ${CODE}\n`)).toBe(CODE);
  });

  it.each([
    `<meta name="google-site-verification" content="${CODE}" />`,
    `<meta name="google-site-verification" content="${CODE}">`,
    `<meta content="${CODE}" name="google-site-verification">`,
    `<meta name='google-site-verification' content='${CODE}' />`,
    `<META NAME="google-site-verification" CONTENT="${CODE}">`,
    `  <meta  name = "google-site-verification"  content = " ${CODE} " />  `,
  ])('reads the code out of the whole tag Search Console hands out: %s', (paste) => {
    expect(searchConsoleCode(paste)).toBe(CODE);
    expect(SearchConsoleTokenSchema.parse(paste)).toBe(CODE);
  });

  it.each([
    ['another meta tag', `<meta name="description" content="${CODE}">`],
    ['a tag with no content', '<meta name="google-site-verification">'],
    ['markup around the code', `<div>${CODE}</div>`],
    ['a quote', 'abc"defghijkl'],
    ['an angle bracket', 'abc<defghijkl'],
    ['a space', 'has a space in it'],
    ['too short', 'short'],
    ['too long', 'a'.repeat(101)],
    [
      'a paste far too long to be a tag',
      `<meta name="google-site-verification" content="${'a'.repeat(2000)}">`,
    ],
  ])('refuses %s', (_name, value) => {
    expect(issue(SearchConsoleTokenSchema.safeParse(value))).toBe(
      INTEGRATION_MESSAGES.searchConsole,
    );
  });

  it('never returns markup: whatever it accepts matches the pattern', () => {
    for (const paste of [CODE, `<meta name="google-site-verification" content="${CODE}">`]) {
      expect(GSC_TOKEN.test(SearchConsoleTokenSchema.parse(paste))).toBe(true);
    }
  });
});

describe('the Calendly booking link', () => {
  it.each([
    'https://calendly.com/studio',
    'https://calendly.com/studio/',
    'https://calendly.com/studio/30min',
    'https://calendly.com/studio/30min/intro',
    '  https://calendly.com/studio  ',
  ])('takes %j', (value) => {
    expect(CalendlyUrlSchema.parse(value)).toBe(value.trim());
  });

  it.each([
    ['http, not https', 'http://calendly.com/studio'],
    ['another host', 'https://evil.example/studio'],
    ['a host that starts like it', 'https://calendly.com.evil.example/studio'],
    ['a subdomain', 'https://www.calendly.com/studio'],
    ['a query', 'https://calendly.com/studio?x=1'],
    ['a fragment', 'https://calendly.com/studio#x'],
    ['a port', 'https://calendly.com:8443/studio'],
    ['credentials', 'https://user:pass@calendly.com/studio'],
    ['no path', 'https://calendly.com/'],
    ['four segments', 'https://calendly.com/a/b/c/d'],
    ['a dot in a segment', 'https://calendly.com/a.b'],
    ['javascript', 'javascript:alert(1)'],
    ['longer than 200', `https://calendly.com/${'a'.repeat(190)}`],
  ])('refuses %s', (_name, value) => {
    expect(isCalendlyUrl(value.trim())).toBe(false);
    expect(issue(CalendlyUrlSchema.safeParse(value))).toBe(INTEGRATION_MESSAGES.calendly);
  });

  it('whatever it accepts the pattern accepts too', () => {
    expect(CALENDLY_URL.test(CalendlyUrlSchema.parse('https://calendly.com/a/b/c'))).toBe(true);
  });
});

describe('PATCH /api/admin/integrations', () => {
  it('is the module admin.ts re-exports', () => {
    expect(FromAdmin).toBe(IntegrationsSchema);
  });

  it('takes any of the three and the version; a blank box or null clears one', () => {
    expect(IntegrationsSchema.parse({ version: 0 })).toEqual({ version: 0 });
    expect(IntegrationsSchema.parse({ ga4MeasurementId: 'g-abc123', version: 3 })).toEqual({
      ga4MeasurementId: 'G-ABC123',
      version: 3,
    });
    expect(
      IntegrationsSchema.parse({
        ga4MeasurementId: '',
        searchConsoleToken: '   ',
        calendlyUrl: null,
        version: 1,
      }),
    ).toEqual({ ga4MeasurementId: null, searchConsoleToken: null, calendlyUrl: null, version: 1 });
  });

  it.each([
    ['the legacy ga4 box', { ga4: { id: 'G-X' }, version: 1 }],
    ['the legacy searchConsole box', { searchConsole: {}, version: 1 }],
    ['the legacy calendly box', { calendly: {}, version: 1 }],
    ['the legacy recaptcha box', { recaptcha: { secret: 'x' }, version: 1 }],
    ['a captcha key', { captchaSiteKey: 'x', version: 1 }],
    ['an API key', { apiKey: 'sk_live_x', version: 1 }],
  ])('refuses %s (strict: no free-form value, and no secret, reaches the row)', (_n, body) => {
    expect(IntegrationsSchema.safeParse(body).success).toBe(false);
  });

  it('needs the version the editor loaded, a whole number from 0', () => {
    expect(IntegrationsSchema.safeParse({ ga4MeasurementId: null }).success).toBe(false);
    expect(IntegrationsSchema.safeParse({ version: -1 }).success).toBe(false);
    expect(IntegrationsSchema.safeParse({ version: 1.5 }).success).toBe(false);
  });

  it('a GA4 id the pattern refuses is refused on its field', () => {
    const result = IntegrationsSchema.safeParse({ ga4MeasurementId: 'UA-1', version: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['ga4MeasurementId']);
    expect(GA4_ID.test('UA-1')).toBe(false);
  });
});
