import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import worker, { applyRegistration, createWorkbook, safeCell, validateRegistration } from "../src/index.js";

const student = (rollNumber) => ({
  rollNumber,
  fullName: `Student ${rollNumber}`,
  phone: "9876543210",
  branch: "Computer Engineering",
  year: "1st Year",
});

const teamPayload = (event, count, extra = {}) => ({
  registrationId: "11111111-1111-4111-8111-111111111111",
  event,
  teamName: "HTC Team",
  collegeName: "NIT Kurukshetra",
  participants: Array.from({ length: count }, (_, index) => student(`23${String(index + 1).padStart(2, "0")}`)),
  ...extra,
});

test("workbook initializes exactly the four required worksheets", async () => {
  const workbook = await createWorkbook();
  assert.deepEqual(workbook.worksheets.map(({ name }) => name), ["Cricket", "Football", "Cyclothon", "Treasure Hunt"]);
  assert.equal(workbook.getWorksheet("Cyclothon").getRow(1).getCell(1).value, "Registration ID");
  assert.equal(workbook.getWorksheet("Cricket").getRow(1).getCell(1).value, "Registration ID");
});

test("validates exact team sizes, college name and eligibility declaration", () => {
  const cricket = validateRegistration(teamPayload("Cricket", 5));
  assert.equal(cricket.participants.length, 5);
  assert.equal(cricket.collegeName, "NIT Kurukshetra");
  assert.equal(cricket.screenshotKey, "");
  assert.throws(() => validateRegistration(teamPayload("Cricket", 4)), /exactly 5/);
  assert.throws(() => validateRegistration(teamPayload("Cricket", 5, { collegeName: "" })), /college name/);
  assert.throws(() => validateRegistration(teamPayload("Treasure Hunt", 4)), /eligibility declaration/);
  assert.equal(validateRegistration(teamPayload("Treasure Hunt", 4, { eligibilityConfirmed: true })).participants.length, 4);
});

test("writes Cricket registrations as free and stores the college name", async () => {
  const workbook = await createWorkbook();
  const registration = validateRegistration(teamPayload("Cricket", 5));
  applyRegistration(workbook, registration);
  const sheet = workbook.getWorksheet("Cricket");
  assert.equal(sheet.getCell(4, 8).value, "");
  assert.equal(sheet.getCell(4, 9).value, "");
  assert.equal(sheet.getCell(4, 11).value, "");
  assert.equal(sheet.getCell(4, 13).value, "NIT Kurukshetra");
});

test("writes team headings and participant rows with a blank team separator", async () => {
  const workbook = await createWorkbook();
  const sheet = workbook.getWorksheet("Football");
  const first = validateRegistration(teamPayload("Football", 5));
  applyRegistration(workbook, first);
  const second = validateRegistration({
    ...teamPayload("Football", 5, { registrationId: "22222222-2222-4222-8222-222222222222" }),
    teamName: "Second Team",
    participants: Array.from({ length: 5 }, (_, index) => student(`24${String(index + 1).padStart(2, "0")}`)),
  });
  applyRegistration(workbook, second);
  assert.equal(sheet.getCell(1, 1).value, "Registration ID");
  assert.equal(sheet.getCell(2, 1).value, "Team Name: HTC Team");
  assert.equal(sheet.getCell(3, 1).value, "Registration ID");
  assert.equal(sheet.getCell(4, 1).value, first.registrationId);
  assert.equal(sheet.getCell(4, 13).value, "NIT Kurukshetra");
  assert.equal(sheet.getCell(9, 1).value, null);
  assert.equal(sheet.getCell(10, 1).value, "Team Name: Second Team");
});

test("Cyclothon writes individual rows without team names or blank separators", async () => {
  const workbook = await createWorkbook();
  const sheet = workbook.getWorksheet("Cyclothon");
  const registration = validateRegistration({
    ...teamPayload("Cyclothon", 2),
    teamName: "",
  });
  applyRegistration(workbook, registration);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell(2, 2).value, "");
  assert.equal(sheet.getCell(2, 3).value, registration.participants[0].rollNumber);
});

test("prevents duplicate participant rows within teams and formula-like cell values", async () => {
  const workbook = await createWorkbook();
  const sheet = workbook.getWorksheet("Football");
  const malicious = validateRegistration(teamPayload("Football", 5));
  malicious.teamName = "=HYPERLINK(\"https://example.com\")";
  assert.equal(safeCell(malicious.teamName).startsWith("'="), true);
  applyRegistration(workbook, malicious);
  const repeated = validateRegistration({
    ...teamPayload("Football", 5, { registrationId: "22222222-2222-4222-8222-222222222222" }),
    participants: Array.from({ length: 5 }, (_, index) => student(`23${String(index + 1).padStart(2, "0")}`)),
  });
  assert.throws(() => applyRegistration(workbook, repeated), /already registered/);
  assert.equal(sheet.rowCount, 9);
});

test("validates Cyclothon as individual registrations and rejects duplicate roll numbers", () => {
  const registration = validateRegistration({
    ...teamPayload("Cyclothon", 2),
    participants: [student("2301"), student("2302")],
  });
  assert.equal(registration.teamName, "");
  assert.throws(() => validateRegistration({
    ...teamPayload("Cyclothon", 2),
    participants: [student("2301"), student("2301")],
  }), /Duplicate participant roll numbers/);
});

test("workbook remains readable after an XLSX serialization round trip", async () => {
  const workbook = await createWorkbook();
  applyRegistration(workbook, validateRegistration(teamPayload("Treasure Hunt", 4, { eligibilityConfirmed: true })));
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.deepEqual(restored.worksheets.map(({ name }) => name), ["Cricket", "Football", "Cyclothon", "Treasure Hunt"]);
  assert.equal(restored.getWorksheet("Treasure Hunt").getCell(4, 12).value, "Self-declared: at least one girl");
});

test("health is public, while admin routes reject requests without Access authentication", async () => {
  const env = {};
  const health = await worker.fetch(new Request("https://api.example.com/api/health"), env);
  assert.equal(health.status, 200);
  const admin = await worker.fetch(new Request("https://api.example.com/api/admin/status"), env);
  assert.equal(admin.status, 401);
  assert.match((await admin.json()).error, /Administrator authentication/);
});

test("simultaneous registrations survive GitHub SHA conflicts and retries stay idempotent", async () => {
  let workbookBytes;
  let sha = "";
  let version = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "PUT") {
      const requestBody = JSON.parse(options.body);
      if ((sha && requestBody.sha !== sha) || (!sha && workbookBytes)) {
        return new Response(JSON.stringify({ message: "Conflict" }), { status: 409 });
      }
      workbookBytes = Uint8Array.from(Buffer.from(requestBody.content, "base64"));
      sha = `version-${++version}`;
      return new Response("{}", { status: 201 });
    }
    if (!workbookBytes) return new Response("", { status: 404 });
    return new Response(JSON.stringify({
      sha,
      content: Buffer.from(workbookBytes).toString("base64"),
    }), { status: 200 });
  };
  const objects = new Map();
  const bucket = {
    async put(key, value) { objects.set(key, value); },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { json: async () => JSON.parse(value) };
    },
    async delete(key) { objects.delete(key); },
  };
  const env = {
    PRIVATE_FILES: bucket,
    ALLOWED_ORIGIN: "https://portal.example",
    GITHUB_TOKEN: "test-token",
    GITHUB_OWNER: "htc",
    GITHUB_REPOSITORY: "private-data",
    GITHUB_BRANCH: "main",
    GITHUB_WORKBOOK_PATH: "HTC_Registrations.xlsx",
  };
  const makeRequest = (registrationId, prefix) => new Request("https://api.example/api/register", {
    method: "POST",
    headers: { Origin: env.ALLOWED_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      registrationId,
      event: "Football",
      teamName: `Team ${prefix}`,
      collegeName: "NIT Kurukshetra",
      participants: Array.from({ length: 5 }, (_, index) => student(`${prefix}${String(index + 1).padStart(3, "0")}`)),
    }),
  });
  try {
    const firstRequest = makeRequest("11111111-1111-4111-8111-111111111111", "A");
    const secondRequest = makeRequest("22222222-2222-4222-8222-222222222222", "B");
    const [first, second] = await Promise.all([
      worker.fetch(firstRequest, env),
      worker.fetch(secondRequest, env),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(objects.size, 0);
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(workbookBytes);
    const sheet = restored.getWorksheet("Football");
    const registrationIds = [];
    for (let row = 1; row <= sheet.rowCount; row += 1) {
      const value = sheet.getCell(row, 1).value;
      if (typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) registrationIds.push(value);
    }
    assert.equal(registrationIds.length, 10);
    assert.equal(new Set(registrationIds).size, 2);
    const repeated = await worker.fetch(makeRequest("11111111-1111-4111-8111-111111111111", "A"), env);
    assert.equal(repeated.status, 200);
    const afterRetry = new ExcelJS.Workbook();
    await afterRetry.xlsx.load(workbookBytes);
    assert.equal(afterRetry.getWorksheet("Football").rowCount, sheet.rowCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed workbook writes are not reported as success and the same ID can be safely retried", async () => {
  let workbookBytes;
  let sha = "";
  let unavailable = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === "PUT") {
      if (unavailable) return new Response("Unavailable", { status: 503 });
      const requestBody = JSON.parse(options.body);
      workbookBytes = Uint8Array.from(Buffer.from(requestBody.content, "base64"));
      sha = "version-1";
      return new Response("{}", { status: 201 });
    }
    if (!workbookBytes) return new Response("", { status: 404 });
    return new Response(JSON.stringify({ sha, content: Buffer.from(workbookBytes).toString("base64") }), { status: 200 });
  };
  const objects = new Map();
  const env = {
    PRIVATE_FILES: {
      async put(key, value) { objects.set(key, value); },
      async get(key) {
        const value = objects.get(key);
        return value === undefined ? null : { json: async () => JSON.parse(value) };
      },
      async delete(key) { objects.delete(key); },
    },
    ALLOWED_ORIGIN: "https://portal.example",
    GITHUB_TOKEN: "test-token",
    GITHUB_OWNER: "htc",
    GITHUB_REPOSITORY: "private-data",
    GITHUB_BRANCH: "main",
    GITHUB_WORKBOOK_PATH: "HTC_Registrations.xlsx",
  };
  const body = {
    registrationId: "33333333-3333-4333-8333-333333333333",
    event: "Cyclothon",
    teamName: "",
    collegeName: "NIT Kurukshetra",
    participants: [student("25001")],
  };
  const makeRequest = () => new Request("https://api.example/api/register", {
    method: "POST",
    headers: { Origin: env.ALLOWED_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const failed = await worker.fetch(makeRequest(), env);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).persisted, false);
    assert.equal(objects.size, 1);
    unavailable = false;
    const retried = await worker.fetch(makeRequest(), env);
    assert.equal(retried.status, 200);
    assert.equal(objects.size, 0);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBytes);
    assert.equal(workbook.getWorksheet("Cyclothon").rowCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects screenshot uploads with unsupported image types", async () => {
  const form = new FormData();
  form.append("registrationId", "44444444-4444-4444-8444-444444444444");
  form.append("file", new Blob(["not an image"], { type: "image/gif" }), "payment.gif");
  const response = await worker.fetch(new Request("https://api.example/api/upload-payment-screenshot", {
    method: "POST",
    headers: { Origin: "https://portal.example" },
    body: form,
  }), {
    ALLOWED_ORIGIN: "https://portal.example",
    PRIVATE_FILES: { async put() { throw new Error("Must not write unsupported file."); } },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Only JPG, JPEG, and PNG/);
});
