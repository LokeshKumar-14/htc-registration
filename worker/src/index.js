import ExcelJS from "exceljs";

const EVENT_SHEETS = ["Cricket", "Football", "Cyclothon", "Treasure Hunt"];
const TEAM_SIZE = { Cricket: 5, Football: 5, "Treasure Hunt": 4 };
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_GITHUB_RETRIES = 5;
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADERS = [
  "Registration ID", "Team Name", "Roll Number", "Student Name", "Phone Number", "Branch", "Year",
  "Payment Amount", "Payment Status", "Submission Timestamp", "Screenshot Object Reference", "Eligibility Confirmation",
];
const ACCESS_KEYS_CACHE = { keys: null, fetchedAt: 0 };

function jsonResponse(request, env, status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;
  if (!origin || !allowed || origin !== allowed) return { "Vary": "Origin" };
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || Boolean(env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);
}

function requireConfiguration(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Worker configuration is missing: ${missing.join(", ")}.`);
}

function safeCell(value) {
  const text = String(value ?? "");
  return /^[=@\t\r]/.test(text) ? `'${text}` : text;
}

function validateRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object.");
  if (!/^[0-9a-f-]{36}$/i.test(body.registrationId || "")) throw new Error("A valid registration ID is required.");
  if (!EVENT_SHEETS.includes(body.event)) throw new Error("Unknown event.");
  if (!Array.isArray(body.participants)) throw new Error("Participants must be a list.");
  const expected = TEAM_SIZE[body.event];
  if (expected && body.participants.length !== expected) throw new Error(`${body.event} requires exactly ${expected} participants.`);
  if (body.event === "Cyclothon" && (body.participants.length < 1 || body.participants.length > 100)) {
    throw new Error("Cyclothon requires one or more participants.");
  }
  if (body.event !== "Cyclothon" && (typeof body.teamName !== "string" || !body.teamName.trim() || body.teamName.length > 80)) {
    throw new Error("A team name of 1–80 characters is required.");
  }
  if (body.event === "Treasure Hunt" && body.eligibilityConfirmed !== true) {
    throw new Error("The Treasure Hunt eligibility declaration is required.");
  }
  if (body.event === "Cricket" && (typeof body.screenshotKey !== "string" || !body.screenshotKey.startsWith(`payments/${body.registrationId}/`))) {
    throw new Error("A payment screenshot uploaded for this registration is required.");
  }
  const seenRollNumbers = new Set();
  const participants = body.participants.map((participant) => {
    if (!participant || typeof participant !== "object" || Array.isArray(participant)) throw new Error("Invalid participant record.");
    const rollNumber = String(participant.rollNumber || "").trim();
    const fullName = String(participant.fullName || "").trim();
    const phone = String(participant.phone || "").trim().replace(/[\s()-]/g, "");
    const branch = String(participant.branch || "").trim();
    const year = String(participant.year || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9/-]{1,29}$/.test(rollNumber)) throw new Error("A participant has an invalid roll number.");
    if (fullName.length < 2 || fullName.length > 100) throw new Error("A participant has an invalid name.");
    if (!/^(?:\+91)?[6-9]\d{9}$/.test(phone)) throw new Error("A participant has an invalid Indian phone number.");
    if (!branch || branch.length > 80) throw new Error("A participant has an invalid branch.");
    if (!["1st Year", "2nd Year", "3rd Year"].includes(year)) throw new Error("A participant has an invalid year.");
    const normalizedRoll = rollNumber.toLowerCase();
    if (seenRollNumbers.has(normalizedRoll)) throw new Error("Duplicate participant roll numbers are not allowed.");
    seenRollNumbers.add(normalizedRoll);
    return { rollNumber, fullName, phone, branch, year };
  });
  return {
    registrationId: body.registrationId,
    event: body.event,
    teamName: body.event === "Cyclothon" ? "" : body.teamName.trim(),
    participants,
    screenshotKey: body.event === "Cricket" ? body.screenshotKey : "",
    eligibilityConfirmed: body.event === "Treasure Hunt",
  };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF202620" } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 28;
  row.eachCell((cell) => {
    cell.border = { bottom: { style: "thin", color: { argb: "FF9BA69C" } } };
  });
}

function formatSheet(sheet) {
  sheet.columns = [
    { width: 38 }, { width: 24 }, { width: 18 }, { width: 27 }, { width: 18 }, { width: 30 },
    { width: 16 }, { width: 16 }, { width: 23 }, { width: 27 }, { width: 55 }, { width: 26 },
  ];
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.properties.defaultRowHeight = 21;
}

async function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HTC Club Registration Portal";
  workbook.created = new Date();
  for (const name of EVENT_SHEETS) {
    const sheet = workbook.addWorksheet(name);
    formatSheet(sheet);
    styleHeader(sheet.addRow(HEADERS));
  }
  return workbook;
}

function verifyWorkbookSheets(workbook) {
  const names = workbook.worksheets.map((sheet) => sheet.name);
  if (names.length !== EVENT_SHEETS.length || EVENT_SHEETS.some((name) => !names.includes(name))) {
    throw new Error("The stored workbook must contain exactly Cricket, Football, Cyclothon, and Treasure Hunt worksheets.");
  }
  for (const sheet of workbook.worksheets) formatSheet(sheet);
}

async function decodeContent(response) {
  const content = await response.json();
  if (!content || typeof content.content !== "string") throw new Error("GitHub returned an invalid workbook response.");
  const binary = atob(content.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { bytes, sha: content.sha };
}

function encodeBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function getWorkbook(env) {
  requireConfiguration(env, ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_WORKBOOK_PATH"]);
  const path = env.GITHUB_WORKBOOK_PATH.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "htc-registration-worker",
    },
  });
  if (response.status === 404) return { workbook: await createWorkbook(), sha: null };
  if (!response.ok) {
    console.error("GitHub workbook read failed", response.status);
    throw new Error("The private workbook could not be read. Check repository access and Worker configuration.");
  }
  const { bytes, sha } = await decodeContent(response);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  verifyWorkbookSheets(workbook);
  return { workbook, sha };
}

function existingRegistration(sheet, registrationId) {
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (sheet.getCell(row, 1).value === registrationId) return true;
  }
  return false;
}

function existingRollNumbers(sheet) {
  const rolls = new Set();
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const roll = sheet.getCell(row, 3).value;
    if (typeof roll === "string" && roll.trim()) rolls.add(roll.toLowerCase());
  }
  return rolls;
}

function applyRegistration(workbook, registration) {
  const sheet = workbook.getWorksheet(registration.event);
  if (existingRegistration(sheet, registration.registrationId)) return false;
  const registeredRolls = existingRollNumbers(sheet);
  const duplicate = registration.participants.find(({ rollNumber }) => registeredRolls.has(rollNumber.toLowerCase()));
  if (duplicate) throw new Error(`Roll number ${duplicate.rollNumber} is already registered for ${registration.event}.`);
  const timestamp = new Date().toISOString();
  if (registration.event !== "Cyclothon") {
    const heading = sheet.addRow([safeCell(`Team Name: ${registration.teamName}`)]);
    heading.font = { bold: true, size: 12 };
    heading.height = 24;
    styleHeader(sheet.addRow(HEADERS));
  }
  for (const participant of registration.participants) {
    const row = sheet.addRow([
      registration.registrationId,
      safeCell(registration.teamName),
      safeCell(participant.rollNumber),
      safeCell(participant.fullName),
      safeCell(participant.phone),
      safeCell(participant.branch),
      safeCell(participant.year),
      registration.event === "Cricket" ? 50 : "",
      registration.event === "Cricket" ? "Pending Verification" : "",
      timestamp,
      registration.screenshotKey,
      registration.event === "Treasure Hunt" ? "Self-declared: at least one girl" : "",
    ]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFD8DED8" } },
        bottom: { style: "thin", color: { argb: "FFD8DED8" } },
        left: { style: "thin", color: { argb: "FFD8DED8" } },
        right: { style: "thin", color: { argb: "FFD8DED8" } },
      };
      cell.alignment = { vertical: "middle" };
    });
  }
  if (registration.event !== "Cyclothon") sheet.addRow([]);
  return true;
}

async function putWorkbook(env, workbook, sha) {
  const bytes = await workbook.xlsx.writeBuffer();
  const path = env.GITHUB_WORKBOOK_PATH.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/contents/${path}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "htc-registration-worker",
    },
    body: JSON.stringify({
      message: "Save HTC event registration",
      content: encodeBase64(new Uint8Array(bytes)),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (response.status === 409 || response.status === 422) return false;
  if (!response.ok) {
    console.error("GitHub workbook write failed", response.status);
    throw new Error("The workbook could not be saved. Your registration is safely queued for retry.");
  }
  return true;
}

async function saveRegistration(env, registration) {
  requireConfiguration(env, ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_WORKBOOK_PATH"]);
  for (let attempt = 0; attempt < MAX_GITHUB_RETRIES; attempt += 1) {
    const { workbook, sha } = await getWorkbook(env);
    const sheet = workbook.getWorksheet(registration.event);
    if (existingRegistration(sheet, registration.registrationId)) return { saved: true, duplicate: true };
    applyRegistration(workbook, registration);
    if (await putWorkbook(env, workbook, sha)) return { saved: true, duplicate: false };
  }
  throw new Error("The workbook changed repeatedly. Your registration is safely queued; retry shortly.");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function getAccessKeys(env) {
  const now = Date.now();
  if (ACCESS_KEYS_CACHE.keys && now - ACCESS_KEYS_CACHE.fetchedAt < 10 * 60 * 1000) return ACCESS_KEYS_CACHE.keys;
  const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Cloudflare Access signing keys are unavailable.");
  const keys = await response.json();
  if (!Array.isArray(keys.keys)) throw new Error("Cloudflare Access returned invalid signing keys.");
  ACCESS_KEYS_CACHE.keys = keys.keys;
  ACCESS_KEYS_CACHE.fetchedAt = now;
  return keys.keys;
}

async function requireAdmin(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Administrator authentication is required.");
  requireConfiguration(env, ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Administrator authentication is invalid.");
  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (header.alg !== "RS256" || claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD)) {
    throw new Error("Administrator authentication is invalid.");
  }
  if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000) throw new Error("Administrator session has expired.");
  const jwk = (await getAccessKeys(env)).find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("Administrator authentication key is invalid.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("Administrator authentication is invalid.");
}

async function queueRegistration(env, registration) {
  const key = `pending/${registration.registrationId}.json`;
  await env.PRIVATE_FILES.put(key, JSON.stringify(registration), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return key;
}

async function handleRegister(request, env) {
  if (!originAllowed(request, env)) return jsonResponse(request, env, 403, { error: "This website origin is not allowed." });
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return jsonResponse(request, env, 415, { error: "Send a JSON registration request." });
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 100_000) return jsonResponse(request, env, 413, { error: "Registration request is too large." });
  let input;
  try { input = await request.json(); } catch { return jsonResponse(request, env, 400, { error: "Invalid JSON request." }); }
  let registration;
  try { registration = validateRegistration(input); } catch (error) {
    return jsonResponse(request, env, 400, { error: error.message });
  }
  let queueKey;
  try {
    if (registration.event === "Cricket" && !await env.PRIVATE_FILES.get(registration.screenshotKey)) {
      return jsonResponse(request, env, 400, { error: "The Cricket payment screenshot is missing or expired. Please upload it again." });
    }
    queueKey = await queueRegistration(env, registration);
    const result = await saveRegistration(env, registration);
    await env.PRIVATE_FILES.delete(queueKey);
    return jsonResponse(request, env, 200, {
      success: true,
      registrationId: registration.registrationId,
      paymentStatus: registration.event === "Cricket" ? "Pending Verification" : undefined,
      duplicate: result.duplicate,
      submittedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Registration persistence failed", error.message);
    if (error.message.includes("already registered") && queueKey) {
      await env.PRIVATE_FILES.delete(queueKey);
      return jsonResponse(request, env, 409, { error: error.message, registrationId: registration.registrationId, persisted: false });
    }
    return jsonResponse(request, env, 503, {
      error: error.message.includes("already registered") ? error.message : "Registration could not be saved yet. Your draft is retained; please retry.",
      registrationId: registration.registrationId,
      persisted: false,
    });
  }
}

async function handleScreenshotUpload(request, env) {
  if (!originAllowed(request, env)) return jsonResponse(request, env, 403, { error: "This website origin is not allowed." });
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_SCREENSHOT_BYTES + 64 * 1024) return jsonResponse(request, env, 413, { error: "Screenshot must be no larger than 5 MB." });
  let form;
  try { form = await request.formData(); } catch { return jsonResponse(request, env, 400, { error: "Invalid screenshot upload." }); }
  const file = form.get("file");
  const registrationId = form.get("registrationId");
  if (!(file instanceof File) || !/^[0-9a-f-]{36}$/i.test(String(registrationId || ""))) {
    return jsonResponse(request, env, 400, { error: "A valid screenshot and registration ID are required." });
  }
  if (file.size < 1 || file.size > MAX_SCREENSHOT_BYTES) return jsonResponse(request, env, 400, { error: "Screenshot must be no larger than 5 MB." });
  const ext = file.type === "image/jpeg" ? "jpg" : file.type === "image/png" ? "png" : "";
  if (!ext || !new Set(["image/jpeg", "image/png"]).has(file.type)) {
    return jsonResponse(request, env, 400, { error: "Only JPG, JPEG, and PNG screenshots are accepted." });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = ext === "jpg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = ext === "png" && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (!jpeg && !png) return jsonResponse(request, env, 400, { error: "The uploaded file does not match its declared image format." });
  const key = `payments/${registrationId}/${crypto.randomUUID()}.${ext}`;
  try {
    await env.PRIVATE_FILES.put(key, bytes, {
      httpMetadata: { contentType: file.type, cacheControl: "private, no-store" },
      customMetadata: { registrationId: String(registrationId) },
    });
  } catch (error) {
    console.error("Screenshot upload failed", error.message);
    return jsonResponse(request, env, 503, { error: "Screenshot could not be stored securely. Please retry." });
  }
  return jsonResponse(request, env, 201, { success: true, objectKey: key });
}

async function readAllRegistrations(env, search, eventFilter) {
  const { workbook } = await getWorkbook(env);
  const registrations = [];
  for (const event of EVENT_SHEETS) {
    if (eventFilter && eventFilter !== event) continue;
    const sheet = workbook.getWorksheet(event);
    for (let index = 1; index <= sheet.rowCount; index += 1) {
      const row = sheet.getRow(index);
      if (row.getCell(1).value === "Registration ID" || !row.getCell(1).value || String(row.getCell(1).value).startsWith("Team Name:")) continue;
      const registrationId = String(row.getCell(1).value);
      const teamName = String(row.getCell(2).value || "");
      const rollNumber = String(row.getCell(3).value || "");
      const studentName = String(row.getCell(4).value || "");
      if (row.getCell(1).value === HEADERS[0]) continue;
      if (search && !`${teamName} ${rollNumber} ${studentName}`.toLowerCase().includes(search.toLowerCase())) continue;
      registrations.push({
        event, registrationId, teamName, rollNumber, studentName,
        paymentStatus: String(row.getCell(9).value || ""),
        screenshotKey: String(row.getCell(11).value || ""),
      });
    }
  }
  return registrations;
}

async function handleAdmin(request, env, url) {
  if (request.method === "POST" && !originAllowed(request, env)) {
    return jsonResponse(request, env, 403, { error: "This website origin is not allowed." });
  }
  try { await requireAdmin(request, env); } catch (error) {
    return jsonResponse(request, env, 401, { error: error.message });
  }
  const path = url.pathname;
  if (path === "/api/admin/status" && request.method === "GET") {
    try {
      const { workbook, sha } = await getWorkbook(env);
      return jsonResponse(request, env, 200, {
        message: `Private workbook available · ${workbook.worksheets.reduce((count, sheet) => count + Math.max(0, sheet.rowCount - 1), 0)} worksheet rows · version ${sha ? sha.slice(0, 8) : "not yet created"}.`,
        workbookAvailable: true,
      });
    } catch (error) {
      return jsonResponse(request, env, 503, { error: error.message, workbookAvailable: false });
    }
  }
  if (path === "/api/admin/registrations" && request.method === "GET") {
    const event = url.searchParams.get("event") || "";
    if (event && !EVENT_SHEETS.includes(event)) return jsonResponse(request, env, 400, { error: "Unknown event filter." });
    const query = (url.searchParams.get("q") || "").slice(0, 100);
    try {
      const registrations = await readAllRegistrations(env, query, event);
      return jsonResponse(request, env, 200, { registrations });
    } catch (error) { return jsonResponse(request, env, 503, { error: error.message }); }
  }
  if (path === "/api/admin/workbook" && request.method === "GET") {
    try {
      const { workbook } = await getWorkbook(env);
      const bytes = await workbook.xlsx.writeBuffer();
      return new Response(bytes, {
        headers: {
          "Content-Type": XLSX_CONTENT_TYPE,
          "Content-Disposition": 'attachment; filename="HTC_Registrations.xlsx"',
          "Cache-Control": "private, no-store",
          ...corsHeaders(request, env),
        },
      });
    } catch (error) { return jsonResponse(request, env, 503, { error: error.message }); }
  }
  if (path === "/api/admin/screenshot" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("payments/") || key.includes("..") || key.includes("\\")) {
      return jsonResponse(request, env, 400, { error: "Invalid screenshot reference." });
    }
    const object = await env.PRIVATE_FILES.get(key);
    if (!object) return jsonResponse(request, env, 404, { error: "Screenshot not found." });
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...corsHeaders(request, env),
      },
    });
  }
  if (path === "/api/admin/retry-pending" && request.method === "POST") {
    let pending = await env.PRIVATE_FILES.list({ prefix: "pending/", limit: 100 });
    let retried = 0;
    let remaining = 0;
    do {
      for (const object of pending.objects) {
        const stored = await env.PRIVATE_FILES.get(object.key);
        if (!stored) continue;
        try {
          const registration = validateRegistration(await stored.json());
          await saveRegistration(env, registration);
          await env.PRIVATE_FILES.delete(object.key);
          retried += 1;
        } catch (error) {
          console.error("Pending registration retry failed", object.key, error.message);
          remaining += 1;
        }
      }
      pending = pending.truncated ? await env.PRIVATE_FILES.list({ prefix: "pending/", limit: 100, cursor: pending.cursor }) : { truncated: false, objects: [] };
    } while (pending.truncated);
    return jsonResponse(request, env, 200, { retried, remaining });
  }
  return jsonResponse(request, env, 404, { error: "Admin endpoint not found." });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return jsonResponse(request, env, 200, { status: "ok", service: "HTC registration API" });
      }
      if (url.pathname.startsWith("/api/admin/")) return handleAdmin(request, env, url);
      if (url.pathname === "/api/register" && request.method === "POST") return handleRegister(request, env);
      if (url.pathname === "/api/upload-payment-screenshot" && request.method === "POST") return handleScreenshotUpload(request, env);
      return jsonResponse(request, env, 404, { error: "Endpoint not found." });
    } catch (error) {
      console.error("Worker request failed", error.message);
      return jsonResponse(request, env, 500, { error: "The request could not be completed. Please retry." });
    }
  },
};

export { applyRegistration, createWorkbook, safeCell, validateRegistration };
