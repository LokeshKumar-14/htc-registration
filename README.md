# HTC Club Event Registration

The mobile-first registration site is in `index.html`, `styles.css`, and `src/`. Event registrations are sent to the configured Google Apps Script web app. Students enter a team name and college name before choosing event participants; the college name is included with each registration.

Gully Cricket is free and does not require a payment, screenshot, or screenshot upload. Event contact numbers with direct call links are shown on each event page. After registration, students can open the matching WhatsApp group from the completion page.

The frontend posts JSON using `Content-Type: text/plain;charset=UTF-8` to avoid cross-origin preflight requests to Apps Script while still allowing the browser to read its response. It does not use `no-cors` or treat an opaque response as success.

## Current integration files

- `src/config.js` — Apps Script URL, event contacts, and WhatsApp group links.
- `src/apps-script-api.js` — request serialization, event/schema mapping, and timeout handling.
- `src/app.js` — registration form, event selection, direct-call links, and completion page.
- `apps-script/DriveUpload.gs` — optional legacy Drive screenshot-upload helper; normal registrations do not use it.
- `worker/` — legacy Cloudflare workbook implementation. The public registration form posts directly to Apps Script, not to this Worker.

## Apps Script integration

The complete Apps Script registration source is in `apps-script/Code.gs`. It requires and saves `collegeName`, accepts Cricket registrations without payment or screenshot fields, and appends the college header to existing sheets without rewriting their existing data. `apps-script/DriveUpload.gs` must also be present in the Apps Script project because `doPost` dispatches its optional legacy upload handler.

The Apps Script registration handler must accept and persist `collegeName` in addition to the existing registration fields. It must not require `paymentAmount` or `screenshotReference` for Cricket. The frontend sends event keys `cricket`, `football`, `cyclothon`, and `treasurehunt`; participant fields are `rollNumber`, `name`, `phone`, `branch`, and `year`. Treasure Hunt also sends `girlEligibilityConfirmed`. Year values are `1st`, `2nd`, and `3rd`.

`apps-script/DriveUpload.gs` may remain deployed for compatibility with old screenshot uploads. Its dispatch function returns `null` for normal registrations and no longer checks payment or screenshot fields. Adding or deploying this optional helper is not required for free Cricket registrations.

If the Apps Script source needs changes, update its existing validator and row writer to save the college name without replacing the existing `doPost`, registration, or idempotency logic with guessed implementations. When deploying, test against a copy of the spreadsheet first, then publish a new web app version while retaining the existing deployment URL.

## Frontend behavior and deployment

The registration draft, including the college name, is saved in the browser. The registration ID and request payload are retained if the response is uncertain, and the site reports success only after receiving an explicit positive response from Apps Script.

Deploy the Apps Script web app with the script owner as the executor. Keep the spreadsheet private and grant access directly to organizers who need it. Do not place credentials or shared secrets in frontend code. Anonymous endpoints can consume Apps Script quotas, so monitor usage and use the existing backend validation and idempotency safeguards.

## Checks before launch

1. Confirm the four event tabs are `Cricket`, `Football`, `Cyclothon`, and `Treasure Hunt`.
2. Confirm `collegeName` is saved with each event registration.
3. Confirm Cricket accepts a five-person team without payment or screenshot fields.
4. Confirm team sizes, participant details, and Treasure Hunt eligibility are validated.
5. Confirm repeating a registration with the same ID does not append duplicate rows.
6. Verify the WhatsApp links and call buttons from the deployed site.
7. Test the deployed site from its actual origin using a test spreadsheet/deployment before accepting live registrations.

Run the Worker tests from `worker/` with `npm test`.
