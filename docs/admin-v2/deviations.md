# Admin v2: deviations register and TDD coverage

> The client's prototype (`admin.html`) and `ADMIN_TDD.md` are the product specification:
> "the prototype is the specification". This register lists every place the build
> deliberately differs, and why. A deviation exists only because the standard requires it
> (CLAUDE.md, cited) or because the owner decided it (A1 to A6, O-items in
> [README.md](README.md)). Owner item **O-13** asks for this register's approval. A slice that
> adds, removes or narrows a deviation edits this file in the same PR.

## Remaining deviations

- **Stack**: React islands + server routes, not the vanilla SPA or hash router; edge purge, not static regeneration; preview is a server render reloaded about 1 s after autosave, not per-keystroke `[data-i]` patching (§2, §3 CSP).
- **Roles** (A2/A4, RLS):
  - 5 roles;
  - no editable matrix, per-person grants or View as;
  - Developer gets no CRM (O-7), and no CRM settings: `crm.settings` is Admin only (§5 amended in C9a);
  - Sales (C10a) works leads only until C10b (contacts and tasks wait for O-11); it reads the website stats (README's matrix, prototype parity) though crm.md §2.1 said no analytics, and a lead's details reach it one lead at a time through the reveal, never in a notification (O-6);
  - Site health stays Admin + Developer.
- **Publishing**:
  - per area (P-2);
  - maintenance is immediate (Pillar 1);
  - media alt/tags are immediate (as in the prototype);
  - scheduling is per release.
- **Content**:
  - no HTML in copy (accent word ranges);
  - no Custom HTML section (§3 sanitizer/CSP);
  - no "show on mobile" (Pillar 3 parity);
  - testimonials need consent;
  - projects link the 28 real services;
  - a client's "Visible" is the disclosure permission;
  - archive/delete is Admin only.
- **Media**:
  - images only (video via Stream later, EXC-009);
  - no SVG/GIF, no animations, and no AVIF or HEIC input (the Images binding reads AVIF only on an Enterprise plan; U3);
  - originals are re-encoded: one WebP master at most 2,560 px on its long edge, EXIF and GPS dropped (AVIF output stops at 1,200 px, so `/_image` makes the AVIF derivatives from the master; B7 item 2, U3);
  - uploads are at most 20 MB, the Images binding's input limit, not 25 MB (B7 item 2, U3);
  - no upload more than 100 times as long as it is wide, either way (`MEDIA_MAX_ASPECT`): thinner, every width the site renders it at rounds its height to 0 and `/_image` admits no URL for it (U3 review);
  - a deleted or replaced upload stays reachable for up to about two hours after its file is removed, not "at once": Supabase's CDN copy and the `/_image` derivative live an hour each, the Free plan cannot purge the first, and purging the second needs the zone's purge token; pages cached before the change keep the old image URL until purged (owner: O-3 for the purge token, the Supabase plan for Smart CDN; runbook §6i; U3 review);
  - no local blob previews (CSP).
  - the picker lists images only, with no Videos segment: no picture field stores a video row, and a site clip is chosen in the clip field (D2, U4); the library keeps Images | Videos, the Videos tab read-only (EXC-009);
  - registering an external or built-in file by its path is gone from the screens: `/admin/media/new` is a 302 to the library's upload (`?upload=1`), and the `POST /api/admin/media` route and its case stay (D4, U4);
  - a picture's file name is read-only in the drawer, set at upload or replace: `update_media_meta()` has no write path for it (D7, U4);
  - a tile's name and size sit on a solid midnight band, not the prototype's transparent-to-70% gradient, whose contrast depends on the photo and cannot be proven AA (D15, U4);
  - the storage meter counts the media bucket only, against the plan's 1 GB that the CV bucket shares (D13, U4; the quota figure is the owner's to confirm);
  - the storage meter speaks binary units ("214 MB of 1 GB": 1 MB = 1,048,576 B, as the Supabase plan counts its quota), where P-10 counts KB as 1,000 B; a tile's size badge keeps P-10's units (U4 review);
- **Theme**:
  - no Google/Adobe font links or raw font uploads; the curated self-hosted catalogue replaces them (CSP, PDPL, font budget);
  - no Custom CSS;
  - no smooth scroll or parallax (compositor-only; design-port #44/#79);
  - colours must pass the contrast gate.
- **Header**: the language switch always shows (owner-approved product call, O-13).
- **Shortcuts**: the command palette opens on ⌘/Ctrl+K and from the topbar trigger, not on a bare "/". A one-character shortcut fires on a stray keypress or a dictated "slash", and WCAG 2.1.4 (Level A) requires it to be switchable off or remappable (DoD #4).
- **Footer**: legal links are locked (PDPL); copyright is a template (brand is data, §1).
- **Forms**:
  - closed field sets, no new fields (Zod boundary, per-column PII encryption);
  - the honeypot is always on;
  - recruitment consent is versioned.
- **Integrations**:
  - no secrets in staff-readable rows;
  - no API keys or outbound webhooks;
  - ad pixels wait for marketing consent (L6).
- **CRM**:
  - contact details behind an audited reveal; no budget in lists;
  - a lead's score shows as a number until the reveal: its reasons come with the contact details, through the audited reveal, because three of them (a budget given, a budget over 200k, a timeline given) name the budget band and the timeline (C4a, D7). The number itself is readable by every lead worker (all of whom hold `leads.pii`) and, with the scoring points, can imply the band: with the default points any score above 65 includes a budget over 200k;
  - the list's default order is starred first, then newest; "Newest" stays newest only, so the dashboard's latest leads do not move (C4a, D6);
  - a lead's stage changes through "Move to…", a short list of the other stages, never a native select (Windows browsers fire `change` on each arrow key, which would move a lead by accident), on a lead's page and, with C4c, on every board card (C4b, D11);
  - "Move to…" is named "Move to… {name}", the visible words first, not crm.md's "Move {name} to…": a spoken name that starts with what is seen (WCAG 2.5.3, Label in Name; C4b);
  - a lead's tags are a short chip list with Add tag and a remove button per tag, saved as one versioned PATCH each, not the field kit's tags field, so a lead's page never loads the field kit (C4b, D12);
  - "Add lead manually" is hidden until the page's script is up: with no JavaScript there is no drawer to open (C4b, D9); the list, a lead's page and their links all work without it;
  - a ranged KPI's change compares the same elapsed span one range earlier (the last 7 days so far against the same days and hours a week before), never a part day against whole ones (C4b; C4a left it open);
  - a role without `leads.manage` that opens a leads page by its address gets the admin's one refusal, "Your role does not allow that." (`Refused.astro`, a 403, nothing read), not crm.md's "You do not have access to this / Ask an admin if you need it" (C4b, the U2 pattern);
  - "Agreed to be contacted about this inquiry" shows the public form's checkbox for a web-form lead, and "Added by hand" for a lead added by hand, whose column records no such answer (C4b, D10);
  - the list and the board are the Leads area's List | Pipeline tabs (links, zero JS), not the prototype's Inbox | Pipeline segmented switch: "Inbox" is reserved for L6's messaging (C4c, D2);
  - the board has no pointer drag yet: "Move to…" on every card is the one way to move a lead there (the prototype's native drag is optional in crm.md and would need the kit's Sortable core in cross-list mode and a pass of the sweep; C4c, D5); its sub-line says "Use Move to… on a card", not "Drag a card";
  - the board was carved out of C4b by size (the Wave 3 brief, §13) and ships as C4c, its help line in its own restatement (0068, after G2's 0067; every later Wave 3 reservation moved up by one);
  - CRM settings (C9a): a stage's colour is one of six named tones, never a free colour (CSP; each tone AA-checked); stages reorder with Move up / Move down, not drag; a stage that holds leads cannot be removed or change what it counts as until its leads move; the cards are Pipeline stages, Lead scoring and Response time and assignment only (custom fields and contact stages arrive with contacts, C9b; retention stays in General settings; the messaging cards wait for L6; the time zone is General's, B7.5);
  - no client-side CSV;
  - Mark as spam + Admin-only Erase instead of delete;
  - no keystroke autosave;
  - retention is one horizon ≤ 24 months after last activity;
  - consent toggles, unsubscribe and Suggested reply/Send wait for L6.
- **Stats**:
  - referrer/UTM/device/country and unique visitors wait for L5 (legal);
  - "No cookie banner needed" is corrected (§7);
  - goals are set by Admin and SEO only, through a new capability, `analytics.goals` (a CLAUDE.md §5 amendment, G1c, D2: §5's "Analytics — read dashboards" grants reading, and SEO owns analytics in the role model); the prototype let every stats role add one. Content Creator and Developer see the goals with no controls;
  - a visit is one tab's session id on one UTC day, not a 30-minute inactivity window (G1 D3), and there is no average time on site or per page (a tab's last page has no end time);
  - the funnel stops at "Reached an inquiry form": no "Started the form" step and no "Inquiry sent" event, because either would put a session's page trail beside an identified lead (G1 D4); inquiries received show apart, to lead workers only, with why;
  - no "Video played" event (the loops play by themselves; there is no play action to count);
  - realtime is the people active in the last five minutes, their pages and page views per minute, from a one-minute rollup; no live feed of single page views with country and device (raw rows on a screen; L5) (G1b);
  - raw `analytics_events` and `web_vitals` are read by the service role only; every staff screen reads rollups (G1 D6).
  - the goals card saves through its own small form in the kit's Drawer (POST/PATCH/DELETE, then a reload with a confirmation), not `EditorForm` + `useEntitySave`: a goal is four fields saved at once, with no autosave or draft (P-3), the C4b manual-lead pattern (G1c);
  - the busiest hours are drawn in the admin's series colours (the four busiest strong, the rest in the second series) and named in a sentence under the chart, not the prototype's two shades of Klein.
- **Backups**: leads are never in admin backups (DR via the runbook, §7/§10).
- **Activity log**: kept permanently and tamper-evident, not "12 months" or "90 days" (§3); exportable under the export lockdown, with no titles in the file (U13).
- **Invites** expire per Supabase Auth instead of 7 days, until L6 brings transactional email (O-22). As built (U12b, decision D1): **one hour, with Resend**, because Supabase has one e-mail link expiry (`otp_expiry`) for invite and reset links, so a longer invite would make reset links live as long; the owner may choose longer (up to 24 h) for both.
- **Bundle** (O-15, decided by the approved plan's default on 2026-10-18; C4b): the admin bundle's gate is each admin screen's eager graph, at most 300 KB gz (`scripts/admin-bundle.mjs`), with its own caps on the lazy chunks and the sign-in script; the size-limit sum of every admin file, lazy ones included, is a coarse 400 KB tripwire, no longer the budget (it was 300 KB, and the leads screens took it past that).
- **Health**: uptime from the external monitor's read-only API (G2); no in-Worker checker (§10); certificate expiry only where the monitor reports it (RDAP carries the domain's registration, not the certificate); no Alerts drawer or external channels (A1); the bell instead, for siteHealth.view roles.
- **Help** (U16):
  - guides only for features that are built (nine of the prototype's fifteen described later-phase screens; "roles" promised per-person exceptions §5 does not have);
  - no editing yet: the migrations write the guides until an editor and its capability exist (§5, TDD phase 7);
  - no "Get connected" or "Ask us" in the drawer (A1 later phase; no support channel exists).
- **Page visibility** (U14a): four modes in the prototype, three in U14a ("Behind a password" is U14b); the KV snapshot is its own key, `site:visibility`, not part of `site:maintenance` as AV-13 said (two writers on one value would race); no anon read of the table (D3); templates are public or hidden only (D1).
- **General settings and maintenance** (U9, the folded U9a + U9b PR; as built: [as-built/U9.md](as-built/U9.md)):
  - the studio's time zone lives in `site_settings.timezone`, not `site_profile.timezone` as the approved plan's B7.5 said: `site_profile` is staged once releases switch on and anon-readable, while the zone is immediate (P-3) and a staff-only technical key, which CLAUDE.md §8 keeps in `site_settings` (the plan's own design cross-check says so; Wave 3 corrections, U9a);
  - the timezone is its own immediate card, "Region and data", saved apart from the staged identity (P-3), from a closed list of ten zones (the prototype offered five; `crm_settings`' ten, one source);
  - maintenance stays a tab of General (`/admin/maintenance`), not a card inside `/admin/settings` (F2's rule: a screen the prototype folds into another area is a tab; U14a's Page visibility tab sits beside it; the badge, the bell and the help links keep their address) (D2);
  - the logos are read-only tiles: they are build files so the first screen paints fast (O-14); the domain and the languages are read-only facts (§2 i18n), editable in the prototype;
  - the WhatsApp hint drops "and in the floating button" (there is none), the Social accounts sub-line drops "the footer" until E6 renders it, and "Reset demo data" is gone (P-12: copy must be true);
  - social accounts at most 8 (the prototype allows 10; the 0019 CHECK);
  - the footer basics (copyright, style, show email, show social) are stored, typed and served by U9 but edited in Appearance › Footer (E6), with defaults equal to today's footer;
  - the job-applications switch sits in its own card and saves at once through R3b's intake endpoint (never staged), not inside the Advanced card where Save would suggest it waits;
  - maintenance's background is "The hero image" (the blurred still), never "The hero video": no video bytes on a 503 (EXC-009 risk);
  - the maintenance message has three built-in forms, matching the buttons shown (the prototype's one promised WhatsApp on a page that may show none);
  - no ribbon on public pages a signed-in person sees past maintenance (D13): the admin's top bar says it is on;
  - the reconcile after "Back on" runs every 10 minutes in G2's schedule (the plan's §5.7 default), not hourly as U9's brief said: one fewer cron trigger, and the row follows the edge sooner;
  - every admin clock follows the studio's zone (D3), and so do the busiest hours (G1) and the uptime strip's days (G2), whose guides U9 re-words; page visibility's hide-from and show-on days stay Riyadh days (U14a stores their midnights at +03:00 and the edge compares instants), which its guide says, so a zone change never moves a window someone already set (moving them is a follow-up with its own guide edit);
  - C9a (0091) wrote, before this PR, that the zone moves to `site_profile.timezone` (B7.5): it is `site_settings.timezone` (the first bullet); C9a's screen reads `crm_settings.timezone` but never shows or writes it.
- **Copy corrected** where untrue:
  - maintenance "…after you publish";
  - page visibility "Takes effect when you publish" / "Hidden from the site after you publish" → "Applies to the live site within a few minutes" until releases switch on (U14a, D7);
  - "Kept for 90 days";
  - "Backups cover everything, including leads";
  - "nothing is saved until you publish" → "nothing goes live until you publish";
  - Health's "No CSP header".

## Residual risks waiting on the owner

Gaps the build cannot close in code, recorded with the owner action that closes them, an
owner, an expiry and a close condition (CLAUDE.md §11).

- **A password changed at Supabase Auth itself** (Admin v2 F8; owner item **O-24**).
  - *The gap.* The admin's own `POST /api/admin/me/password` re-authenticates with the
    current password, counts a refused one toward the 5-in-15-minutes lockout, holds the new
    one to 10 characters, signs out every other session and is audited. All of that is the
    Worker's. Supabase Auth's `PUT /auth/v1/user` is public (the project URL and the anon
    key ship to every browser), and with a session's access token alone (read from an
    unlocked machine's devtools, or a copied `__Host-braiin-auth` cookie) it sets a new
    password: no current password (GoTrue's default), no lockout count, GoTrue's own minimum
    length, and no row in the app's hash-chained `public.audit_log` (GoTrue records the
    change only in its own auth audit log, as `user_updated_password`). GoTrue then signs out
    every other session of that user, so the real owner's other devices are signed out too:
    only the session that made the change stays signed in, and the real owner is locked out
    of their account. It predates F8, which built the checked route and recorded this.
  - *What the code does.* The route sends `current_password` with the update and counts
    GoTrue's `current_password_invalid` as a wrong try, so it keeps working when the setting
    below is on. The local stack (`supabase/config.toml`, pinned by
    `tests/lib/accountPassword.spec.ts`) sets the minimum length to 10 and turns on Secure
    password change: a session older than 24 hours needs an e-mailed code to change its
    password at the auth server. The admin's route never needs that code, because its
    re-authentication starts a fresh session, so no password change depends on SMTP (O-2).
    Requiring the current password has no key in `config.toml` (CLI 2.118), so CI proves the
    Worker's path only.
  - *What closes it* (launch runbook §2a, staging and production): require the current
    password (`security_update_password_require_current_password`), minimum length 10,
    Secure password change on. A direct call then needs the current password too. What
    remains is GoTrue's to own: a direct call counts no lockout, and a direct change is
    audited only in GoTrue's own log (`user_updated_password`), never in `public.audit_log`,
    so a stolen token can still be used to guess the current password there, outside the
    Worker's lockout; O-24 asks the owner to accept that remainder. Without the first
    setting, a token from a session younger than 24 hours still changes the password.
  - *A compensating control (not built; the owner's choice).* Every change, the admin's
    included, reaches GoTrue, so every change writes `user_updated_password` to GoTrue's own
    log (the project's Auth logs, and `auth.audit_log_entries` unless the project has turned
    off writing auth audit logs to the database). A change through the admin also writes
    `auth.password_change` to `public.audit_log` for the same user a moment later. A
    `user_updated_password` with no matching `auth.password_change` is a change made outside
    the admin, and an alert on it shows the takeover above. A recovery or invite link, once
    set up (O-2, O-22), also sets a password at the auth server, so such an alert must
    allow for those.
  - *Owner:* Kareem (O-24). *Expiry:* F8's production push, at the latest 2026-11-30.
    *Closes when* the Management API's auth config on both projects reads
    `security_update_password_require_current_password: true`, `password_min_length: 10`
    and `security_update_password_require_reauthentication: true`.

- **Two factor sign in: what stays open** (Admin v2 U17; owner item **O-25**).
  - *The gap.* 2FA is enforced in two layers (the access-token hook stamps the role only at
    the required `aal`; `resolveAuthContext` holds a session below it at `/admin/2fa`), but
    four things stay outside them. (1) A code typed at Supabase Auth's own verify endpoint
    (the project URL and the anon key are public) counts nothing toward the Worker's
    5-in-15-minutes lockout: only GoTrue's per-IP rate limit bounds guessing there (the "MFA
    verification attempt" hook that could lock it is a paid-plan feature); a million codes
    with about three valid per window keeps it slow, not impossible, and only for someone who
    already has the password. (2) Until a person sets 2FA up, their password alone protects
    them, even with Require 2FA on: whoever holds the password at their next sign-in sets it
    up first. (3) An access token minted before someone turned 2FA on, or before Require was
    switched on, keeps its role at PostgREST for up to an hour (the hour U12a records); the
    admin itself holds it at the second step at once. (4) No recovery codes: a lost phone
    needs an Admin's Reset 2FA, and the account owner's needs whoever runs the database
    (launch runbook §3a).
  - *What the code does.* Wrong codes at the sign-in step and for turning 2FA off count
    toward the lockout, and `registerSuccess` waits for the code. Users & roles shows who is
    Off, site health counts them (Admin), and `auth.two_step_on`, `auth.two_step_off` and
    `user.two_step_reset` are in the activity log. Require 2FA can be turned on only by an
    Admin whose own session uses 2FA.
  - *What closes it.* (1) and (4) are Supabase Auth's to own; O-25 asks the owner to accept
    them, and to confirm TOTP is enabled on staging and production (launch runbook §2d). (2)
    closes as people set it up (Reset 2FA and Require 2FA are the tools); (3) is the token
    lifetime's, as for a role change.
  - *Owner:* Kareem (O-25). *Expiry:* U17's production push, at the latest 2026-12-31.
    *Closes when* the hosted projects read `mfa_totp_enroll_enabled: true` and
    `mfa_totp_verify_enabled: true` and the owner has accepted (1) to (4) here.

- **A reset link's token in the platform's request logs** (Admin v2 F7; owner item **O-2**).
  - *The gap.* `wrangler.jsonc` turns observability on, so Workers Logs keep an invocation
    log per request, with its URL. The reset e-mail's link carries its token in the query
    string (`/admin/reset?token_hash=…&type=recovery`, the recovery template, launch runbook
    §2b), so the click, and any mail scanner's prefetch of the link, write a live token into
    the logs, readable by whoever can read the Cloudflare account's logs, for the link's hour
    (one use; a reset then signs the account out everywhere). It opens with O-2: until
    `AUTH_EMAIL_READY` is on, no reset e-mail is sent.
  - *What the code does* (F7 final review). Nothing else puts the token in a URL: a form
    post that keeps the link (a mismatch, a short password, a limit, an outage, a page left
    open too long) goes back to `/admin/reset?error=<code>` with the token in
    `__Secure-braiin-reset`, a 15-minute HttpOnly, SameSite Strict cookie scoped to
    `/admin/reset` (`src/lib/auth/resetToken.ts`), which the page drops as soon as the token is in its form, so the browser does not offer the link to whoever uses it next; and the page sends its Referer as
    `strict-origin`, so its own form post and links carry the origin alone.
  - *What closes it* (the owner's choice): accept it as above; or turn Workers Logs'
    invocation logs off, or sample them (`observability.logs` in `wrangler.jsonc`: the
    `console` lines the Worker's error path writes are not invocation logs); or put the
    token in the link's fragment (`#token_hash=…`), which no request carries, read into the
    form by a small nonced script on the reset page, a later slice since the sign-in screens
    load no JavaScript today.
  - *Owner:* Kareem (O-2). *Expiry:* the production deploy that turns `AUTH_EMAIL_READY` on,
    at the latest 2026-12-31. *Closes when* one of the three is chosen and recorded here.

- **A copied session cookie outlives the 7 days** (Admin v2 F7; owner item **O-24**).
  - *The gap.* "Keep me signed in" bounds the session cookie: Max-Age 7 days, rewritten at
    each token refresh, or a browser-session cookie when unticked. The refresh token inside
    it is Supabase Auth's, and no environment sets Auth's own session limits, so the session
    has no end of its own until a sign-out or a password reset revokes it. A cookie value
    copied off a machine (devtools on an unlocked screen, a backup, malware) keeps working
    after the browser has dropped its own copy; so does a session-only cookie a browser
    restores after a restart. CLAUDE.md §3 states exactly this.
  - *What the code does.* Every lifetime the Worker writes is its own (not @supabase/ssr's
    400 days, `src/lib/auth/session.ts`); a sign-out revokes the session at the auth server;
    a reset signs the account out everywhere; `tests/lib/session.spec.ts` holds §3's sentence
    to the cookie's number and this residual.
  - *What closes it* (launch runbook §2c, staging and production): the auth server's
    inactivity timeout at 168 hours (the cookie's 7 days), and optionally a time-box, a
    paid-plan setting. Local stacks set neither, so CI cannot prove it.
  - *Owner:* Kareem (O-24). *Expiry:* 2026-12-31, or the move to a plan that offers the
    setting, whichever is first. *Closes when* both projects' Authentication session settings
    show the inactivity timeout (and the time-box, if chosen).

- **A stale access token keeps its old role for up to an hour** (hotfix H10, U12a and U13
  close more of it; owner item: confirm the remainder).
  - *The gap.* RLS reads the role from the token, and an access token lives up to an hour
    (`jwt_expiry`, Supabase's default 3600 s; `supabase/config.toml` does not set it). PostgREST
    checks the token's signature and expiry, not whether its session still exists, so a token
    already issued keeps its old role there, directly, until it expires, on every table
    without a live check.
  - *Closed before H10.* Leads and the CRM tables (`leads_live` and the CRM's live policies,
    0033 on), job applications (`app.is_live_admin()`, 0029), preferences (0044), and the
    export and reveal paths (`liveRecheck`).
  - *Closed by H10 (0050).* Every staff write to `profiles`: RESTRICTIVE policies require
    `app.role_manages_users(app.live_role())`, so a demoted, deactivated or locked Admin's
    token can no longer promote or reactivate itself (which the access-token hook would then
    have stamped into its next token, outliving the hour) or change anyone else; the users
    screen's PATCH also refuses (403) a write the database skipped, instead of stamping the
    claims and auditing a change that never happened. And the actor of a staff token's audit
    row: `audit_log_actor` binds `actor_id`, `actor_role` and `created_at` to the caller,
    so a forged row naming a colleague, backdated, can no longer be chained. A stale token's
    audit insert is still accepted, but names the stale account and the role its token
    carries.
  - *Closed by U12a (0055).* `resolveAuthContext` compares the profile with the claims of the
    token the request carries (no longer the auth server's current record, which the users
    screen rewrites with the profile), so the admin revokes a stale token at its next
    request (CLAUDE.md §2, session invalidation, now true); a change of `profiles.role`,
    `is_active` or `tenant_id` deletes every session and refresh token of that person
    (`profiles_revoke_sessions`), so no refresh is possible and the admin finds no session at
    the next click; reading colleagues' profiles is live (`profiles_live_read`), and so is
    every staff command on `admin_security_settings`; the roles guide says exactly what
    closes at once and what lasts the hour.
  - *Closed by U13 (0054).* Reading `audit_log`: `audit_log_live_read` (RESTRICTIVE, FOR
    SELECT) requires `app.role_views_audit(app.live_role())`, so a demoted, deactivated or
    locked Admin or Developer token reads no entry at PostgREST; the names the log shows come
    through `public.audit_people`, which answers nobody for such a token either.
  - *Left after them.* The issued token's old role at PostgREST, until it expires, on the
    tables with no live check: `site_settings`, `site_integrations`, `ai_config`,
    `media_assets`, `system_logs` and the content tables (the staged ones close when R5's
    guard switches on at R14). The proposed follow-up: a catalog-driven pgTAP asserting a
    RESTRICTIVE live companion on every policy that admits an `authenticated` write, and the
    missing companions; the owner may also shorten `jwt_expiry` to 900 s (the dashboard and
    `config.toml`), which shrinks the window to 15 minutes at four times the token refreshes.
    Supabase Auth's own endpoints are the residual above (O-24): the session-length setting
    (U12a) is enforced by the admin on every request it serves, not by Auth.
  - *Owner:* Kareem. *Expiry:* the follow-up slice or R14, whichever is first, at the latest
    2026-12-31. *Closes when* every policy admitting an `authenticated` write has a
    RESTRICTIVE live companion, checked over the catalog.

- **Team members are guarded but not captured: an R14 blocker** (Admin v2 R5, 0066; owner
  item **O-12**).
  - *The gap.* R5 puts the release guard on every registry table, `team_members` included, so
    once a tenant's releases are on a staff edit of a team member outside a release is
    refused (42501) like any other, and team-member changes go through a release (R4 applies
    them). But `team_members` keeps no history (0038) and has no capture trigger (0051, R5):
    a release that changes a team member records no item (R4 returns a minimal one), and an
    out-of-band write the guard lets through (the runbook, the service role, Auth setting a
    removed account's link to null) records no system item. A restore (R10) therefore cannot
    put a team member back, and R10 refuses team members ("History isn't kept for team members
    yet", R4 D2). Inert today: `app.release_tenants` is empty.
  - *Why not excluded from the guard.* Excluding `team_members` would let staff edit team
    members live while every other registry table goes through releases, which R3a's kernel
    (it stages team-member edits) and the registry contract do not allow. The guard stays; the
    missing history is O-12's (PDPL: staff names and bios kept after an erasure).
  - *What closes it.* The owner decides O-12 (history redaction, R16): either team members get
    history and capture (a snapshot and a capture trigger, with R16's redaction), or the owner
    accepts that a release cannot restore a team member, and R14's runbook says so.
  - *Owner:* Kareem (O-12). *Expiry:* R14's switch-on. *Closes when* O-12 is decided and
    R14's checklist records the outcome (pgTAP `snapshot_coverage.test.sql` names the
    exemption).

## The client's TDD, row by row

Checked by the coverage reviewer against the three designs on 2026-10-03
([verification.md](verification.md)). "Verified" is that review's status. "After A6" is what
the program does with it: the owner's full-fidelity decision (A6) turned every
`deviated-challenge` row into a built slice, and every `missing` row became a slice. The
"Where" column uses design slice ids; README maps them to program slices.

| TDD § | Requirement | Verified (2026-10-03) | After A6 | Where (design ids) | Note |
|---|---|---|---|---|---|
| §2.1 | Every page, section, text, image, video window, order and visibility editable in EN+AR with live preview, draft and publish | covered | covered | AV-23, AV-25, AV-26, AV-31; R1-R12; P-3/P-4/P-5 | Core loop covered. Preview refreshes about 1 s after autosave (P-4, binding). The convenience gaps (section style settings, generic blocks, Shared text, New page) are separate rows below. |
| §2.2 | Services (5 disciplines, 28 services) and projects managed as records; public pages generated from them | covered | covered | existing disciplines/services/service_cases/portfolio + AV-14, AV-15, AV-31 | Public pages are Tier A SSR purged by tag, not generated files (§2). |
| §2.3 | Theme, header, footer, loading screen, logo and general settings applied to the site | covered | covered | AV-18, AV-27-AV-30, MERGE:header-options, P-9 | Storage must follow P-9 (site_appearance + footer on site_profile), not AV-28's site_chrome. Logo stays a code asset (owner item 7). |
| §2.4 | Leads into a CRM: contacts, companies, pipeline, tasks, PDPL consent | covered | covered | CRM-1-CRM-12, CRM-14 | Erasure, retention and audited reveal go further than the prototype on PDPL. |
| §2.4 | Inbox (email/WhatsApp), campaigns, broadcasts, automations, templates with approval, CRM reports, exports, ad audiences | deferred | later phase (A1) or legal gate | A1 later phase; CRM design §12 hooks | Consistent with A1. |
| §2.5 | Website statistics (built in plus Google Analytics) and a site health page | deviated-challenge | built under A6 | AV-10, AV-20 | v1 only. GA4 injection and the GA tab are deferred although A1 does not list them, and CLAUDE.md §2 locks 'GA4 secondary, behind consent'. |
| §2.6 | Seven roles, per-role and per-person permissions, View as | deviated-ok | deviation (standard or owner decision) | A2/A4 (binding); CRM-10; AV-21 read-only matrix | 4 roles + Sales. Per-person grants cannot be expressed in RLS (§3 two layers). |
| §2.6 | Invitations, activity log, backups and versions | covered | covered | AV-21, AV-22, R10, R13, AV-24 | 7-day invite expiry and scheduled backups are gaps (rows below). |
| §2.7 | Get connected centre with guided wizards | deferred | later phase (A1) or legal gate | A1 later phase | Consistent with A1. |
| §2.7 | In-app help centre | missing | built (U16) | U16, migration 0046 | A1 defers 'Get connected', not help; TDD §13 groups them. Built with the articles in the DB, as the TDD asks, for built features only; staff read them and the migrations write them until an editor is built (TDD phase 7, a §5 capability). |
| §3.2 | Keep the vanilla SPA; REST API; static regeneration on publish; job-queue workers | deviated-ok | deviation (standard or owner decision) | P-1; CLAUDE.md §2 locked stack | Islands + Tier C SSR + Supabase RLS + Worker cron; purge-by-tag replaces regeneration. |
| §3.2 | save() (operational, immediate) vs dirty() (visitor content, waits for Publish) | covered | covered | P-3, R3 staged kernel, CRM §0 | Slice text contradicts P-3: AV-13 page visibility 'immediate', AV-19 redirects 'immediate', UI §7 media alt/tags 'draft'. Style-Finder is in neither P-3 list. U10: redirects stay immediate (KV, "within a minute of saving") until R3/R12 stage them; the SEO screen's copy says so, and R12/R14 own it at switch-on. |
| §5.1 | buildSeed() becomes a one-time DB seed for a populated staging | covered | covered | scripts/gen-seeds.mjs, seed.sql (staging), seeds/production.sql (drafts) |  |
| §5.2 | Hash router; PERM_ROUTES longest prefix; server enforces the same table | deviated-ok | deviation (standard or owner decision) | AV-03 (server routes, nav/ from ROLE_CAPS, 302 stubs); defineAdminRoute + RLS | Locked stack; lock empty state kept. |
| §5.3 | Bilingual values stored as {en,ar} JSONB, never split into two columns | deviated-ok | deviation (standard or owner decision) | CLAUDE.md §8 bilingual rule; AV-08 bilingual field | Standard: scalar -> _ar column, rich/array -> JSONB (repo is mixed: 0028 uses {en,ar} JSONB). Pairs are still edited together. |
| §5.4 | Field kit (rich bold/em highlight/link, video window {src,start,end,poster}, repeater, sortable, 25-row tables, charts, drawer, modal, toast, mediaPicker) | covered | covered | AV-04, AV-07, AV-08 | Stored HTML -> typed fields + AccentSchema + Tiptap (Pillar 1); window model kept (EXC-009); warn/error toasts become inline (WCAG). **Built (F5b):** the highlight is a word range per language (`accent`), the link a page picked from `GET /api/admin/linkables`, the window a pick from the site clip registry with its length; no markup is stored by any of them. |
| §5.5 | Admin follows the theme live; simple palette from one colour; custom fonts (upload or link) | covered | covered | AV-27 | Google/Adobe links refused (Pillar 2 self-hosted fonts, CSP font-src 'self', PDPL). Uploads need the subset + metric-override pipeline. |
| §6.1 site | Identity: name, tagline, email, phone, WhatsApp, address, favicon, socials with visible flag | covered | covered | AV-18 (site_profile v2), P-3 staged |  |
| §6.1 site | langs, defaultLang, domain, timezone editable | deviated-ok | deviation (standard or owner decision) | AV-18 read-only facts; U9 (0102) | §2 i18n (both twins, x-default EN) and PUBLIC_SITE_URL canonicals: languages and the domain stay read-only facts. U9: the timezone IS editable, from a closed list, in `site_settings.timezone` (immediate; copied from crm_settings.timezone, which is deprecated, C14 drops it): one source, and every admin clock follows it. |
| §6.1 site | logo and logoDark editable | deviated-ok | deviation (standard or owner decision) | AV-18 (owner item 7) | Home LCP element (§6). A bounded slice with an lhci re-gate is possible later. |
| §6.1 site.maint | Maintenance copy {en,ar}, background, contact buttons, 'Back on' auto-off, show date, allowTeam toggle, allowIps | covered | built under A6 (U9b) | src/middleware.ts block 1, src/lib/http/maintenance.ts, src/lib/http/maintenanceBypass.ts, src/lib/maintenance/page.ts; tests/admin/maintenance.e2e.ts | Built, immediate, all in the one KV value with the switch (no DB on the critical path). "The hero image" for "The hero video" (no video bytes on the 503). The bypass is the admin's own session check, fail-closed. |
| §6.1 theme | Colours: simple (opsPalette) and advanced | covered | covered | AV-27 | The contrast gate may adjust generated colours (DoD #4). |
| §6.1 theme | headingWeight, uppercase, radius, buttonStyle | deviated-challenge | built under A6 | AV-32 (later, owner item 9) | Not in A1's later list. |
| §6.1 theme | smoothScroll (Lenis), parallax | deviated-ok | deviation (standard or owner decision) | AV-27 read-only facts | design-port #44/#79; compositor-only animation (§3 Pillar 2). |
| §6.1 theme | reveal, reduceMotion, marquee speed toggles | deviated-challenge | built under A6 | AV-27 (facts only) | These only reduce motion; a site-wide reduce switch would partly answer EXC-007. |
| §6.1 theme | Custom CSS | deviated-ok | deviation (standard or owner decision) | none | §3 CSP / ThemeTokensSchema. |
| §6.1 header | Items order/visible/key, alignment, logo position, logo size, hide on scroll, CTA, mobile menu | covered | covered | AV-28 + MERGE:header-options; P-9 site_appearance |  |
| §6.1 header | Transparency 0-100, blur 0-30, solid after hero, sticky, show language switch | deviated-challenge | built under A6 | AV-28 read-only facts | Bucketed data attributes are CSP-safe. 'Language switch always on' is a product call, not a § rule. |
| §6.1 footer | Copyright, style light/dark, show email, show social, columns of page links | covered | covered | AV-29; P-9 (site_profile) | Copyright template (§1 brand is data) and locked legal links (PDPL) are standard-based. |
| §6.1 loading | Enabled, style, duration, fade, once only | covered | covered | AV-30 | 500-1500 ms follows the prototype's own 'never longer than 1.5 s'. Once per tab = TDD 'once per session' (prototype hint says 'per browser'). |
| §6.1 loading | 'bar' and 'text' styles, tagline, light background | deviated-challenge | built under A6 | AV-30 (not built) | A scaleX bar is compositor-only; the tagline needs an lhci re-gate, not a refusal. |
| §6.1 seo | Per-page title/description/OG/index; default OG; robots | covered | covered | AV-19 (entity_seo list + SeoDrawer, og_media_id), P-3; U10 (0073) | Built by U10. The share image keeps the picture's own aspect at most 1,200 px wide (no 1200x630 crop: the `/_image` guard refuses a height off the asset's aspect, D2). Schema type is a read-only row (JSON-LD types are code-owned and CI-validated, D7). "Check for broken links" is later (L8). |
| §6.1 seo | Sitemap and structured-data toggles; one canonical URL | deviated-ok | deviation (standard or owner decision) | AV-19 read-only rows; U10 | Pillar 3: code-owned sitemap/JSON-LD, per-language canonicals. U10: the Site wide tab's "Built in" rows (SEO_BUILT_IN, one list with Site health); a page's canonical override is a site path localized per language. |
| §6.1 forms | Field labels, visible, required, order, budget ranges, button text | covered | covered | MERGE:forms-config; P-3 | Must make server-side 'required' follow config, purge form-page tags and version any consent copy. P-2 names no publishing area and §5 has no row for it. |
| §6.1 forms | Add custom fields; honeypot toggle | deviated-ok | deviation (standard or owner decision) | MERGE:forms-config (closed field sets) | §8 Zod single boundary; Pillar 1. |
| §6.1 forms | Captcha | missing | added as a slice | none (src/pages/api/contact.ts:65 TODO KAN-20) | Not provisioned. The honeypot and the EXC-004 limiter remain. |
| §6.1 leadSettings | Editable statuses (label, colour), assignment rule, SLA hours | covered | covered | CRM-1, CRM-9 | Fixed tones instead of hex (challenged). TDD 'by-service' is not in the prototype (manual/round-robin/fixed), so the prototype wins. |
| §6.1 leadSettings.notify | Team e-mail/WhatsApp alerts, auto reply, Slack webhook | deferred | later phase (A1) or legal gate | A1 (no outbound); AV-20 bell preferences | Consistent with A1. |
| §6.1 ga/pixels | GA4 id/anonymize/events and Meta/TikTok/Snap pixels injected when set | deviated-challenge | built under A6 | AV-20 stores the GA4 id only | GA4 behind hasConsent is a locked decision; needs a CSP amendment. Pixels belong with ad audiences (A1 later): owner. |
| §6.1 integrations | Email, WhatsApp, Sheets, Slack, HubSpot, inbound, calendar, Meta; setupState; secrets masked | deferred | later phase (A1) or legal gate | A1 later; AV-20 typed GA4/Search Console/Calendly/reCAPTCHA | Secrets never in a staff-readable row (§7) is honoured. |
| §6.2 content/raw | Flat map of 253 bilingual keys + raw values shared with the site | covered | covered | AV-23, AV-25 | Typed section fields replace data-i keys. Add a key inventory test: every seed_home/seed_pages key maps to a field or a documented code-owned exception. |
| §6.2 pages | Section label, visible, order | covered | covered | AV-25 (page_sections.label) |  |
| §6.2 pages | Section background, spacing, reveal, show on mobile, anchor | deviated-challenge | built under A6 | AV-25 (not offered) | Closed variants are CSP-safe; only 'show on mobile' has a Pillar 3 parity argument. |
| §6.2 pages | New pages created from the editor (hero + text block) | deviated-challenge | built under A6 | AV-33 (later, owner item 9) | Not in A1's later list. |
| §6.2 cats/services | Disciplines, services, case, clip windows, SEO | covered | covered | AV-14, AV-19 | Prototype caps value cards at 4 and problems at 5 (repo 6): tighten the admin schema. Case client derived from the project. |
| §6.2 projects | Project record incl. hero, final film, breakdown, gallery, keywords, quote, featured | covered | covered | AV-15 | Inline quote -> linked testimonial with consent (§8 gate); free service tags -> the 28 services. |
| §6.2 collections | Taxonomies, testimonials, clients, team, FAQ, joinWhy/joinSteps | covered | covered | AV-15, AV-16 (faq_items), AV-25 (join items) | Client 'visible' is the disclosure permission (§8). |
| §6.2 collections | Every collection item's "Visible on the site" toggle | deviated-ok | deviation (standard or owner decision) | U7 (as-built/U7.md, D7): FAQ, quotes, team, numbers and certifications use the status lifecycle (Draft, Scheduled, Published, Archived by Admin) | §8: one `content_status` lifecycle, no second visibility flag. Clients keep `visible`, which IS the disclosure permission. For owner approval with the register (O-13). |
| §6.2 media | Image library: upload, search, tags, where-used | covered | covered | AV-11, AV-12, R5 (media_usage v4 incl. drafts) |  |
| §6.2/§8.6 media | Video uploads up to 500 MB with poster frames | deferred | later phase (A1) or legal gate | A5 | Video later with Stream. |
| §8.6 | Signed direct uploads, 25 MB images, variants generated on upload | deviated-ok | deviation (standard or owner decision) | AV-11 | Worker-mediated upload sniffs bytes before storing (Pillar 1); variants via /_image from one WebP master. Capped at 20 MB, the Images binding's input limit (B7 item 2; built in U3), not 25 MB. |
| §17 | Image re-encoding on upload | missing | added as a slice | none (AV-11 stores originals) | Built in U3: the IMAGES binding writes one WebP master at a 2,560 px long edge and only it is stored, so EXIF/GPS never reach the public bucket (a WebP metadata strip is the belt). |
| §6.3 leads | Lead record with assigned, value, score, starred, read, notes, timeline, contactId | covered | covered | CRM-1-CRM-4 |  |
| §6.3 leads | page, utm, device, country, city captured on each lead | deviated-ok | deviation (standard or owner decision) | CRM-13 (legal + consent gated) | PDPL + hasConsent basis; landing_path server-derived; city never stored (minimisation, O4). |
| §6.3 crm.contacts | Contacts with stage, tags, owner, custom fields, star, last activity | covered | covered | CRM-5-CRM-7, CRM-9 | Contact stages fixed: the prototype says 'Fixed', so the TDD's 'editable' loses. |
| §6.3 crm.contacts | Consent flags with timestamp, unsubscribed | deferred | later phase (A1) or legal gate | A1; CRM §12 consent events | No channel sends now. |
| §6.3 crm.companies | Companies | covered | covered | CRM-11 |  |
| §6.3 crm.tasks | Tasks (call/email/whatsapp/meeting/todo) | covered | covered | CRM-8 |  |
| §6.3 messaging | Conversations, templates, segments, campaigns, automations, exports log, messaging and automation settings | deferred | later phase (A1) or legal gate | A1 | Consistent with A1. |
| §6.4 users | People list with email, last seen, active | covered | covered | AV-21 |  |
| §6.4 users | TOTP 2FA, require 2FA, reset 2FA | deviated-challenge | built under A6 | U17 (0072, `/admin/2fa`) | Built (U17): TOTP set up from the account on a zero-JS page (key and `otpauth://` link, no QR yet), enforced in two layers (the token hook at the required `aal`, `resolveAuthContext`'s second step), Require 2FA for everyone on Users › Security, Reset 2FA (Admin, one definer transaction). No recovery codes (Supabase Auth has none); residuals under O-25 below. |
| §6.4/§7 invites | Invitation links that expire in 7 days | missing | added as a slice | AV-21 (inviteUserByEmail resend/cancel) | Supabase invite links follow the global Email OTP expiry (default 1 h; more than one day is discouraged and Management-API only). |
| §6.4 | rolePerms, userPerms, session.viewRole | deviated-ok | deviation (standard or owner decision) | A2/A4 | Binding. |
| §6.4 dash | Per-person layout and quick actions | covered | covered | AV-05 (admin_user_prefs), AV-09 |  |
| §15 | Quick actions can be pre-set per role by the owner | missing | added as a slice | AV-09 (per-role default layouts only) | TDD-only: the prototype has one global QUICK_DEFAULT (screens_cms.js:162). |
| §6.4 activity | Append-only, kept 12 months | deviated-ok | deviation (standard or owner decision) | audit_log; AV-22 | CLAUDE.md §3/§7: no DELETE, exempt from retention (the prototype says 90 days, screens_ops.js:1094). |
| §6.4 versions | One version per publish storing the full content snapshot for Restore | deviated-challenge | built under A6 | R1, R4, R10 | Row-level capture + as-of computation. Out-of-band writes are neither guarded nor captured, which breaks Restore (see missed details). |
| §6.4 notifications | In-app bell with read state | covered | covered | AV-05 | Derived feed; read state is one watermark, not per item. |
| §6.4/§15 backups | Daily automatic (keep 30), manual, downloadable, restorable | deviated-challenge | built under A6 | AV-24/R13 export-backup; DR runbook (§10) | No leads in admin backups (§7) is standard; scheduled content snapshots are not barred. |
| §7 | Every endpoint declares its permission; 403 server-side | covered | covered | defineAdminRoute/assertCap + RLS; endpoints.spec over all roles incl. sales, other_tenant |  |
| §7 | An owner cannot be downgraded by an admin | missing | built (U12a) | U12a, migration 0055 | `profiles.is_owner` (one per tenant, set by the runbook, never claimable): nobody demotes, deactivates, moves or deletes the owner (`app.tg_profiles_owner_guard`, the users PATCH's 422 first); ownership moves only by the owner's own action (`public.transfer_ownership`, audited). No new role. |
| §7 | Email + password, session cookie, login rate limiting | covered | covered | existing lockout (5/15 min -> 423), AV-06 | The lockout is the Worker's, the password change's re-authentication included (F8); Supabase Auth's own endpoints are the residual risk above (O-24). |
| §7 | Sales = leads + stats | deviated-challenge | built under A6 | CRM-10 (no analytics.read) | §5 gives analytics.read to every current role; aggregates carry no PII. |
| §8.1 | Three-column editor; drag reorder, eye, rename, remove, add section | covered | covered | AV-25 | Remove is Admin-only (§5 archive/delete). |
| §8.1 | SECTION_LIBRARY generic blocks (text, gallery, video, CTA, custom HTML) | deviated-challenge | built under A6 | AV-25 typed types; AV-33 textBlock | Refusing Custom HTML (Pillar 1) is right; Gallery/Video/Text are ordinary typed types. |
| §8.1 | Preview updates at once while typing | deviated-ok | deviation (standard or owner decision) | P-4; R9; AV-26 | Binding. |
| §8.1 | Template pages: 'Showing' picker + the record's own content | covered | covered | AV-31 |  |
| §8.1 | Template 'Shared text' (v.*, p.*) editable | deviated-challenge | built under A6 | AV-31 (read-only) | Labels are code today, not by rule. |
| §8.2 | public / hidden (404, leaves menu) / link only; homepage cannot be hidden; per-item visible | covered | covered | AV-13 + MERGE:link-only; P-2/P-3 | AV-13 says immediate but P-3 stages it: the visibility KV snapshot must be re-synced after apply and rollback (R7 syncs redirects only). |
| §8.2 | Password gate, redirect to another page, hide-from/until dates, template-wide hide | deviated-challenge | built under A6 | none (AV-13: 404 or home only) | All feasible pre-cache in the Worker (see challenges). |
| §8.2 | Maintenance for all visitors except signed-in team and allowed IPs; 503 + Retry-After | covered | covered | src/middleware.ts block 1, src/lib/http/maintenance.ts, src/lib/http/maintenanceBypass.ts (U9b); tests/lib/middlewareMaintenance.spec.ts, tests/admin/maintenance.e2e.ts | Immediate kill switch vs the prototype's 'after you publish' is a Pillar 1 call. Retry-After counts down to "Back on". |
| §8.3 | Publish copies draft to live, bumps the version, refreshes site output | covered | covered | R4, R6, R7 | Purge by tag, never a rebuild (§2). |
| §8.3 | Unsaved bar; Discard restores the draft from live | covered | covered | R3 draft endpoints, R12, AV-24 | Scopes: one / mine / chosen. AV-24 copy ('everything since the last publish') must match R12. |
| §8.3 | Page History restores one page's keys from a snapshot | deviated-challenge | built under A6 | R10 (per entity + site-level) | A page is a page row plus its sections; needs a page-scoped restore. |
| §8.4 | Static regeneration (option A) or runtime fetch (option B) | deviated-ok | deviation (standard or owner decision) | §2 Tier A + purge (R7) |  |
| §8.4 | Site renders theme, header, footer, loading, maintenance, visibility, SEO tags, forms | covered | covered | AV-13, AV-19, AV-27-AV-30, MERGE:forms-config |  |
| §8.4 | Site renders pixels and GA | deviated-challenge | built under A6 | none | See the GA4/pixels row. |
| §8.5 | Services/projects screens and tabs; reordering renumbers; featured pickers | covered | covered | AV-14, AV-15 | The number pill derives from disciplines.sort_order. |
| §8.6 | Library, picker in every image field, where-used before delete | covered | covered | AV-12, R5 |  |
| §9 | postMessage bridge (text/texts/lang/show/order/jump/item), ready handshake, origin checks, draft rendering | deviated-ok | deviation (standard or owner decision) | R8, R9, AV-26 (P-4) | Reload + jump/highlight/tokens instead of text patching; bridge only on /admin/preview (Pillar 1/2). R9 and AV-26 name different bridge and envelope files: keep one. |
| §10 | Theme fields mapped to the site's CSS variables | covered | covered | AV-27 (colours, theme.css); AV-32 shapes/type later |  |
| §10 | Header, footer, loading settings rendered on the site, with previews | covered | covered | AV-28-AV-30 | Real iframe preview instead of mock previews. |
| §11.1 | Form endpoints validate against config, honeypot, captcha, IP rate limit | covered | covered | /api/contact, /api/apply, EXC-004 limiter, MERGE:forms-config | Captcha missing (KAN-20). |
| §11.1 | Create lead (first status, score), find/create contact, assign, in-app notification, SLA clock | covered | covered | CRM-1, CRM-5, CRM-9, CRM-4, AV-05 |  |
| §11.1 | Find or create the company on submit | missing | added as a slice | CRM-11 (manual only) |  |
| §11.1 | Record consent with timestamp | covered | covered | leads.consent_marketing (consent to reply) | Store the consent copy version once Forms config makes it editable (PDPL). |
| §11.1 | Team notification, auto reply, inbox conversation, form_sent trigger | deferred | later phase (A1) or legal gate | A1 |  |
| §11.2 | Leads list (filters, bulk, export), board (drag), detail; moves logged | covered | covered | CRM-2-CRM-4 | No budget column, server-only export, no bulk delete (§3/§7); keyboard Move to. |
| §11.2 | Convert to contact; open conversation | covered | covered | CRM-5 auto-link; inbox A1 |  |
| §11.2 | Lead scoring recomputed on every event | covered | covered | CRM-1, CRM-9 | Closed signals = what the prototype actually evaluates (cxScoreWhy); behavioural signals come later. |
| §12.1 | Inbox and the WhatsApp 24-hour rule | deferred | later phase (A1) or legal gate | A1 |  |
| §12.2 | Contacts/companies, search, merge, bulk tag, detail, custom fields, timeline, star | covered | covered | CRM-5-CRM-7, CRM-11, CRM-12 |  |
| §12.2 | Import CSV with column mapping and duplicate detection | deviated-challenge | built under A6 | CRM §12 hook (owner O12) | Not in A1's later list. |
| §12.2 | Match on e-mail, then phone normalised to E.164 | deviated-challenge | built under A6 | CRM-5 (phones go to the merge finder) | A data-quality call, not a standard rule. |
| §12.2 | Consent toggles, unsubscribe, contact export | deferred | later phase (A1) or legal gate | A1 |  |
| §12.2 (prototype) | Contact Files card | deviated-challenge | built under A6 | none (CRM deviation 15) | The private-bucket + audited-download pattern already exists (applications). |
| §12.3-§12.7 | Templates, campaigns, automations, global rules, reports, exports, audiences, consent log | deferred | later phase (A1) or legal gate | A1 |  |
| §13 | Get connected list, wizards, banners, dashboard setup note | deferred | later phase (A1) or legal gate | A1 |  |
| §13 | Help centre: ? button, search, guides, per-screen Guide, articles editable in the DB | missing | built (U16), editing deferred | U16, migration 0046 | See §2.7. The per-screen Guide is a code map held to the seeded set by a test, so a render reads nothing (P-15); editing waits for phase 7. |
| §14 | First-party beacon with no cookies | deviated-ok | deviation (standard or owner decision) | /api/analytics (hasConsent) | §2/§7 consent-gated; the 'no cookie banner' copy is corrected. |
| §14 | Events, funnel, goals, realtime, sessions | covered | built (G1, 0071) | AV-10 (later) | On consented first-party data: visits per tab and UTC day, clicks and explorer interest, a three-step funnel, busiest hours in Riyadh time, goals (Admin and SEO, §5 `analytics.goals`), realtime from a 1-minute rollup (Pillar 4). See Stats above for what stays out. |
| §14 | Sources, countries, devices, browsers, unique visitors, cities | deviated-ok | deviation (standard or owner decision) | AV-10 (later) | Consent-gated capture + notice change (PDPL, O4); a persistent visitor id needs legal; cities never. |
| §14 | GA4 numbers via the Data API (/stats/ga) | deviated-challenge | built under A6 | none |  |
| §14 | 10-minute health worker (uptime, TTFB, weight, errors, broken links, SSL/domain, headers, SEO, synthetic form, backup, storage), score, alerts | deviated-challenge | built under A6 | AV-10 v1; G2 (0067) | Vitals, errors, checklist, security, SEO, backup, storage (U2); uptime, domain and certificate built (G2): the monitor's read-only API every 10 minutes, the domain's RDAP record about daily, the certificate where the monitor reports it, failures in the bell. No broken-link crawl (L8), no lab weight, no alert channels (A1). |
| §14 | Health visible to every 'stats' role | deviated-ok | deviation (standard or owner decision) | AV-10 (siteHealth.view) | §5: Admin + Developer. |
| §15 | Twelve widgets, per-user layout, Customize across three columns | covered | covered | AV-09 | Team notes built in U1; Right now (realtime) built in G1b, off the board by default as the prototype's DASH_DEFAULT, figures as of the page's load (the stats' Realtime tab keeps them current). |
| §15 | Users: invite with role, deactivate, reset 2FA, editable matrix, personal access | covered | covered | AV-21, U17 | Read-only matrix and no personal access (binding); reset 2FA built (U17: never yourself or the account owner). |
| §15 | Activity log filterable by person, action and date; exportable | covered | covered | AV-22, U13 (kind chips, person, Riyadh days; CSV under the export lockdown) | No free-text search (U13 D1): the sentences are composed in code. The file names items by type and id, not title (D5). |
| §15 | Publish versions list with restore | covered | covered | R10, R13, AV-24 |  |
| §16 | REST/JSON, session cookie, CSRF on writes, per-route permission | covered | covered | defineAdminRoute, __Host-csrf, assertCap | /state bootstrap and /site/*.json are not needed (SSR, P-1). |
| §16 | /auth/2fa and /auth/invite/:token | covered | added as a slice | U17 `/admin/2fa`, U12b `/admin/invite` | Under `/admin`, not `/auth` (the admin's path rules, CSP and pre-auth list). Invite links last one hour with Resend (O-22). |
| §16 | Workers: rollups, backups, health checks, link crawl, senders, sheets sync | covered | covered | existing pg_cron rollups + AV-10 rollup_vitals; R7/R11 minute cron; §10 DR | Senders/sheets are A1; health from the external monitor; a crawl does not fit the free plan's 10 ms cron CPU. |
| §17 | Phases 1-3: foundation, CMS live, leads | covered | covered | R0-R16, AV-01-AV-31, CRM-1-CRM-14 | Phase-3 notifications/auto reply/inbox threads (A1) and import (O12) excluded. |
| §17 | Phases 4-7: email, WhatsApp, automations, growth | deferred | later phase (A1) or legal gate | A1 (4-6); phase 7 partly outside A1 | GA4, Search Console, beacon enrichment, health worker and editable help need owner confirmation. |
| §17 | Security basics (HTTPS, HttpOnly, CSRF, permission checks, rate limits, upload validation, masked secrets, audit, off-site backups, consent log, export audit, deletion on request) | covered | covered | existing standard + AV-11, CRM-3/CRM-5 | Image re-encoding built in U3; the marketing consent log is deferred (A1). |
| §17 | Admin English; content EN+AR; Almarai + dir=rtl on AR editors | covered | covered | AV-02, AV-08, UI §1.5 |  |
| §17 | Eastern Arabic digits in content are never transformed | missing | added as a slice | none | No design states it and no test guards it. |
| §19 | Prototype shortcuts replaced (secrets, uploads, role checks, stats, login, placeholders) | covered | covered | AV-06, AV-11, AV-20, RLS + assertCap, rollups, 0025/0027/0028 guards | Placeholders: the replace-and-clear flow; production refuses live samples unless the owner override (runbook §6c). |

## The client's acceptance scripts

How each script in the handoff's `src/tests` maps onto this build. README's
"Verification (end to end)" holds the TDD §18 acceptance list.

| Acceptance script item | Design slices | Passes as designed | What replaces it |
|---|---|---|---|
| adfull.mjs: every route for every role, zero page/console errors, no horizontal overflow, sidebar per role, state survives reload (plus editor live text, hide/reorder/add section, AR switch, mobile preview, publish, palette, notifications, View as, demo-chip login, file://) | R0/AV-01 (P-8), AV-03, AV-04, AV-05, AV-25, AV-26, R9, R12, AV-34, CRM-10 | partly | Per-role storageState sessions replace the View-as select and the demo chips (A2/A4, AV-06). Run on staging over https, not file://. 'State survives reload' becomes 'server drafts survive reload' (R3). Preview assertions wait for the post-autosave reload (about 1-2 s, P-4). 'Add section' picks an allowed typed type. Add zero console errors and scrollWidth <= clientWidth + 2 per admin route and role to the harness: AV-34 only plans axe and screenshots. |
| crmall.mjs: inbox reply and template, contact merge and import, campaign wizard, automation builder, export with consent counts; lead-to-contact link; role nav; palette finds a contact and a campaign | CRM-4, CRM-7, CRM-10, CRM-12 | partly | A core-only script: leads list/board/detail, lead -> contact link, contact merge, tasks, Sales nav = Dashboard/Leads/Contacts/Tasks. Inbox, template, campaign, automation, export and import go to the later-phase acceptance. The marketer/account roles do not exist (A2). Palette contact search passes only if the ⌘K challenge is accepted. |
| su.mjs: DNS verify, email connected, WhatsApp wizard, banners disappear, help centre search, automation rules, run log, editor cannot see setup | none (A1 later); help centre unassigned | no | Later-phase acceptance. Now: 'Content Creator sees no Integrations/Users/General nav and gets 403 by URL' (adminSecurity.spec + endpoints.spec). Help-centre search: tests/admin/help.e2e.ts (U16). |
| tpl2.mjs / pvchk.mjs / filechk.mjs: template page editor and live preview over http and from disk | AV-31, AV-26, R8, R9 | partly | https on staging only: an authenticated SSR admin cannot run from disk. The edit must appear in /admin/preview after the autosave reload (about 1-2 s), not after 400 ms. Switching the 'Showing' item reloads /admin/preview/services/<slug> or /portfolio/<slug>. |
| sitechk.mjs / allsite.mjs: every site page loads clean, with the preview hook present | R9 preview-isolation + existing e2e/lhci | partly | Inverted on purpose: public pages must load clean (no console errors or overflow, EN+AR) and must NOT reference the bridge. The /admin/preview route must carry it (preview-isolation.e2e). |
| A real form submission appears as a lead within 5 seconds, with notifications delivered | CRM-1 (crm_ingest_lead), CRM-4, AV-05, existing notify-lead | partly | The lead shows in /admin/leads within 5 s and in the bell count on the next render; a notification_log row is written ('queued'). No e-mail or WhatsApp delivery under A1 (CLAUDE.md §10: notify-lead sends nothing yet). |
| An edit to the homepage headline is visible on the public site after Publish and not before | AV-25, R3, R6, R12, R14 switch-on | yes | Point releases-publish.e2e at the homepage headline literally. Valid only after app.enable_releases (flag on); before R14, a save goes live at once. |
| A hidden page returns 404 and leaves the menu | AV-13 (staged per P-3, published under maintenance.manage per P-2), MERGE:link-only | yes | Under P-3 the hide takes effect when published. Also assert sitemap/llms exclusion and the visibility KV re-sync after the release and after a rollback. |
| Maintenance returns 503 to visitors and lets a signed-in admin through | src/middleware.ts + src/lib/http/maintenance.ts (503, Retry-After) + src/lib/http/maintenanceBypass.ts (U9b) | yes | Built (U9b): tests/admin/maintenance.e2e.ts: anon gets 503 with Retry-After and no-store in both languages; the admin's session gets the public page, private; an altered token gets the 503 (fail closed); the bypass off refuses the admin too; the IP allowlist keeps working. |
| An email campaign to a test segment delivers with a working unsubscribe | none (A1 later) | no | Moves to the later-phase acceptance; nothing replaces it now. |
| A WhatsApp reply outside 24 hours is blocked without a template and allowed with one | none (A1 later) | no | Moves to the later-phase acceptance. |
| An automation with a 3-day wait sends on time in Asia/Riyadh | none (A1 later) | no | Time-zone proxies now: a scheduled release fires on time in Riyadh time (R11 releases-schedule.e2e), and task Today/Overdue grouping follows the Riyadh day boundary (CRM-8). The real check moves to the later phase. |
| A sales user cannot open /settings/users by URL or by API | CRM-10 (crm-roles.e2e, endpoints.spec), AV-21, AV-03 lock state | yes | The route is /admin/users. Assert the server-rendered lock page, a 403 from /api/admin/users, and 0 rows through PostgREST. |
| A backup restores a deleted project | R10 (Restore vN re-creates deleted entities with portfolio children), R4 capture; DR runbook (§10) | partly | There is no backup-restore button (§7/§10). New acceptance: delete a project in release N, Restore v(N-1), preview, publish -> the project and its portfolio_services/portfolio_media return with the same id. A full-database restore is proven by the quarterly DR drill. |

## Per-design lists

Each design ends with its own "Deviations from the prototype" list, written before the
program decisions: [ui.md](ui.md), [releases.md](releases.md), [crm.md](crm.md). Where one of
them disagrees with the register above, the register wins.
