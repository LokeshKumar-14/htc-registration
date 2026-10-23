import { APPS_SCRIPT_URL } from "./config.js";

const EVENT_KEYS = {
  cricket: "cricket",
  football: "football",
  cyclothon: "cyclothon",
  treasure: "treasurehunt",
};

const YEAR_VALUES = {
  "1st Year": "1st",
  "2nd Year": "2nd",
  "3rd Year": "3rd",
  "4th Year": "4th",
};

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const DEVELOPMENT_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function backendEventKey(eventKey) {
  const event = EVENT_KEYS[eventKey];
  if (!event) throw new AppsScriptRequestError("This event is not supported.");
  return event;
}

export function normalizeRegistrationPayloadEvent(eventKey, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppsScriptRequestError("The saved registration data is invalid. Review this event and try again.");
  }
  const event = backendEventKey(eventKey);
  const registration = { ...payload, event };
  if (eventKey === "cricket") {
    delete registration.paymentAmount;
    delete registration.screenshotReference;
  }
  return registration;
}

function logDevelopmentEvent(payload) {
  if (typeof location !== "undefined" && DEVELOPMENT_HOSTS.has(location.hostname)) {
    console.debug("[HTC registration] Apps Script event key:", payload.event || "(upload action)");
  }
}

export class AppsScriptRequestError extends Error {
  constructor(message, { uncertain = false, response = null } = {}) {
    super(message);
    this.name = "AppsScriptRequestError";
    this.uncertain = uncertain;
    this.response = response;
  }
}

export function registrationPayload(eventKey, registrationId, state) {
  const event = EVENT_KEYS[eventKey];
  if (!event) throw new AppsScriptRequestError("This event is not supported.");
  const selectedIds = state.events[eventKey].selected;
  const participants = selectedIds.map((id) => state.students.find((student) => student.id === id)).filter(Boolean);
  return {
    registrationId,
    event,
    teamName: eventKey === "cyclothon" ? "" : state.teamName.trim(),
    collegeName: state.collegeName.trim(),
    participants: participants.map((participant) => ({
      rollNumber: participant.rollNumber.trim(),
      name: participant.fullName.trim(),
      phone: participant.phone.trim(),
      branch: participant.branch.trim(),
      year: YEAR_VALUES[participant.year] || participant.year,
    })),
    ...(eventKey === "treasure" ? { girlEligibilityConfirmed: state.eligibilityConfirmed === true } : {}),
  };
}

export async function appsScriptRequest(payload, { timeoutMs = 60_000 } = {}) {
  logDevelopmentEvent(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseText;
  try {
    response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    responseText = await response.text();
  } catch (error) {
    throw new AppsScriptRequestError(
      error.name === "AbortError"
        ? "The request timed out. The result is uncertain; retry safely using the same registration reference."
        : "The server response could not be reached. The result is uncertain; retry safely using the same registration reference.",
      { uncertain: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new AppsScriptRequestError(
      "The server response could not be read. The result is uncertain; retry safely using the same registration reference.",
      { uncertain: true },
    );
  }

  if (!response.ok || !result || typeof result !== "object") {
    throw new AppsScriptRequestError(result?.message || `The server returned HTTP ${response.status}.`, {
      uncertain: response.status >= 500,
      response: result,
    });
  }
  return result;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AppsScriptRequestError("The selected screenshot could not be read."));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) reject(new AppsScriptRequestError("The selected screenshot could not be encoded."));
      else resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function validateScreenshot(file) {
  if (!file) return "Choose a payment screenshot first.";
  if (file.size < 1 || file.size > MAX_SCREENSHOT_BYTES) return "Choose an image no larger than 5 MB.";
  const extension = file.name.split(".").pop()?.toLowerCase();
  const accepted = {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
  };
  if (!accepted[file.type] || !accepted[file.type].includes(extension)) {
    return "Use a matching JPG, JPEG, PNG, or WebP image file.";
  }
  return "";
}

export async function uploadPaymentScreenshot(file, registrationId, uploadId) {
  const validationError = validateScreenshot(file);
  if (validationError) throw new AppsScriptRequestError(validationError);
  const [base64, digest] = await Promise.all([
    readFileAsBase64(file),
    file.arrayBuffer().then(async (buffer) => {
      const hash = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }),
  ]);
  return appsScriptRequest({
    action: "uploadScreenshot",
    event: EVENT_KEYS.cricket,
    registrationId,
    uploadId,
    mimeType: file.type,
    sha256: digest,
    base64,
  });
}

export function confirmedRegistrationResponse(result) {
  return result?.success === true || result?.alreadySaved === true || result?.saved === true;
}

export function screenshotReferenceFromResponse(result) {
  const reference = result?.screenshotReference;
  return typeof reference === "string" && reference.length > 0 ? reference : "";
}
