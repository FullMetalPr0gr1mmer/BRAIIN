// Generates the site's default share image: public/og/default.jpg (owner decision H2).
//
// WHY. A page with no image of its own — Home, About, Contact, Services, the catalogues,
// Join, the legal pages, the blog index, search — had no og:image at all, so a shared link
// unfurled as bare text. This card is the code default every such page now names
// (src/lib/seo/ogImage.ts): the white logo, trimmed and 560 px wide, centred on a 1200×630
// canvas of the brand's midnight blue (`--bs-midnight`, #000d30). Nothing but the mark (the
// header's own logo file): a share preview prints the page's own title beside the card, and
// a tagline baked into pixels could never be translated or edited in the CMS.
//
// The JPEG is COMMITTED: the site needs no image tooling at build or run time, and a share
// card is a file the platforms cache by URL. Re-run only when the logo or the brand colour
// changes — and then give the card a new name (OUT below and DEFAULT_OG_IMAGE.path in
// src/lib/seo/ogImage.ts): social caches keep the old card under the old URL.
// tests/seo/ogDefault.spec.ts checks the committed bytes: 1200×630, three channels, under
// 100 KB, midnight at the edges and white in the middle.
//
//   npm run og:gen        (sharp: an exact devDependency; `overrides: { sharp: "$sharp" }`
//                          gives Astro and miniflare the same copy)

import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';

const SOURCE = 'src/assets/braiin-logo-white.png';
const OUT = 'public/og/default.jpg';
const WIDTH = 1200;
const HEIGHT = 630;
const LOGO_WIDTH = 560;
/** `--bs-midnight` in public/styles/global.css. */
const MIDNIGHT = '#000d30';
/** A share card is fetched by every crawler that unfurls a link — keep it light. */
const MAX_BYTES = 100_000;

// trim(): the PNG has transparent margins; the card centres the mark itself, not its box.
const logo = await sharp(SOURCE).trim().resize({ width: LOGO_WIDTH }).png().toBuffer();

mkdirSync(dirname(OUT), { recursive: true });
await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: MIDNIGHT } })
  .composite([{ input: logo, gravity: 'centre' }])
  // 4:4:4: the default 4:2:0 halves the colour resolution, which smears a white mark's
  // edge into the blue — exactly the edge a thumbnail shows.
  .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:4:4' })
  .toFile(OUT);

const bytes = statSync(OUT).size;
if (bytes >= MAX_BYTES) {
  console.error(`  ✘ ${OUT}: ${bytes} B — the share card must stay under ${MAX_BYTES} B.`);
  process.exit(1);
}
console.log(`  ✓ ${OUT}: ${WIDTH}×${HEIGHT}, ${bytes} B`);
