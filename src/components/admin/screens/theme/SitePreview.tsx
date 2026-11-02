import type { Palette } from '@theme/gate';

// A sample of the site in a palette (Admin v2 E4; the prototype's opsThemePreview): a dark hero
// band (the heading's highlighted word in Accent, a Primary button and a Hover one), then a
// light band (a Primary kicker, an outlined button) and an Arabic line. Painted by SVG
// attributes only (fill, stroke), with colours the palette already validated: no style
// attribute, no markup built from strings (CSP, ui.md §1.6). The fixed colours are the site's
// own (black, the light section, white). Decorative words, so the picture is one image with
// a name.

export default function SitePreview({ palette }: { palette: Palette }) {
  return (
    <svg
      className="theme__pv"
      viewBox="0 0 320 236"
      role="img"
      aria-label="A sample of the site in these colours: a dark band with a button, a light band and an Arabic line"
    >
      <rect x="0" y="0" width="320" height="236" fill="#ffffff" />
      <rect x="0" y="0" width="320" height="120" fill="#000000" />
      <text x="18" y="26" fontSize="8" fill="#a6adbf" letterSpacing="1.2">
        CREATIVE STUDIO
      </text>
      <text x="18" y="52" fontSize="19" fontWeight="800" fill="#ffffff">
        From the brain to the
      </text>
      <text x="18" y="74" fontSize="19" fontWeight="800" fill={palette.accent}>
        real world
      </text>
      <rect x="18" y="88" width="92" height="22" rx="11" fill={palette.primary} />
      <text x="64" y="102.5" fontSize="9" fontWeight="700" fill="#ffffff" textAnchor="middle">
        Start a project
      </text>
      <rect x="118" y="88" width="62" height="22" rx="11" fill={palette.hover} />
      <text x="149" y="102.5" fontSize="9" fontWeight="700" fill="#ffffff" textAnchor="middle">
        Hover
      </text>
      <rect x="0" y="120" width="320" height="84" fill="#f3f5fa" />
      <text x="18" y="142" fontSize="8" fontWeight="700" fill={palette.primary} letterSpacing="1.2">
        SERVICES
      </text>
      <text x="18" y="162" fontSize="14" fontWeight="800" fill="#000000">
        What we do
      </text>
      <rect
        x="18.75"
        y="172.75"
        width="78.5"
        height="20.5"
        rx="10.25"
        fill="none"
        stroke={palette.primary}
        strokeWidth="1.5"
      />
      <text
        x="58"
        y="186"
        fontSize="8.5"
        fontWeight="700"
        fill={palette.primary}
        textAnchor="middle"
      >
        All services
      </text>
      <text
        x="302"
        y="224"
        fontSize="12"
        fontWeight="700"
        fill="#000000"
        textAnchor="start"
        direction="rtl"
      >
        من الدماغ إلى العالم الحقيقي
      </text>
    </svg>
  );
}
