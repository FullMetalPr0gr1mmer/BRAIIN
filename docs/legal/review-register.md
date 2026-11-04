# Legal review register

Open legal questions for the client's Saudi-licensed lawyer, collected while building. Nothing
here is legal advice or a compliance sign-off. An item is `open` until the lawyer answers it; the
answer is recorded with who gave it and when, then the item becomes `answered`, and `implemented`
once the code follows it. Go-live waits until every HIGH item is answered. No personal data:
each row describes what the code does, not real people.

| ID | Date | Area | What the code does | Question for the lawyer | Severity | Status | Answer (who, when) |
|----|------|------|--------------------|-------------------------|----------|--------|--------------------|
| L-1 | 2026-11-04 | Content and IP: fonts | The public site and the admin self-host two font families under the SIL Open Font License 1.1, Archivo and Almarai, as files trimmed to the characters the site uses (`public/fonts/*.woff2`). Each file carries the family's copyright notice and the licence's web address in its metadata (name records 0 and 14), not the licence text. Admin v2 E13's font catalogue records each family's licence and notice (`packages/theme/fonts.ts`), and further families wait for owner item O-21 (the families, with their web licences). | (1) Does serving trimmed copies with the licence's address in the file metadata, without the licence text alongside, meet the licence's notice condition, or should the licence text be published with them (for example at `/fonts/`)? (2) Does either family reserve its name, so that a trimmed copy may not carry the original family name? (3) What check must a new family pass before it joins the catalogue (its licence allowing web self-hosting and trimming, attribution, any reserved name)? | LOW | open | |
