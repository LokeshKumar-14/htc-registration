import { API_BASE_URL, BRANCHES, EVENTS, EVENT_LINKS } from "./config.js";
import {
  AppsScriptRequestError,
  normalizeRegistrationPayloadEvent,
  confirmedRegistrationResponse,
  registrationPayload,
  screenshotReferenceFromResponse,
  uploadPaymentScreenshot,
  validateScreenshot,
  appsScriptRequest,
} from "./apps-script-api.js";

const STORAGE_KEY = "htc-registration-draft-v1";
const STAGES = [{ key: "details", label: "Student Details" }, ...EVENTS.map(({ key, title }) => ({ key, label: title }))];
const app = document.querySelector("#app");
const modal = document.querySelector("#student-modal");
const modalForm = document.querySelector("#student-modal-form");
const blankEvent = () => ({ status: "upcoming", selected: [], registrationId: "", payload: null, screenshotReference: "", uploadId: "", uploadPending: false, receipt: null });

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const students = Array.isArray(saved.students) ? saved.students.filter((student) =>
      student && typeof student.id === "string" && typeof student.rollNumber === "string"
      && typeof student.fullName === "string" && typeof student.phone === "string"
      && typeof student.branch === "string" && typeof student.year === "string",
    ) : [];
    const events = Object.fromEntries(EVENTS.map(({ key }) => {
      const stored = saved.events?.[key] && typeof saved.events[key] === "object" ? saved.events[key] : {};
      const registrationId = typeof stored.registrationId === "string" && /^[0-9a-f-]{36}$/i.test(stored.registrationId) ? stored.registrationId : "";
      const payload = stored.payload && typeof stored.payload === "object" && !Array.isArray(stored.payload)
        && stored.payload.registrationId === registrationId ? stored.payload : null;
      return [key, {
        ...blankEvent(),
        status: ["upcoming", "completed", "skipped"].includes(stored.status) ? stored.status : "upcoming",
        selected: Array.isArray(stored.selected) ? stored.selected.filter((id) => typeof id === "string" && students.some((student) => student.id === id)) : [],
        registrationId,
        payload,
        screenshotReference: typeof stored.screenshotReference === "string" ? stored.screenshotReference : "",
        uploadId: typeof stored.uploadId === "string" ? stored.uploadId : "",
        uploadPending: stored.uploadPending === true,
        receipt: stored.receipt && typeof stored.receipt === "object" ? stored.receipt : null,
      }];
    }));
    return {
      teamName: typeof saved.teamName === "string" ? saved.teamName : "",
      students,
      currentStage: [...STAGES.map(({ key }) => key), "thankyou"].includes(saved.currentStage) ? saved.currentStage : "details",
      events,
      eligibilityConfirmed: saved.eligibilityConfirmed === true,
    };
  } catch (error) {
    console.error("Could not restore registration draft:", error);
    return { teamName: "", students: [], currentStage: "details", events: Object.fromEntries(EVENTS.map(({ key }) => [key, blankEvent()])), eligibilityConfirmed: false };
  }
}

let state = loadDraft();
let editingStudentId = "";
let previewUrl = "";
let selectedScreenshot = null;
const submittingEvents = new Set();

function saveDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("Could not save registration draft:", error);
    showMessage("This browser could not save your local draft. Avoid refreshing and check browser storage before continuing.");
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function branchOptions(selected = "") {
  return `<option value="">Select branch</option>${BRANCHES.map((branch) =>
    `<option value="${escapeHtml(branch)}" ${selected === branch ? "selected" : ""}>${escapeHtml(branch)}</option>`,
  ).join("")}`;
}

function currentIndex() {
  return STAGES.findIndex(({ key }) => key === state.currentStage);
}

function renderProgress() {
  const index = currentIndex();
  return `<nav class="progress" aria-label="Registration progress">${STAGES.map((stage, stageIndex) => {
    const status = stage.key === "details" && state.students.length > 0 && Boolean(state.teamName.trim())
      ? "completed"
      : state.events[stage.key]?.status;
    const active = stageIndex === index;
    const disabled = stageIndex > index;
    const visual = active ? "current" : status === "completed" ? "completed" : status === "skipped" ? "skipped" : "upcoming";
    const marker = status === "completed" ? "✓" : status === "skipped" ? "–" : stageIndex + 1;
    return `<button class="progress-step ${visual}" type="button" data-go-stage="${escapeHtml(stage.key)}" ${disabled ? "disabled" : ""} aria-current="${active ? "step" : "false"}" title="${escapeHtml(stage.label)}"><span class="progress-dot">${marker}</span><span class="progress-label">${escapeHtml(stage.label)}</span></button>`;
  }).join("")}</nav>`;
}

function participantCard(student, index) {
  const fullName = escapeHtml(student.fullName);
  return `<article class="participant">
    <div class="participant-main"><span class="avatar">${escapeHtml(fullName.trim().charAt(0).toUpperCase() || "?")}</span>
      <div><strong>${fullName}</strong><small>${escapeHtml(student.rollNumber)} · ${escapeHtml(student.branch)} · ${escapeHtml(student.year)}</small></div>
    </div>
    <div class="participant-controls"><button class="text-button" type="button" data-edit-student="${escapeHtml(student.id)}">Edit</button><button class="text-button danger" type="button" data-remove-student="${escapeHtml(student.id)}" aria-label="Remove ${fullName}">Remove</button></div>
  </article>`;
}

function renderDetails(message = "") {
  const students = state.students.map(participantCard).join("");
  return `<p class="eyebrow">HTC CLUB · NIT KURUKSHETRA</p><h1>Student details</h1>
    <p class="intro">Start with your team and participant details. Your draft is saved on this device as you go.</p>
    <section class="card">
      <div class="field-grid">
        <label class="full-width">Team name<input id="team-name" name="teamName" maxlength="80" value="${escapeHtml(state.teamName)}" placeholder="Enter one team name for this registration" autocomplete="organization"></label>
      </div>
      <div class="section-heading" style="margin-top:26px"><div><h2>Participants</h2><p>Add each student who may join an event. You can choose participants separately for each event.</p></div><button type="button" class="button button-secondary" data-add-student>Add student</button></div>
      <div class="participant-list">${students || '<p class="muted">No students added yet.</p>'}</div>
      ${message ? `<p class="status-message error" role="alert">${escapeHtml(message)}</p>` : ""}
      <div class="button-row button-row-end"><button type="button" class="button button-primary" data-details-next ${state.students.length === 0 || !state.teamName.trim() ? "disabled" : ""}>Continue to events <span aria-hidden="true">→</span></button></div>
    </section>`;
}

function renderEvent(event, message = "") {
  const data = EVENTS.find(({ key }) => key === event);
  const eventState = state.events[event];
  const isTeamEvent = !data.individual;
  const selectionLimit = data.teamSize || Infinity;
  const countLabel = data.key === "treasure" ? "Selected Members" : "Selected Players";
  const saved = eventState.status === "completed";
  const students = state.students.map((student) => {
    const selected = eventState.selected.includes(student.id);
    return `<label class="participant select-row"><input type="checkbox" data-select-student="${escapeHtml(student.id)}" ${selected ? "checked" : ""} ${saved || eventState.payload || selected || eventState.selected.length < selectionLimit ? "" : "disabled"} ${saved || eventState.payload ? "disabled" : ""}><span class="participant-main"><span class="avatar">${escapeHtml(student.fullName.trim().charAt(0).toUpperCase() || "?")}</span><span><strong>${escapeHtml(student.fullName)}</strong><small>${escapeHtml(student.rollNumber)} · ${escapeHtml(student.branch)} · ${escapeHtml(student.year)}</small></span></span></label>`;
  }).join("");
  const eventInfo = `<div class="event-meta">${data.prize ? `<span>Prize ${escapeHtml(data.prize)}</span>` : ""}<span>${escapeHtml(data.date)}</span><span>${escapeHtml(data.time)}</span><span>${escapeHtml(data.venue)}</span>${data.payment ? "<span>₹50 per team</span>" : ""}</div>${data.final ? `<p class="muted">${escapeHtml(data.final)}</p>` : ""}`;
  const payment = data.payment ? `<div class="payment-card">
      <div class="qr-wrap"><img src="assets/qrcode.png" alt="HTC event payment QR code" onerror="this.hidden=true;this.nextElementSibling.style.display='block'"><span class="qr-missing">Payment QR asset is not configured.<br>Provide <strong>assets/qrcode.png</strong>.</span></div>
      <div class="payment-info"><p class="eyebrow">TEAM REGISTRATION FEE</p><h3>₹50 <span class="muted">/ team</span></h3><p>Upload a clear screenshot in which the transaction ID is clearly visible.</p><label>Upload payment screenshot<input id="payment-file" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" ${saved || (eventState.payload && eventState.screenshotReference) ? "disabled" : ""}></label><img class="file-preview" alt="Payment screenshot preview" ${previewUrl ? `src="${previewUrl}" style="display:block"` : ""}>${previewUrl && !saved && !eventState.payload ? '<button class="text-button danger" type="button" data-remove-screenshot>Remove or replace screenshot</button>' : ""}${eventState.screenshotReference ? '<p class="status-message">Screenshot saved privately · Payment Pending Verification</p>' : ""}</div>
    </div>` : "";
  const eligibility = data.key === "treasure" ? `<label class="checkbox-note"><input type="checkbox" data-eligibility ${state.eligibilityConfirmed ? "checked" : ""} ${saved ? "disabled" : ""}><span>I confirm that my team includes at least one girl. This is a self-declaration; eligibility is not automatically gender-verified.</span></label>` : "";
  const receipt = saved ? `<p class="status-message">Registration saved successfully · Reference <strong>${escapeHtml(eventState.receipt?.registrationId || eventState.registrationId)}</strong>${data.payment ? " · Payment: Pending Verification" : ""}</p>` : "";
  return `<p class="eyebrow">EVENT REGISTRATION</p><h1>${escapeHtml(data.title)}</h1>
    <p class="intro">${escapeHtml(data.description)}</p>
    <section class="card">
      <div class="section-heading"><div><h2>${isTeamEvent ? `${data.teamSize}-member team` : "Individual entry"}</h2><p>${isTeamEvent ? `Select exactly ${data.teamSize} participants. Your team name is <strong>${escapeHtml(state.teamName || "not set")}</strong>.` : "Select one or more participants. Each person is registered individually."}</p></div><span class="badge">${saved ? "Saved" : "Registration"}</span></div>
      ${eventInfo}
      ${isTeamEvent ? `<p class="selection-count">${countLabel}: ${eventState.selected.length} / ${data.teamSize}</p>` : '<p class="selection-count">Select at least one participant</p>'}
      <div class="participant-list">${students || '<p class="muted">Add participants in Student Details before choosing an event.</p>'}</div>
      ${data.key === "treasure" ? '<button type="button" class="button button-secondary" data-add-student>Add student</button>' : ""}
      ${payment}${eligibility}${receipt}
      ${message ? `<p class="status-message error" role="alert">${escapeHtml(message)}</p>` : ""}
      <div class="button-row"><button class="button button-secondary" type="button" data-skip ${saved || eventState.payload || submittingEvents.has(event) ? "disabled" : ""}>Skip event</button><button class="button button-primary" type="button" data-submit-event="${escapeHtml(event)}" ${saved || eventState.selected.length === 0 || submittingEvents.has(event) ? "disabled" : ""}>${saved ? "Registration saved" : submittingEvents.has(event) ? "Saving registration…" : eventState.payload ? "Retry Submit & Next" : "Submit & Next"} <span aria-hidden="true">→</span></button></div>
    </section>`;
}

function renderThanks() {
  const successful = EVENTS.filter(({ key }) => state.events[key].status === "completed");
  const skipped = EVENTS.filter(({ key }) => state.events[key].status === "skipped");
  const statusList = successful.map(({ key, title, payment }) => {
    const result = state.events[key].receipt;
    return `<li><strong>${escapeHtml(title)}</strong> — Reference ${escapeHtml(result?.registrationId || state.events[key].registrationId)}${payment ? " · Payment Pending Verification" : ""}</li>`;
  }).join("");
  const skippedList = skipped.map(({ title }) => `<li>${escapeHtml(title)} — skipped</li>`).join("");
  const links = EVENT_LINKS.map(({ name, url }) => `<a class="event-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)} <span aria-hidden="true">↗</span></a>`).join("");
  return `<p class="eyebrow">REGISTRATION COMPLETE</p><h1>Thank You for Registering!</h1>
    <p class="intro">Thank you for being part of HTC Club, NIT Kurukshetra.<br><br>Your registration has been submitted successfully. We look forward to seeing you at the events.<br><br>Stay active, stay adventurous, and make memories with HTC!</p>
    <section class="card"><h2>Your registration summary</h2>
      ${successful.length ? `<h3>Successfully registered</h3><ul>${statusList}</ul>` : '<p class="muted">No event registrations were submitted.</p>'}
      ${skipped.length ? `<h3>Skipped events</h3><ul>${skippedList}</ul>` : ""}
      <h2 style="margin-top:26px">Explore the events</h2><div class="event-card-grid">${links}</div>
      <div class="button-row"><button class="button button-secondary" data-go-stage="treasure" type="button">Back to registration</button></div>
    </section>`;
}

function render() {
  if (new URLSearchParams(location.search).has("admin")) {
    renderAdmin();
    return;
  }
  const stage = state.currentStage;
  const content = stage === "details" ? renderDetails() : stage === "thankyou" ? renderThanks() : renderEvent(stage);
  app.innerHTML = `${stage === "thankyou" ? "" : renderProgress()}${content}`;
}

function renderAdmin(message = "") {
  app.innerHTML = `<p class="eyebrow">HTC CLUB · PRIVATE ADMIN</p><h1>Registration admin</h1><p class="intro">This page requires an active Cloudflare Access session. Student records are never exposed through the public registration flow.</p>
    <section class="card"><div class="section-heading"><div><h2>Workbook synchronization</h2><p data-admin-status>${escapeHtml(message || "Checking private workbook status…")}</p></div></div>
      <div class="admin-links"><button type="button" data-admin-refresh>Refresh status</button><button type="button" data-admin-download>Download latest workbook</button><button type="button" data-admin-pending>Retry pending workbook updates</button></div>
      <div class="admin-toolbar"><select id="admin-event"><option value="">All events</option><option>Cricket</option><option>Football</option><option>Cyclothon</option><option>Treasure Hunt</option></select><input id="admin-search" type="search" placeholder="Search team or roll number"><button class="button button-primary" data-admin-search type="button">Search</button></div>
      <div id="admin-results" class="table-wrap"></div>
    </section>`;
  adminStatus();
}

function showMessage(message) {
  let existing = app.querySelector('[role="alert"]');
  if (!existing) {
    existing = document.createElement("p");
    existing.className = "status-message error";
    existing.setAttribute("role", "alert");
    app.querySelector(".card")?.append(existing);
  }
  if (existing) existing.textContent = message;
}

function validateStudent(form) {
  const data = new FormData(form);
  const branchValue = String(data.get("branch") || "");
  const branch = branchValue === "Other" ? String(data.get("otherBranch") || "").trim() : branchValue;
  const student = {
    id: editingStudentId || crypto.randomUUID(),
    rollNumber: String(data.get("rollNumber") || "").trim(),
    fullName: String(data.get("fullName") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    branch,
    year: String(data.get("year") || "").trim(),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9/-]{1,29}$/.test(student.rollNumber)) return { error: "Enter a valid roll number (2–30 letters, numbers, / or -)." };
  if (student.fullName.length < 2 || student.fullName.length > 100) return { error: "Enter a full name between 2 and 100 characters." };
  if (!/^(?:\+91[\s-]?)?[6-9]\d{9}$/.test(student.phone.replace(/[\s()-]/g, ""))) return { error: "Enter a valid 10-digit Indian phone number." };
  if (!student.branch || student.branch.length > 80) return { error: "Select or enter a valid branch." };
  if (!["1st Year", "2nd Year", "3rd Year"].includes(student.year)) return { error: "Select a year." };
  const duplicate = state.students.some((item) => item.id !== editingStudentId && item.rollNumber.toLowerCase() === student.rollNumber.toLowerCase());
  if (duplicate) return { error: "A participant with this roll number is already in the draft." };
  return { student };
}

function openStudentModal(student = null) {
  editingStudentId = student?.id || "";
  modalForm.reset();
  modalForm.elements.branch.innerHTML = branchOptions(student?.branch || "");
  if (student) {
    for (const key of ["rollNumber", "fullName", "phone", "year"]) modalForm.elements[key].value = student[key] || "";
    if (!BRANCHES.includes(student.branch)) {
      modalForm.elements.branch.value = "Other";
      modalForm.elements.otherBranch.value = student.branch;
    }
  }
  modal.querySelector("h2").textContent = student ? "Edit student" : "Add a student";
  modal.querySelector("[data-modal-error]").textContent = "";
  modal.querySelector(".other-branch-field").classList.toggle("hidden", modalForm.elements.branch.value !== "Other");
  modal.showModal();
  modalForm.elements.rollNumber.focus();
}

function goToStage(key) {
  const target = STAGES.findIndex(({ key: itemKey }) => itemKey === key);
  if (target < 0 || (state.currentStage !== "thankyou" && target > currentIndex())) return;
  state.currentStage = key;
  saveDraft();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function validateForSubmit(key) {
  const data = EVENTS.find(({ key: eventKey }) => eventKey === key);
  const selected = state.events[key].selected;
  if (state.events[key].status === "completed") return "This event has already been saved.";
  if (data.teamSize && selected.length !== data.teamSize) return `Select exactly ${data.teamSize} participants.`;
  if (data.individual && selected.length < 1) return "Select at least one participant.";
  if (key !== "cyclothon" && !state.teamName.trim()) return "Add a team name in Student Details first.";
  if (key === "treasure" && !state.eligibilityConfirmed) return "Confirm the Treasure Hunt eligibility declaration before submitting.";
  if (key === "cricket" && !state.events.cricket.screenshotReference && !selectedScreenshot) return "Choose the Cricket payment screenshot before submitting.";
  if (selected.length !== new Set(selected).size) return "A participant can only be selected once.";
  const selectedStudents = selected.map((id) => state.students.find((student) => student.id === id)).filter(Boolean);
  if (selectedStudents.length !== selected.length) return "A selected participant is no longer available. Review the participant list.";
  if (selectedStudents.some((student) => !/^(?:\+91[\s-]?)?[6-9]\d{9}$/.test(student.phone.replace(/[\s()-]/g, "")))) {
    return "Check the selected participants’ Indian phone numbers before submitting.";
  }
  if (new Set(selectedStudents.map((student) => student.rollNumber.toLowerCase())).size !== selectedStudents.length) {
    return "Selected participants must have unique roll numbers.";
  }
  return "";
}

async function submitEvent(key) {
  if (submittingEvents.has(key)) return;
  const validationError = validateForSubmit(key);
  if (validationError) {
    showMessage(validationError);
    return;
  }
  const eventState = state.events[key];
  if (!eventState.registrationId) eventState.registrationId = crypto.randomUUID();
  if (key === "cricket" && selectedScreenshot && !eventState.uploadId) eventState.uploadId = crypto.randomUUID();
  if (!eventState.payload || (key === "cricket" && eventState.payload.screenshotReference !== eventState.screenshotReference)) {
    eventState.payload = registrationPayload(key, eventState.registrationId, state, eventState.screenshotReference);
  }
  eventState.payload = normalizeRegistrationPayloadEvent(key, eventState.payload);
  submittingEvents.add(key);
  saveDraft();
  render();
  const paymentInfo = app.querySelector(".payment-info");
  if (key === "cricket" && selectedScreenshot && !eventState.screenshotReference && paymentInfo) {
    const progress = document.createElement("p");
    progress.className = "status-message";
    progress.setAttribute("role", "status");
    progress.innerHTML = '<span class="spinner" aria-hidden="true"></span> Uploading screenshot securely…';
    paymentInfo.append(progress);
  }
  try {
    if (key === "cricket" && !eventState.screenshotReference) {
      if (!selectedScreenshot) throw new AppsScriptRequestError("Choose the payment screenshot again to continue.");
      eventState.uploadPending = true;
      saveDraft();
      const uploaded = await uploadPaymentScreenshot(selectedScreenshot, eventState.registrationId, eventState.uploadId);
      const screenshotReference = screenshotReferenceFromResponse(uploaded);
      if (uploaded.success !== true || !screenshotReference) {
        if (uploaded.requiresNewUploadId === true) {
          eventState.uploadId = crypto.randomUUID();
          eventState.uploadPending = false;
        }
        throw new AppsScriptRequestError(uploaded.message || "The screenshot upload was not confirmed. Retry safely.", {
          response: uploaded,
        });
      }
      eventState.uploadPending = false;
      eventState.screenshotReference = screenshotReference;
      eventState.payload.screenshotReference = screenshotReference;
      saveDraft();
    }
    render();
    const result = await appsScriptRequest(eventState.payload);
    if (!confirmedRegistrationResponse(result)) {
      throw new AppsScriptRequestError(result.message || "The backend did not confirm that this registration was saved.", { response: result });
    }
    eventState.status = "completed";
    eventState.receipt = result;
    eventState.payload = null;
    const nextIndex = STAGES.findIndex(({ key: stageKey }) => stageKey === key) + 1;
    state.currentStage = nextIndex === STAGES.length ? "thankyou" : STAGES[nextIndex].key;
    saveDraft();
    submittingEvents.delete(key);
    selectedScreenshot = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    submittingEvents.delete(key);
    if (error instanceof AppsScriptRequestError && !error.uncertain && error.response?.success === false) {
      eventState.payload = null;
      eventState.uploadPending = false;
    }
    saveDraft();
    const warning = error.uncertain
      ? `${error.message} Your draft, registration ID, and any uploaded screenshot reference are retained.`
      : `${error.message} Your form data and registration ID are retained.`;
    app.innerHTML = `${renderProgress()}${renderEvent(key, warning)}`;
  }
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function openDetailsStage() {
  state.currentStage = "details";
  saveDraft();
  render();
}

function onStudentModalSubmit(event) {
  event.preventDefault();
  const result = validateStudent(modalForm);
  if (result.error) {
    modalForm.querySelector("[data-modal-error]").textContent = result.error;
    return;
  }
  if (editingStudentId) {
    state.students = state.students.map((student) => student.id === editingStudentId ? result.student : student);
  } else {
    state.students.push(result.student);
  }
  saveDraft();
  modal.close();
  editingStudentId = "";
  render();
}

function renderAdminResults(data) {
  const target = document.querySelector("#admin-results");
  target.innerHTML = `<table><thead><tr><th>EVENT</th><th>TEAM / REGISTRATION</th><th>ROLL NUMBER</th><th>STUDENT</th><th>PAYMENT</th><th>SCREENSHOT</th></tr></thead><tbody>${data.registrations.map((row) => `<tr><td>${escapeHtml(row.event)}</td><td>${escapeHtml(row.teamName || row.registrationId)}</td><td>${escapeHtml(row.rollNumber)}</td><td>${escapeHtml(row.studentName)}</td><td>${escapeHtml(row.paymentStatus || "—")}</td><td>${row.screenshotKey ? `<button type="button" data-admin-screenshot="${escapeAttribute(row.screenshotKey)}">Open securely</button>` : "—"}</td></tr>`).join("")}</tbody></table>${data.registrations.length ? "" : '<p class="muted">No matching registrations.</p>'}`;
}

async function adminStatus() {
  try {
    const status = await apiRequest("/api/admin/status");
    document.querySelector("[data-admin-status]").textContent = status.message;
  } catch (error) {
    document.querySelector("[data-admin-status]").textContent = `Admin access or workbook unavailable: ${error.message}`;
  }
}

async function adminSearch() {
  const params = new URLSearchParams();
  const event = document.querySelector("#admin-event").value;
  const search = document.querySelector("#admin-search").value.trim();
  if (event) params.set("event", event);
  if (search) params.set("q", search);
  try {
    const result = await apiRequest(`/api/admin/registrations?${params}`);
    renderAdminResults(result);
  } catch (error) {
    document.querySelector("#admin-results").textContent = `Unable to load registrations: ${error.message}`;
  }
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.goStage) goToStage(target.dataset.goStage);
  if (target.hasAttribute("data-add-student")) openStudentModal();
  if (target.dataset.editStudent) openStudentModal(state.students.find(({ id }) => id === target.dataset.editStudent));
  if (target.dataset.removeStudent) {
    const id = target.dataset.removeStudent;
    state.students = state.students.filter((student) => student.id !== id);
    for (const eventState of Object.values(state.events)) eventState.selected = eventState.selected.filter((studentId) => studentId !== id);
    saveDraft();
    render();
  }
  if (target.hasAttribute("data-details-next")) {
    const name = document.querySelector("#team-name").value.trim();
    if (!name || !state.students.length) {
      app.innerHTML = `${renderProgress()}${renderDetails("Enter a team name and add at least one complete student record.")}`;
      return;
    }
    state.teamName = name;
    state.events.cricket.status = "upcoming";
    state.currentStage = "cricket";
    saveDraft();
    render();
  }
  if (target.hasAttribute("data-skip")) {
    const eventKey = state.currentStage;
    state.events[eventKey].status = "skipped";
    state.events[eventKey].payload = null;
    const nextIndex = STAGES.findIndex(({ key }) => key === eventKey) + 1;
    state.currentStage = nextIndex === STAGES.length ? "thankyou" : STAGES[nextIndex].key;
    saveDraft();
    render();
  }
  if (target.dataset.submitEvent) submitEvent(target.dataset.submitEvent);
  if (target.hasAttribute("data-remove-screenshot")) {
    selectedScreenshot = null;
    state.events.cricket.screenshotReference = "";
    state.events.cricket.uploadId = "";
    state.events.cricket.payload = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    saveDraft();
    render();
  }
  if (target.hasAttribute("data-admin-refresh")) adminStatus();
  if (target.hasAttribute("data-admin-search")) adminSearch();
  if (target.hasAttribute("data-admin-download")) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/workbook`, { credentials: "include" });
      if (!response.ok) throw new Error((await response.json()).error || "Workbook download failed.");
      const file = await response.blob();
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "HTC_Registrations.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { document.querySelector("[data-admin-status]").textContent = error.message; }
  }
  if (target.hasAttribute("data-admin-pending")) {
    try {
      const result = await apiRequest("/api/admin/retry-pending", { method: "POST" });
      document.querySelector("[data-admin-status]").textContent = `Retried ${result.retried} pending update(s); ${result.remaining} remain.`;
    } catch (error) { document.querySelector("[data-admin-status]").textContent = error.message; }
  }
  if (target.dataset.adminScreenshot) {
    const url = `${API_BASE_URL}/api/admin/screenshot?key=${encodeURIComponent(target.dataset.adminScreenshot)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches("#team-name")) {
    state.teamName = target.value;
    saveDraft();
    const next = app.querySelector("[data-details-next]");
    if (next) next.disabled = !target.value.trim() || state.students.length === 0;
  }
  if (target.matches("[data-select-student]")) {
    const eventKey = state.currentStage;
    const eventState = state.events[eventKey];
    const studentId = target.dataset.selectStudent;
    if (target.checked) {
      const max = EVENTS.find(({ key }) => key === eventKey).teamSize;
      if (max && eventState.selected.length >= max) target.checked = false;
      else eventState.selected.push(studentId);
    } else {
      eventState.selected = eventState.selected.filter((id) => id !== studentId);
    }
    saveDraft();
    render();
  }
  if (target.matches("[data-eligibility]")) {
    state.eligibilityConfirmed = target.checked;
    saveDraft();
  }
  if (target.matches("#payment-file")) {
    const file = target.files[0];
    const validationError = validateScreenshot(file);
    if (validationError) {
      showMessage(validationError);
      target.value = "";
      return;
    }
    selectedScreenshot = file;
    const eventState = state.events.cricket;
    eventState.screenshotReference = "";
    if (!eventState.uploadPending || !eventState.uploadId) eventState.uploadId = crypto.randomUUID();
    eventState.payload = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    saveDraft();
    render();
  }
});

app.addEventListener("input", (event) => {
  if (event.target.matches("#team-name")) {
    state.teamName = event.target.value;
    saveDraft();
    const next = app.querySelector("[data-details-next]");
    if (next) next.disabled = !event.target.value.trim() || state.students.length === 0;
  }
});

modalForm.addEventListener("submit", onStudentModalSubmit);
modalForm.addEventListener("change", (event) => {
  if (event.target.matches('[name="branch"]')) {
    modal.querySelector(".other-branch-field").classList.toggle("hidden", event.target.value !== "Other");
  }
});
modal.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-modal]")) modal.close();
});
modal.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => modal.close()));

if (new URLSearchParams(location.search).has("admin")) {
  renderAdmin();
} else {
  render();
}
