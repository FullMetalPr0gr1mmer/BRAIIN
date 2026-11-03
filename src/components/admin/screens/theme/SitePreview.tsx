import { DEFAULT_FONTS, type ThemeFonts } from '@theme/fonts';
import type { Palette } from '@theme/gate';
import { fontStack } from './model';
import {
  BUTTON_RADIUS,
  CORNER_SCALE,
  DEFAULT_SHAPES,
  DEFAULT_TYPE,
  type ThemeShapes,
  type ThemeType,
} from '@theme/shapes';

// A sample of the site in a theme (Admin v2 E4, E12; the prototype's opsThemePreview): a dark
// hero band (the heading's highlighted word in Accent, a Primary button and a Hover one), then a
// light band (a Primary kicker, a heading, an outlined button and two cards), and an Arabic
// heading. Painted by SVG attributes only (fill, stroke, rx, font-weight), with colours the
// palette already validated: no style attribute, no markup built from strings (CSP, ui.md
// §1.6). The fixed colours are the site's own (black, the light section, white). Since E12 it
// draws the shapes and type too, at half the site's size, from the site's own tables
// (packages/theme/shapes.ts; E12 code review CR9): the cards' corners (the site's 16 px times
// the corner scale), the buttons (BUTTON_RADIUS: a pill is half the button's height), the
// headings' weight and case. Since E13 its English words are drawn in the English pages' family
// and its Arabic line in the Arabic pages' (a font-family attribute: the stacks of the font
// catalogue, whose faces admin.css declares). Decorative words, so the picture is one image
// with a name.

/** The sample draws the site at half size. */
const SAMPLE_SCALE = 0.5;
/** The sample's buttons are 22 px tall, so a pill's corner is 11. */
const BUTTON_HEIGHT = 22;
/** A card's corner on the site before the scale (the discipline and value cards' 16 px). */
const CARD_RADIUS = 16;

/** A button's corner in the sample: the site's radius at half size, a pill at most. */
const buttonRx = (style: ThemeShapes['buttons']) =>
  Math.min(BUTTON_RADIUS[style] * SAMPLE_SCALE, BUTTON_HEIGHT / 2);

export interface SitePreviewProps {
  palette: Palette;
  shapes?: ThemeShapes | undefined;
  type?: ThemeType | undefined;
  fonts?: ThemeFonts | undefined;
}

export default function SitePreview({
  palette,
  shapes = DEFAULT_SHAPES,
  type = DEFAULT_TYPE,
  fonts = DEFAULT_FONTS,
}: SitePreviewProps) {
  const rx = buttonRx(shapes.buttons);
  const card = CARD_RADIUS * SAMPLE_SCALE * CORNER_SCALE[shapes.corners];
  const weight = String(type.headingWeight);
  const heading = (words: string) =>
    type.headingCase === 'uppercase' ? words.toUpperCase() : words;
  return (
    <svg
      className="theme__pv"
      viewBox="0 0 320 262"
      role="img"
      aria-label="A sample of the site in this theme: a dark band with buttons, a light band with cards, and an Arabic heading"
      data-corners={shapes.corners}
      data-buttons={shapes.buttons}
      data-weight={weight}
      data-case={type.headingCase}
      data-latin={fonts.latin}
      data-arabic={fonts.arabic}
    >
      <rect x="0" y="0" width="320" height="262" fill="#ffffff" />
      <g fontFamily={fontStack(fonts, 'latin')}>
        <rect x="0" y="0" width="320" height="120" fill="#000000" />
        <text x="18" y="26" fontSize="8" fill="#a6adbf" letterSpacing="1.2">
          CREATIVE STUDIO
        </text>
        <text x="18" y="52" fontSize="17" fontWeight={weight} fill="#ffffff">
          {heading('From the brain to the')}
        </text>
        <text x="18" y="74" fontSize="17" fontWeight={weight} fill={palette.accent}>
          {heading('real world')}
        </text>
        <rect x="18" y="88" width="92" height="22" rx={rx} fill={palette.primary} />
        <text x="64" y="102.5" fontSize="9" fontWeight="700" fill="#ffffff" textAnchor="middle">
          Start a project
        </text>
        <rect x="118" y="88" width="62" height="22" rx={rx} fill={palette.hover} />
        <text x="149" y="102.5" fontSize="9" fontWeight="700" fill="#ffffff" textAnchor="middle">
          Hover
        </text>
        <rect x="0" y="120" width="320" height="110" fill="#f3f5fa" />
        <text
          x="18"
          y="142"
          fontSize="8"
          fontWeight="700"
          fill={palette.primary}
          letterSpacing="1.2"
        >
          SERVICES
        </text>
        <text x="18" y="162" fontSize="14" fontWeight={weight} fill="#000000">
          {heading('What we do')}
        </text>
        <rect
          x="18.75"
          y="194.75"
          width="78.5"
          height="20.5"
          rx={Math.min(rx, 10.25)}
          fill="none"
          stroke={palette.primary}
          strokeWidth="1.5"
        />
        <text
          x="58"
          y="208"
          fontSize="8.5"
          fontWeight="700"
          fill={palette.primary}
          textAnchor="middle"
        >
          All services
        </text>
        <rect x="150" y="136" width="72" height="80" rx={card} fill="#ffffff" stroke="#d9dde6" />
        <text x="160" y="156" fontSize="8" fontWeight="700" fill="#000000">
          01
        </text>
        <text x="160" y="204" fontSize="9" fontWeight="700" fill="#000000">
          Branding
        </text>
        <rect x="230" y="136" width="72" height="80" rx={card} fill="#ffffff" stroke="#d9dde6" />
        <text x="240" y="156" fontSize="8" fontWeight="700" fill="#000000">
          02
        </text>
        <text x="240" y="204" fontSize="9" fontWeight="700" fill="#000000">
          Production
        </text>
        <text
          x="302"
          y="250"
          fontSize="12"
          fontWeight={weight}
          fontFamily={fontStack(fonts, 'arabic')}
          fill="#000000"
          textAnchor="start"
          direction="rtl"
        >
          من الدماغ إلى العالم الحقيقي
        </text>
      </g>
    </svg>
  );
}
