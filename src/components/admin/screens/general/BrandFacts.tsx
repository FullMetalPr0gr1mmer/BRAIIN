// The Brand card's read-only tiles (Admin v2 U9): the logo and the logo for light backgrounds
// are files of the site build, not settings (owner item O-14: a logo that arrives with the
// page paints with the first screen), so the screen shows them and says why they cannot be
// changed here. The light-background tile is the same file drawn dark (a class, no style).

export const LOGO_NOTE = 'The logo is part of the site build so the first screen paints fast.';

export default function BrandFacts({ logoSrc }: { logoSrc: string | null }) {
  return (
    <div className="general__logos">
      <figure className="general__logo" data-ground="dark">
        {logoSrc && <img src={logoSrc} alt="Logo" width={132} height={67} />}
        <figcaption>Logo</figcaption>
      </figure>
      <figure className="general__logo" data-ground="light">
        {logoSrc && <img src={logoSrc} alt="Logo for light backgrounds" width={132} height={67} />}
        <figcaption>Logo for light backgrounds</figcaption>
      </figure>
      <p className="admin-sub general__logo-note">{LOGO_NOTE}</p>
    </div>
  );
}
