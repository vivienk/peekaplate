# Owner authentication emails

These editable HTML files are the approved Supabase Auth email templates.
They are applied in the provider dashboard, not served as console routes or
automatically deployed by Vite.

| Supabase template | HTML source | Subject |
| --- | --- | --- |
| Confirm sign up | [confirm-signup.html](confirm-signup.html) | Confirm your PeekaPlate email |
| Reset password | [reset-password.html](reset-password.html) | Reset your PeekaPlate password |

## Apply an update

1. An authorized administrator opens the existing staging project's
   Authentication > Emails. Save the current subject and source privately first.
2. In the matching template, replace the complete Source with its HTML and set
   the subject above. Copy the editor text back out and compare it with the file
   before saving; replacing only the visible editor lines is insufficient.
3. Save, reopen and verify the persisted source, then inspect Preview.
4. Send fresh test emails through the actual application. Check the received
   subject, sender, logo, primary/fallback links, callback and one-time reuse.

Both action links must retain `{{ .ConfirmationURL }}`; Supabase supplies their
purpose, credential and approved redirect. The footer's `{{ .SiteURL }}` is only
the website link. Do not replace action links with fixed console routes or a
homepage. Do not change SMTP credentials, confirmation policy or redirect rules
as part of a wording update.

Edit headings, body, preheader, button label, notes and inline brand colours in
these files. The real logo uses an existing public HTTPS PNG pinned to its Git
revision; its downloaded bytes matched the original. No new hosting resource
was created. If moving it later, verify the replacement URL and test an actual
email. The text wordmark remains readable with images blocked. Templates have
no scripts, external fonts or tracking pixels.

## Applied and checked - November 11, 2026

Both subjects and bodies are saved in staging Supabase after administrator access
was granted. Signup source was reopened and compared with its approved file;
the recovery template rendered correctly and produced the delivered email.
Real local-app recovery delivery in Gmail, sender/subject/body, loaded logo,
matching button/fallback links, expected project/purpose/local callback, verified
reset form and consumed-link rejection passed. No password was submitted.

Fresh-signup confirmation delivery, unconfirmed denial, actual password update,
old/new password sign-in, Outlook/mobile-client rendering and the complete hosted
owner/dashboard journey remain NOT RUN. Browser/Supabase previews do not replace
those checks. Keep PR143 and stacked PR146 unmerged until owner-flow acceptance.
