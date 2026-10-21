# HTC Club Event Registration

The existing mobile-first static site is in `index.html`, `styles.css`, and `src/`. Event registration now posts to the supplied Google Apps Script web app. Cricket screenshots are sent to an Apps Script Drive-upload action and stored in a private Google Drive folder; the resulting Drive file ID is sent with the registration and saved by the existing sheet writer.

The frontend sends JSON using `Content-Type: text/plain;charset=UTF-8`. This avoids the browser preflight that blocks cross-origin `application/json` requests to Apps Script while still allowing the browser to read the redirected JSON response. It does **not** use `no-cors` or treat an opaque response as success.

## Current integration files

- `src/config.js` — Apps Script deployment URL.
- `src/apps-script-api.js` — request serialization, event/schema mapping, timeout handling, and screenshot validation/upload.
- `src/app.js` — preserves the current event and progress UI while requiring an explicit backend confirmation.
- `apps-script/DriveUpload.gs` — Apps Script Drive upload helper to add to the existing script project.

The previous `worker/` Cloudflare workbook implementation remains in the repository, but the public registration form no longer uses it. It does not proxy or store the Google Sheets registrations.

## Required Apps Script source change

The deployed Apps Script source (`Code.gs`) is **not included in this website workspace**, so its existing validation, exact sheet headers, and idempotency implementation could not be inspected or edited here. Do not replace the existing `doPost`, `validateRequest_`, `validateParticipant_`, `registrationExists_`, `createRows_`, or `setupSheets` implementations with guessed versions.

1. Open the Apps Script project that owns the configured deployment.
2. Add the contents of `apps-script/DriveUpload.gs` as a new script file.
3. Insert these exact lines at the beginning of the existing `doPost(e)`, before its current JSON parsing, `validateRequest_()`, or participant validation. Do not replace the existing function or its registration body:

   ```javascript
   var uploadResponse = handleDriveScreenshotUploadRequest_(e);
   if (uploadResponse !== null) return uploadResponse;
   ```

   For example, preserve the existing code after these new lines:

   ```javascript
   function doPost(e) {
     var uploadResponse = handleDriveScreenshotUploadRequest_(e);
     if (uploadResponse !== null) return uploadResponse;

     // Existing code starts here. Keep your actual statements unchanged:
     var data = JSON.parse(e.postData.contents);
     validateRequest_(data);
     // Existing idempotency and registration logic follows unchanged.
   }
   ```

   The comment marks the insertion location only; retain your real current lines instead of copying invented registration logic. The handler function name is exactly `handleDriveScreenshotUploadRequest_`, matching the function declared in `DriveUpload.gs`. It recognizes `action: "uploadScreenshot"` and returns the Drive JSON response before registration validation, so an upload does not need a `participants` array. Normal registrations return `null` from this dispatch check and continue through the unchanged existing validation/idempotency/row-writing code. Cricket registrations also pass through checks that the payment is ₹50 and the screenshot reference belongs to a private upload for that registration ID.
4. Confirm that the existing registration validator accepts these event keys and field names: `cricket`, `football`, `cyclothon`, `treasurehunt`; participant fields `rollNumber`, `name`, `phone`, `branch`, `year`; Cricket fields `paymentAmount` and `screenshotReference`; Treasure Hunt field `girlEligibilityConfirmed`. The frontend sends year values as `1st`, `2nd`, and `3rd`.
5. Confirm the existing row writer stores the Cricket `screenshotReference` in the existing “Screenshot Reference” column and uses “Pending Verification” as the initial payment status. The upload helper returns a private Drive **file ID**, never a public URL or browser object URL. At registration time the helper verifies that the reference belongs to the private screenshot folder and its filename/metadata are tied to that registration ID; it also checks the Cricket amount is exactly ₹50 before allowing the existing writer to run.
6. In Apps Script project settings, use the V8 runtime. Run `getPrivatePaymentFolder_` once from the editor, review and grant the requested Google Drive authorization. In **Deploy → Manage deployments**, edit the web app deployment, select **New version**, keep the existing deployment URL, and deploy. Grant the script owner Drive access when prompted. Test the new deployment URL before republishing.

If your real `doPost` shape or request fields differ from the details in the supplied specification, reconcile that with the actual Code.gs before deployment. Since that file was not available here, preserving its hidden sheet headers and exact server validation cannot be verified from this workspace.

## Apps Script deployment permissions

Deploy as a web app with:

- **Execute as:** the script owner (so the script writes to the owner’s spreadsheet and Drive).
- **Who has access:** Anyone, if anonymous student registration is intended.

Keep the spreadsheet private. The script creates/reuses `HTC Registrations/Cricket Payment Screenshots` in the owner’s Drive and explicitly sets each folder and new file to private access. Do not add “anyone with the link” sharing. Organizers who need access should be granted access directly by the Drive owner.

An anonymous Apps Script endpoint can be abused to consume the owner’s execution and Drive quotas. The upload handler enforces a 5 MiB image limit, verifies supported image signatures, validates UUID references, and uses a stable upload ID so an uncertain retry does not create another file. Apps Script does not provide the visitor’s IP to `doPost`; these checks are not a full rate-limiting or anti-bot system. Monitor Apps Script/Drive quotas and the registration sheet. Do not put a supposed shared secret in frontend JavaScript.

## Frontend behavior and request limits

`src/config.js` contains the supplied Apps Script URL as `APPS_SCRIPT_URL`. No spreadsheet credentials, Drive credentials, OAuth secrets, or service-account keys are sent to the browser.

The registration code canonicalizes the event key immediately before sending, including drafts saved by an older frontend version that may still contain display labels such as `Cricket`, `Gully Football`, or `Treasure Hunt`. The screenshot upload action separately sends `event: "cricket"` as well as `action: "uploadScreenshot"`.

### Event-key incident diagnosis

The former screenshot-upload request sent `action: "uploadScreenshot"` but omitted `event`. A safe POST probe to the deployed endpoint reproduced the exact response `Invalid event.` for that shape. Sending the same non-persisting probe with `event: "cricket"` advanced to `Select at least one participant.`, confirming the event-key check then passes. That second response also shows the deployed `doPost` is currently treating the upload action as a registration request instead of dispatching it to a screenshot handler.

The frontend fix now supplies `event: "cricket"` on the upload request, and canonicalizes any cached registration payload before retry. To make the upload actually store a screenshot, add and deploy the `handleDriveScreenshotUploadRequest_` hook described below. The current upload handler behavior has only been probed with invalid payloads; no file was uploaded. Do not bypass the backend participant check by adding participant data to the upload request.

The browser checks file extension, MIME type, and a 5 MiB limit before upload. The Apps Script helper checks the decoded byte count and JPG/PNG/WebP file signatures again. Base64 expands the maximum 5 MiB image to about 6.67 MiB (plus small JSON fields). This keeps uploads small, but the full-size upload must still be tested against the owner’s actual Apps Script deployment and quotas. `fetch` does not expose upload-byte progress; the page shows an indeterminate uploading state instead.

The registration ID is generated once and stored with the draft. The same ID and payload are reused after a timeout or uncertain result. Cricket’s separate upload ID and image SHA-256 are also reused after an uncertain upload; the server detects a mismatched image and requests a new upload ID rather than returning a reference to the wrong screenshot. If the screenshot has already uploaded but registration did not receive confirmation, the draft keeps its returned Drive file ID and retries registration without uploading the screenshot again. Replacing an already uploaded screenshot can leave the prior private file unused in Drive; organizers should periodically remove abandoned screenshots. Draft data is not cleared before the backend returns a confirmed `success`, `saved`, or `alreadySaved` response.

The public Apps Script GET health endpoint and an invalid, non-persisting POST were tested from a browser page on `http://127.0.0.1:8000`: GET followed the Google redirect and returned readable JSON; `application/json` POST failed CORS preflight; `text/plain` POST followed the redirect and returned readable JSON. No real registration or valid image was submitted during that test. The production GitHub Pages origin and a full-size Drive upload still need manual verification.

## Google Sheets and Drive checks before launch

Use the existing spreadsheet ID `10JIrqL-B8Jpg45CbRoffnIqRNjoqD8JqKvyuSov6vvQ`, and ensure the script uses exactly the existing tabs `Cricket`, `Football`, `Cyclothon`, and `Treasure Hunt`. Do not run `setupSheets()` against an existing workbook until you have confirmed that it preserves the live headers and rows.

Before accepting registrations, verify:

1. Existing sheet headers match the existing `createRows_` implementation.
2. Repeating a registration request with the same registration ID does not append duplicate participant rows.
3. An invalid event, invalid participant count, or invalid phone number is rejected by the backend.
4. A Cricket team must have five participants, ₹50, and a real private Drive file reference.
5. Treasure Hunt must have four participants and `girlEligibilityConfirmed: true`.
6. A Cyclothon request stores individual participant rows without a team name.
7. Uploaded files appear under the intended Drive folders and remain private.
8. The payment status remains “Pending Verification” until an administrator changes it.
9. A registration response lost after persistence can be safely retried with the same ID.
10. The deployed web app works from the actual GitHub Pages origin.

The frontend does not claim success until Apps Script returns a readable positive JSON response. If fetch times out, is blocked, or returns unreadable content, it reports an uncertain result and keeps the form and ID for retry. Do not test a valid registration against the live spreadsheet unless you intend to create a real registration; use a test copy of the spreadsheet/deployment for end-to-end tests.
