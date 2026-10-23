const HTC_UPLOAD_ROOT_FOLDER = "HTC Registrations";
const HTC_PAYMENT_FOLDER = "Cricket Payment Screenshots";
const HTC_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const HTC_MAX_BASE64_LENGTH = Math.ceil(HTC_MAX_SCREENSHOT_BYTES / 3) * 4;

function handleDriveScreenshotUploadRequest_(e) {
  let payload;
  try {
    payload = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : "");
  } catch (error) {
    return null;
  }
  if (!payload) return null;
  if (payload.action !== "uploadScreenshot") return null;

  if (payload.event !== "cricket") {
    return driveUploadJsonResponse_({ success: false, message: "Screenshot uploads are only supported for Cricket." });
  }

  try {
    return uploadDriveScreenshot_(payload);
  } catch (error) {
    console.error("Payment screenshot upload failed.");
    return driveUploadJsonResponse_({
      success: false,
      message: "The payment screenshot could not be stored. Please retry.",
    });
  }
}

function uploadDriveScreenshot_(payload) {
  const registrationId = String(payload.registrationId || "");
  const uploadId = String(payload.uploadId || "");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(registrationId) || !uuidPattern.test(uploadId)) {
    return driveUploadJsonResponse_({ success: false, message: "Invalid screenshot upload reference." });
  }

  const mimeType = String(payload.mimeType || "").toLowerCase();
  const base64 = String(payload.base64 || "");
  const sha256 = String(payload.sha256 || "").toLowerCase();
  if (!/^(image\/jpeg|image\/png|image\/webp)$/.test(mimeType)) {
    return driveUploadJsonResponse_({ success: false, message: "Only JPG, PNG, and WebP screenshots are accepted." });
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return driveUploadJsonResponse_({ success: false, message: "The screenshot integrity check is invalid." });
  }
  if (base64.length > HTC_MAX_BASE64_LENGTH || !isValidBase64_(base64)) {
    return driveUploadJsonResponse_({ success: false, message: "The screenshot data is invalid or larger than 5 MB." });
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (error) {
    return driveUploadJsonResponse_({ success: false, message: "The screenshot data could not be decoded." });
  }
  if (!bytes.length || bytes.length > HTC_MAX_SCREENSHOT_BYTES || !isExpectedImageType_(bytes, mimeType)) {
    return driveUploadJsonResponse_({ success: false, message: "The image content does not match an accepted format or size." });
  }
  if (sha256Hex_(bytes) !== sha256) {
    return driveUploadJsonResponse_({ success: false, message: "The screenshot integrity check failed." });
  }

  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
  const fileName = "HTC-Payment-" + registrationId + "-" + uploadId + "." + extension;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return driveUploadJsonResponse_({ success: false, message: "The upload service is busy. Please retry shortly." });
  }
  try {
    const paymentFolder = getPrivatePaymentFolder_();
    const existing = paymentFolder.getFilesByName(fileName);
    if (existing.hasNext()) {
      const existingFile = existing.next();
      if (!existingFile.getDescription().includes("; sha256 " + sha256)) {
        return driveUploadJsonResponse_({
          success: false,
          requiresNewUploadId: true,
          message: "This retry ID was used for a different screenshot. Retry with the selected screenshot again.",
        });
      }
      return driveUploadJsonResponse_({
        success: true,
        screenshotReference: existingFile.getId(),
        alreadyUploaded: true,
      });
    }
    const blob = Utilities.newBlob(bytes, mimeType, fileName);
    const file = paymentFolder.createFile(blob);
    file.setDescription("HTC Club payment screenshot; registration " + registrationId + "; upload " + uploadId + "; sha256 " + sha256);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    return driveUploadJsonResponse_({
      success: true,
      screenshotReference: file.getId(),
      alreadyUploaded: false,
    });
  } finally {
    lock.releaseLock();
  }
}

function isValidBase64_(value) {
  if (!value || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      return false;
    }
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charAt(index) !== "=") return false;
  }
  return true;
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (byte) {
      return ("0" + ((byte + 256) % 256).toString(16)).slice(-2);
    })
    .join("");
}

function getPrivatePaymentFolder_() {
  const rootFolder = getOrCreatePrivateFolder_(DriveApp.getRootFolder(), HTC_UPLOAD_ROOT_FOLDER);
  return getOrCreatePrivateFolder_(rootFolder, HTC_PAYMENT_FOLDER);
}

function isUploadedScreenshotReference_(registrationId, fileId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(registrationId || ""))
    || typeof fileId !== "string" || !fileId) {
    return false;
  }
  try {
    const file = DriveApp.getFileById(fileId);
    const namePrefix = "HTC-Payment-" + registrationId + "-";
    const uploadMarker = "; upload ";
    if (!file.getName().startsWith(namePrefix)
      || !file.getDescription().includes("; registration " + registrationId + uploadMarker)
      || file.getSharingAccess() !== DriveApp.Access.PRIVATE
      || file.getSharingPermission() !== DriveApp.Permission.NONE) {
      return false;
    }
    const paymentFolderId = getPrivatePaymentFolder_().getId();
    const parents = file.getParents();
    while (parents.hasNext()) {
      if (parents.next().getId() === paymentFolderId) return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

function getOrCreatePrivateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) {
    const existing = folders.next();
    if (existing.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      throw new Error("The configured payment folder is not private.");
    }
    return existing;
  }
  const folder = parent.createFolder(name);
  folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return folder;
}

function isExpectedImageType_(bytes, mimeType) {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && (bytes[0] & 255) === 0xff && (bytes[1] & 255) === 0xd8 && (bytes[2] & 255) === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8
      && (bytes[0] & 255) === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }
  return mimeType === "image/webp"
    && bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

function driveUploadJsonResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
