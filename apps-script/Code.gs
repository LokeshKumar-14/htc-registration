const CONFIG = {
  SPREADSHEET_ID: "10JIrqL-B8Jpg45CbRoffnIqRNjoqD8JqKvyuSov6vvQ",

  SHEETS: {
    cricket: "Cricket",
    football: "Football",
    cyclothon: "Cyclothon",
    treasurehunt: "Treasure Hunt"
  }
};

const HEADERS = {
  cricket: [
    "Registration ID",
    "Timestamp",
    "Team Name",
    "Roll Number",
    "Student Name",
    "Phone Number",
    "Branch",
    "Year",
    "College Name"
  ],

  football: [
    "Registration ID",
    "Timestamp",
    "Team Name",
    "Roll Number",
    "Student Name",
    "Phone Number",
    "Branch",
    "Year",
    "College Name"
  ],

  cyclothon: [
    "Registration ID",
    "Timestamp",
    "Roll Number",
    "Student Name",
    "Phone Number",
    "Branch",
    "Year",
    "College Name"
  ],

  treasurehunt: [
    "Registration ID",
    "Timestamp",
    "Team Name",
    "Roll Number",
    "Student Name",
    "Phone Number",
    "Branch",
    "Year",
    "Girl Eligibility Declaration",
    "Boy Eligibility Declaration",
    "College Name"
  ]
};

function setupSheets() {
  const ss = getSpreadsheet_();

  Object.keys(CONFIG.SHEETS).forEach(function (eventKey) {
    const sheetName = CONFIG.SHEETS[eventKey];
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    if (sheet.getLastRow() === 0) {
      const headers = HEADERS[eventKey];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeader_(sheet, headers.length);
      return;
    }

    ensureRegistrationHeaders_(sheet, eventKey);
  });

  return {
    success: true,
    message: "HTC registration sheets initialized."
  };
}

function styleHeader_(sheet, columnCount) {
  sheet.getRange(1, 1, 1, columnCount)
    .setFontWeight("bold")
    .setBackground("#111111")
    .setFontColor("#ffffff");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, columnCount);
}

function ensureRegistrationHeaders_(sheet, eventKey) {
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) {
    throw new Error("Could not find the existing sheet headers.");
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const requiredHeaders = ["College Name"];
  if (eventKey === "treasurehunt") {
    requiredHeaders.push("Boy Eligibility Declaration");
  }

  requiredHeaders.forEach(function (header) {
    if (headers.indexOf(header) !== -1) {
      return;
    }

    lastColumn += 1;
    sheet.getRange(1, lastColumn).setValue(header);
    sheet.getRange(1, lastColumn)
      .setFontWeight("bold")
      .setBackground("#111111")
      .setFontColor("#ffffff");
    sheet.autoResizeColumn(lastColumn);
    headers.push(header);
  });
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      message: "HTC Registration API is running."
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const uploadResponse = handleDriveScreenshotUploadRequest_(e);
  if (uploadResponse !== null) {
    return uploadResponse;
  }

  const lock = LockService.getScriptLock();

  try {
    const data = JSON.parse(e.postData.contents || "{}");
    validateRequest_(data);

    lock.waitLock(20000);

    const ss = getSpreadsheet_();
    const eventKey = data.event;
    const sheetName = CONFIG.SHEETS[eventKey];
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      throw new Error("Sheet not found. Run setupSheets() first.");
    }

    ensureRegistrationHeaders_(sheet, eventKey);

    const registrationId = String(data.registrationId).trim();
    if (registrationExists_(sheet, registrationId)) {
      return jsonResponse_({
        success: true,
        duplicate: true,
        registrationId: registrationId,
        message: "This registration has already been saved."
      });
    }

    const rows = createRows_(eventKey, data, new Date(), sheet);
    if (!rows.length) {
      throw new Error("No participant rows were generated.");
    }

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();

    return jsonResponse_({
      success: true,
      registrationId: registrationId,
      message: "Registration saved successfully."
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    return jsonResponse_({
      success: false,
      message: error.message || "Registration failed."
    });
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function getSpreadsheet_() {
  const id = CONFIG.SPREADSHEET_ID;
  if (!id || id === "PASTE_YOUR_SPREADSHEET_ID_HERE") {
    throw new Error("Configure SPREADSHEET_ID in Code.gs.");
  }
  return SpreadsheetApp.openById(id);
}

function validateRequest_(data) {
  const allowedEvents = ["cricket", "football", "cyclothon", "treasurehunt"];
  if (!allowedEvents.includes(data.event)) {
    throw new Error("Invalid event.");
  }

  if (
    typeof data.registrationId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(data.registrationId)
  ) {
    throw new Error("Invalid registration ID.");
  }

  if (!Array.isArray(data.participants) || data.participants.length === 0) {
    throw new Error("Select at least one participant.");
  }

  if (
    typeof data.collegeName !== "string" ||
    !data.collegeName.trim() ||
    data.collegeName.trim().length > 120
  ) {
    throw new Error("Enter a valid college name (1–120 characters).");
  }

  const event = data.event;
  const participants = data.participants;

  if (event === "cricket" || event === "football") {
    if (participants.length !== 5) {
      throw new Error("This event requires exactly 5 participants.");
    }
    validateTeamName_(data.teamName);
  }

  if (event === "treasurehunt") {
    if (participants.length !== 4) {
      throw new Error("Treasure Hunt requires exactly 4 participants.");
    }
    validateTeamName_(data.teamName);
    if (data.girlEligibilityConfirmed !== true) {
      throw new Error("Confirm that your team includes at least one girl.");
    }
    if (data.boyEligibilityConfirmed !== true) {
      throw new Error("Confirm that your team includes at least one boy.");
    }
  }

  if (event === "cyclothon" && participants.length > 100) {
    throw new Error("Cyclothon allows up to 100 participants per registration.");
  }

  const seenRollNumbers = new Set();
  participants.forEach(function (participant) {
    validateParticipant_(participant);

    const roll = String(participant.rollNumber).trim().toUpperCase();
    if (seenRollNumbers.has(roll)) {
      throw new Error("Duplicate participant in this registration.");
    }
    seenRollNumbers.add(roll);
  });
}

function validateTeamName_(teamName) {
  if (
    typeof teamName !== "string" ||
    !teamName.trim() ||
    teamName.trim().length > 100
  ) {
    throw new Error("A valid team name is required.");
  }
}

function validateParticipant_(participant) {
  if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
    throw new Error("Invalid participant.");
  }

  const fields = ["rollNumber", "name", "phone", "branch", "year"];
  fields.forEach(function (field) {
    if (
      typeof participant[field] !== "string" ||
      !participant[field].trim() ||
      participant[field].length > 150
    ) {
      throw new Error("Missing or invalid field: " + field);
    }
  });

  const phone = participant.phone.trim().replace(/[\s()-]/g, "");
  if (!/^(?:\+91)?[6-9]\d{9}$/.test(phone)) {
    throw new Error("Invalid Indian mobile number.");
  }
}

function registrationExists_(sheet, registrationId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  return ids.some(function (row) {
    return row[0] === registrationId;
  });
}

function createRows_(eventKey, data, timestamp, sheet) {
  const teamName = data.teamName || "";
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];

  return data.participants.map(function (participant) {
    const values = {
      "Registration ID": data.registrationId,
      "Timestamp": timestamp,
      "Team Name": teamName,
      "Roll Number": participant.rollNumber,
      "Student Name": participant.name,
      "Phone Number": participant.phone,
      "Branch": participant.branch,
      "Year": participant.year,
      "College Name": data.collegeName.trim(),
      "Girl Eligibility Declaration": eventKey === "treasurehunt"
        ? "Confirmed by registrant"
        : "",
      "Boy Eligibility Declaration": eventKey === "treasurehunt"
        ? "Confirmed by registrant"
        : "",
      "Payment Amount": "",
      "Payment Status": "",
      "Screenshot Reference": "",
      "Screenshot Object Reference": ""
    };

    return headers.map(function (header) {
      return Object.prototype.hasOwnProperty.call(values, header) ? values[header] : "";
    });
  });
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
