import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const REGISTRATION_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
const PNG_HASH = createHash("sha256").update(PNG_BYTES).digest("hex");
const OTHER_PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 3, 4, 5]);
const OTHER_PNG_HASH = createHash("sha256").update(OTHER_PNG_BYTES).digest("hex");

function createAppsScriptContext() {
  const files = new Map();
  let nextId = 0;

  class MockFolder {
    constructor(name) {
      this.name = name;
      this.id = `folder-${name}`;
      this.children = [];
      this.sharingAccess = "PRIVATE";
      this.sharingPermission = "NONE";
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getSharingAccess() { return this.sharingAccess; }
    getSharingPermission() { return this.sharingPermission; }
    setSharing(access, permission) {
      this.sharingAccess = access;
      this.sharingPermission = permission;
    }
    getFoldersByName(name) {
      const matches = this.children.filter((child) => child instanceof MockFolder && child.name === name);
      let index = 0;
      return { hasNext: () => index < matches.length, next: () => matches[index++] };
    }
    createFolder(name) {
      const folder = new MockFolder(name);
      this.children.push(folder);
      return folder;
    }
    getFilesByName(name) {
      const matches = this.children.filter((child) => child instanceof MockFile && child.name === name);
      let index = 0;
      return { hasNext: () => index < matches.length, next: () => matches[index++] };
    }
    createFile(blob) {
      const file = new MockFile(`file-${++nextId}`, blob.name, blob.bytes, this);
      this.children.push(file);
      files.set(file.id, file);
      return file;
    }
  }

  class MockFile {
    constructor(id, name, bytes, parent) {
      this.id = id;
      this.name = name;
      this.bytes = bytes;
      this.parent = parent;
      this.description = "";
      this.sharingAccess = "PRIVATE";
      this.sharingPermission = "NONE";
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getDescription() { return this.description; }
    setDescription(value) { this.description = value; }
    getSharingAccess() { return this.sharingAccess; }
    getSharingPermission() { return this.sharingPermission; }
    setSharing(access, permission) {
      this.sharingAccess = access;
      this.sharingPermission = permission;
    }
    getParents() {
      let returned = false;
      return { hasNext: () => !returned, next: () => { returned = true; return this.parent; } };
    }
  }

  const root = new MockFolder("root");
  const context = {
    console: { error() {} },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(content) {
        return { content, setMimeType(type) { this.mimeType = type; return this; } };
      },
    },
    DriveApp: {
      Access: { PRIVATE: "PRIVATE" },
      Permission: { NONE: "NONE" },
      getRootFolder: () => root,
      getFileById(id) {
        const file = files.get(id);
        if (!file) throw new Error("File missing");
        return file;
      },
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
    },
    Utilities: {
      base64Decode(value) {
        return Array.from(Buffer.from(value, "base64"), (byte) => byte > 127 ? byte - 256 : byte);
      },
      computeDigest(_algorithm, bytes) {
        return Array.from(createHash("sha256").update(Buffer.from(bytes.map((byte) => byte & 255))).digest(), (byte) => byte > 127 ? byte - 256 : byte);
      },
      DigestAlgorithm: { SHA_256: "SHA_256" },
      newBlob(bytes, mimeType, name) {
        return { bytes: Uint8Array.from(bytes, (byte) => byte & 255), mimeType, name };
      },
    },
  };
  vm.runInNewContext("globalThis.__files = null;", context);
  context.__files = files;
  return context;
}

function uploadPayload(overrides = {}) {
  return {
    action: "uploadScreenshot",
    event: "cricket",
    registrationId: REGISTRATION_ID,
    uploadId: UPLOAD_ID,
    mimeType: "image/png",
    sha256: PNG_HASH,
    base64: Buffer.from(PNG_BYTES).toString("base64"),
    ...overrides,
  };
}

function callHandler(context, payload) {
  const event = { postData: { contents: JSON.stringify(payload) } };
  const result = context.handleDriveScreenshotUploadRequest_(event);
  return result ? JSON.parse(result.content) : null;
}

test("Drive upload helper stores private screenshot bytes and returns an idempotent file ID", async () => {
  const context = createAppsScriptContext();
  const source = await readFile(new URL("../../apps-script/DriveUpload.gs", import.meta.url), "utf8");
  vm.runInNewContext(source, context);

  const first = callHandler(context, uploadPayload());
  assert.equal(first.success, true);
  assert.match(first.screenshotReference, /^file-/);
  const [file] = [...context.__files.values()];
  assert.equal(first.screenshotReference, file.getId());
  assert.notEqual(first.screenshotReference, file.name);
  assert.deepEqual(Array.from(file.bytes), Array.from(PNG_BYTES));
  assert.equal(file.sharingAccess, "PRIVATE");
  assert.equal(file.sharingPermission, "NONE");
  assert.match(file.name, new RegExp(`^HTC-Payment-${REGISTRATION_ID}-${UPLOAD_ID}\\.png$`));

  const retry = callHandler(context, uploadPayload());
  assert.equal(retry.alreadyUploaded, true);
  assert.equal(retry.screenshotReference, first.screenshotReference);
  assert.equal(context.__files.size, 1);

  const mismatchedRetry = callHandler(context, uploadPayload({
    sha256: OTHER_PNG_HASH,
    base64: Buffer.from(OTHER_PNG_BYTES).toString("base64"),
  }));
  assert.equal(mismatchedRetry.success, false);
  assert.equal(mismatchedRetry.requiresNewUploadId, true);
  assert.equal(context.__files.size, 1);
});

test("registration hook verifies private Cricket screenshot reference and payment amount", async () => {
  const context = createAppsScriptContext();
  const source = await readFile(new URL("../../apps-script/DriveUpload.gs", import.meta.url), "utf8");
  vm.runInNewContext(source, context);
  const upload = callHandler(context, uploadPayload());

  const valid = callHandler(context, {
    event: "cricket",
    registrationId: REGISTRATION_ID,
    paymentAmount: 50,
    screenshotReference: upload.screenshotReference,
  });
  assert.equal(valid, null);
  const fakeReference = callHandler(context, {
    event: "cricket",
    registrationId: REGISTRATION_ID,
    paymentAmount: 50,
    screenshotReference: "made-up-file-id",
  });
  assert.equal(fakeReference.success, false);
  const wrongAmount = callHandler(context, {
    event: "cricket",
    registrationId: REGISTRATION_ID,
    paymentAmount: 25,
    screenshotReference: upload.screenshotReference,
  });
  assert.equal(wrongAmount.success, false);
});

test("Drive upload handler rejects invalid MIME, malformed digest, and invalid image signatures", async () => {
  const context = createAppsScriptContext();
  const source = await readFile(new URL("../../apps-script/DriveUpload.gs", import.meta.url), "utf8");
  vm.runInNewContext(source, context);
  assert.equal(callHandler(context, uploadPayload({ mimeType: "image/gif" })).success, false);
  assert.equal(callHandler(context, uploadPayload({ sha256: "bad" })).success, false);
  assert.equal(callHandler(context, uploadPayload({ base64: Buffer.from("not PNG").toString("base64") })).success, false);
  assert.equal(callHandler(context, uploadPayload({ event: "football" })).success, false);
  assert.equal(callHandler(context, uploadPayload({ registrationId: "not-a-uuid" })).success, false);
  assert.equal(context.__files.size, 0);
});

test("Drive upload handler rejects images over 5 MiB after base64 decoding", async () => {
  const context = createAppsScriptContext();
  const source = await readFile(new URL("../../apps-script/DriveUpload.gs", import.meta.url), "utf8");
  vm.runInNewContext(source, context);
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG_BYTES.forEach((byte, index) => { tooLarge[index] = byte; });
  const result = callHandler(context, uploadPayload({
    sha256: createHash("sha256").update(tooLarge).digest("hex"),
    base64: tooLarge.toString("base64"),
  }));
  assert.equal(result.success, false);
  assert.match(result.message, /larger than 5 MB|format or size/);
  assert.equal(context.__files.size, 0);
});
