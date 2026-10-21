import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { APPS_SCRIPT_URL } from "../../src/config.js";
import {
  AppsScriptRequestError,
  backendEventKey,
  appsScriptRequest,
  confirmedRegistrationResponse,
  normalizeRegistrationPayloadEvent,
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

test("all frontend event keys serialize to exact Apps Script event keys", () => {
  const cases = [
    ["cricket", "cricket", ["a", "b", "c", "d", "e"]],
    ["football", "football", ["a", "b", "c", "d", "e"]],
    ["cyclothon", "cyclothon", ["a"]],
    ["treasure", "treasurehunt", ["a", "b", "c", "d"]],
  ];
  for (const [frontendKey, backendKey, selected] of cases) {
    const payload = registrationPayload(frontendKey, "11111111-1111-4111-8111-111111111111", sampleState(frontendKey, selected));
    assert.equal(payload.event, backendKey, `${frontendKey} must serialize as ${backendKey}`);
    assert.equal(backendEventKey(frontendKey), backendKey);
    const legacyPayload = {
      ...payload,
      event: frontendKey === "treasure" ? "Treasure Hunt" : frontendKey[0].toUpperCase() + frontendKey.slice(1),
      screenshotReference: frontendKey === "cricket" ? "preserved-drive-reference" : undefined,
      retryMarker: "preserved",
    };
    const normalized = normalizeRegistrationPayloadEvent(frontendKey, legacyPayload);
    assert.equal(normalized.event, backendKey);
    assert.equal(normalized.registrationId, payload.registrationId);
    assert.equal(normalized.retryMarker, "preserved");
    if (frontendKey === "cricket") assert.equal(normalized.screenshotReference, "preserved-drive-reference");
  }
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

test("passes the exact Drive screenshotReference through the final Cricket JSON payload", async () => {
  const registrationId = "33333333-3333-4333-8333-333333333333";
  const driveFileId = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const parsedReference = screenshotReferenceFromResponse({
    success: true,
    screenshotReference: driveFileId,
    fileId: "wrong-file-reference",
  });
  assert.equal(parsedReference, driveFileId);
  assert.equal(screenshotReferenceFromResponse({ success: true, fileId: driveFileId }), "");

  const payload = registrationPayload(
    "cricket",
    registrationId,
    sampleState("cricket", ["a", "b", "c", "d", "e"]),
    parsedReference,
  );
  const originalFetch = globalThis.fetch;
  let serializedPayload;
  globalThis.fetch = async (_url, options) => {
    serializedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  try {
    await appsScriptRequest(payload);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(serializedPayload.registrationId, registrationId);
  assert.equal(serializedPayload.event, "cricket");
  assert.equal(serializedPayload.screenshotReference, driveFileId);
  assert.equal(serializedPayload.screenshotReference, payload.screenshotReference);
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

test("final POST bodies contain only the four backend event keys", async () => {
  const originalFetch = globalThis.fetch;
  const postedEvents = [];
  globalThis.fetch = async (_url, options) => {
    postedEvents.push(JSON.parse(options.body).event);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  try {
    for (const [key, expected, selected] of [
      ["cricket", "cricket", ["a", "b", "c", "d", "e"]],
      ["football", "football", ["a", "b", "c", "d", "e"]],
      ["cyclothon", "cyclothon", ["a"]],
      ["treasure", "treasurehunt", ["a", "b", "c", "d"]],
    ]) {
      const payload = registrationPayload(key, "11111111-1111-4111-8111-111111111111", sampleState(key, selected));
      await appsScriptRequest(payload);
      assert.equal(postedEvents.at(-1), expected);
    }
    assert.deepEqual(postedEvents, ["cricket", "football", "cyclothon", "treasurehunt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshot upload includes the Cricket event key and upload action", async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  let seenUrl;
  globalThis.fetch = async (url, options) => {
    seenUrl = url;
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, screenshotReference: "drive-id" }), { status: 200 });
  };
  const originalFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,AQIDBA==`;
      this.onload();
    }
  };
  try {
    const file = {
      name: "receipt.png",
      type: "image/png",
      size: 4,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
    const response = await (await import("../../src/apps-script-api.js")).uploadPaymentScreenshot(
      file,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(response.success, true);
    assert.deepEqual(sent, {
      action: "uploadScreenshot",
      event: "cricket",
      registrationId: "11111111-1111-4111-8111-111111111111",
      uploadId: "22222222-2222-4222-8222-222222222222",
      mimeType: "image/png",
      sha256: createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex"),
      base64: "AQIDBA==",
    });
    assert.equal(seenUrl, APPS_SCRIPT_URL);
    const uploadUrl = new URL(seenUrl);
    assert.equal(uploadUrl.hostname, "script.google.com");
    assert.match(uploadUrl.pathname, /^\/macros\/s\/[^/]+\/exec$/);
    assert.doesNotMatch(uploadUrl.pathname, /library/i);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  }
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
