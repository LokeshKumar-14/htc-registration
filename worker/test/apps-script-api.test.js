import test from "node:test";
import assert from "node:assert/strict";
import {
  AppsScriptRequestError,
  appsScriptRequest,
  confirmedRegistrationResponse,
  registrationPayload,
  screenshotReferenceFromResponse,
  validateScreenshot,
} from "../../src/apps-script-api.js";

function sampleState(eventKey, selected) {
  return {
    teamName: "HTC Warriors",
    eligibilityConfirmed: true,
    students: selected.map((id, index) => ({
      id,
      rollNumber: `23${String(index + 1).padStart(2, "0")}`,
      fullName: `Student ${index + 1}`,
      phone: "9876543210",
      branch: "Computer Engineering",
      year: "2nd Year",
    })),
    events: { [eventKey]: { selected } },
  };
}

test("maps frontend event and participant fields to the Apps Script schema", () => {
  const payload = registrationPayload("treasure", "11111111-1111-4111-8111-111111111111", sampleState("treasure", ["a", "b", "c", "d"]));
  assert.equal(payload.event, "treasurehunt");
  assert.equal(payload.participants.length, 4);
  assert.deepEqual(payload.participants[0], {
    rollNumber: "2301",
    name: "Student 1",
    phone: "9876543210",
    branch: "Computer Engineering",
    year: "2nd",
  });
  assert.equal(payload.girlEligibilityConfirmed, true);
  assert.equal(payload.teamName, "HTC Warriors");
});

test("Cyclothon has no team name and Cricket sends payment reference and amount", () => {
  const cyclothon = registrationPayload("cyclothon", "22222222-2222-4222-8222-222222222222", sampleState("cyclothon", ["a"]));
  assert.equal(cyclothon.event, "cyclothon");
  assert.equal(cyclothon.teamName, "");
  assert.equal(cyclothon.participants.length, 1);
  const cricket = registrationPayload("cricket", "33333333-3333-4333-8333-333333333333", sampleState("cricket", ["a", "b", "c", "d", "e"]), "drive-file-id");
  assert.equal(cricket.event, "cricket");
  assert.equal(cricket.paymentAmount, 50);
  assert.equal(cricket.screenshotReference, "drive-file-id");
});

test("uses a CORS-safelisted text/plain POST and recognizes only explicit success", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify({ success: true, registrationId: "id" }), { status: 200 });
  };
  try {
    const response = await appsScriptRequest({ registrationId: "id", event: "football" });
    assert.equal(response.success, true);
    assert.match(seen.url, /^https:\/\/script\.google\.com\/macros\/s\//);
    assert.equal(seen.options.method, "POST");
    assert.equal(seen.options.mode, "cors");
    assert.equal(seen.options.credentials, "omit");
    assert.equal(seen.options.headers["Content-Type"], "text/plain;charset=UTF-8");
    assert.equal(JSON.parse(seen.options.body).registrationId, "id");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(confirmedRegistrationResponse({ success: true }), true);
  assert.equal(confirmedRegistrationResponse({ alreadySaved: true }), true);
  assert.equal(confirmedRegistrationResponse({ success: false }), false);
  assert.equal(screenshotReferenceFromResponse({ screenshotReference: "drive-id" }), "drive-id");
});

test("network failures are marked uncertain for idempotent retries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  try {
    await assert.rejects(appsScriptRequest({ registrationId: "stable-id" }), (error) => {
      assert.ok(error instanceof AppsScriptRequestError);
      assert.equal(error.uncertain, true);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshots require a supported matching MIME and extension within the limit", () => {
  assert.equal(validateScreenshot({ name: "receipt.jpeg", type: "image/jpeg", size: 5 }), "");
  assert.equal(validateScreenshot({ name: "receipt.webp", type: "image/webp", size: 5 }), "");
  assert.match(validateScreenshot({ name: "receipt.jpg", type: "image/png", size: 5 }), /matching/);
  assert.match(validateScreenshot({ name: "receipt.gif", type: "image/gif", size: 5 }), /matching/);
  assert.match(validateScreenshot({ name: "receipt.png", type: "image/png", size: 5 * 1024 * 1024 + 1 }), /5 MB/);
});
