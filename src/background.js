"use strict";

const SELL_URL = "https://www.vinted.co.uk/items/new";
const BACKUP_PREFIX = "vra_backup_";
const BACKUP_INDEX_KEY = "vra_backup_index";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const DB_NAME = "vinted-relist-assistant";
const DB_VERSION = 1;
const IMAGE_STORE = "images";

const activeRuns = new Map();
let backupIndexWrite = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  cleanupExpiredBackups().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "START_RELIST") {
    startRelistWorkflow(message, sender).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_BACKUPS") {
    getBackups()
      .then((backups) => sendResponse({ ok: true, backups }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "CLEAR_EXPIRED") {
    cleanupExpiredBackups()
      .then(() => getBackups())
      .then((backups) => sendResponse({ ok: true, backups }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

async function startRelistWorkflow(message, sender) {
  const originTabId = sender && sender.tab && sender.tab.id;
  const itemId = String(message.itemId || "").trim();
  const itemUrl = String(message.itemUrl || "").trim();
  const workflowId = cleanWorkflowId(message.workflowId) || createWorkflowId(itemId || "unknown");

  if (!originTabId || !itemId || !itemUrl) {
    await safeNotify(originTabId, {
      type: "WORKFLOW_STATUS",
      status: "failed",
      workflowId,
      itemId,
      kind: "error",
      message: "Cloning failed because the item ID or listing URL could not be read."
    });
    return;
  }

  const context = { workflowId, itemId, itemUrl, cardTitle: message.cardTitle || "", originTabId };
  const run = runWorkflow(context)
    .catch(() => {})
    .finally(() => {
      activeRuns.delete(workflowId);
    });

  activeRuns.set(workflowId, {
    itemId,
    originTabId,
    startedAt: new Date().toISOString(),
    run
  });

  await run;
}

async function runWorkflow(context) {
  let backup = null;
  let tempTabId = null;
  let sellTabId = null;

  try {
    await cleanupExpiredBackups();

    backup = createInitialBackup(context);
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "started", "Started cloning this listing.");

    const tempTab = await tabsCreate({ url: context.itemUrl, active: false, openerTabId: context.originTabId });
    tempTabId = tempTab.id;
    backup.status = "item_page_opened";
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "item_page_opened", "Opened the listing page for extraction.");

    await waitForTabComplete(tempTabId, 30000);
    await delay(100);
    const extraction = await executeExtractor(tempTabId);
    if (!extraction || !extraction.ok) {
      throw new WorkflowError("extract_listing", extraction && extraction.error ? extraction.error : "Could not extract listing data.");
    }

    backup = mergeExtractedData(backup, extraction.data || {});
    backup.warnings.push(...normalizeMessages(extraction.warnings));
    backup.status = "extracted";
    await saveBackup(backup);
    validateExtractedBackup(backup);
    backup.status = "backup_saved";
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "backup_saved", "Listing data was saved locally.");

    await cacheImagesForBackup(backup);
    backup.status = "images_cached";
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "images_cached", "Images were cached locally.");

    await closeTabIfOpen(tempTabId);
    tempTabId = null;

    const sellTab = await tabsCreate({ url: SELL_URL, active: true, openerTabId: context.originTabId });
    sellTabId = sellTab.id;
    backup.status = "sell_page_opened";
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "sell_page_opened", "Opened the new listing form.");

    await waitForTabComplete(sellTabId, 45000);
    await delay(250);
    await executeScriptFile(sellTabId, "src/fill-form.js");

    const imageDataUrls = await getImageDataUrlsForBackup(backup);
    const fillResponse = await sendTabMessage(sellTabId, {
      type: "FILL_FROM_BACKUP",
      backup: publicBackupForFill(backup),
      imageDataUrls
    });

    const fillWarnings = normalizeMessages(fillResponse && fillResponse.warnings);
    if (fillResponse && Array.isArray(fillResponse.debug)) {
      backup.fillDebug = fillResponse.debug;
      await saveBackup(backup);
    }
    if (fillWarnings.length) {
      backup.warnings.push(...fillWarnings);
      await saveBackup(backup);
    }

    if (!fillResponse || !fillResponse.ok) {
      throw new WorkflowError("fill_form", fillResponse && fillResponse.error ? fillResponse.error : "Could not fill the new listing form.");
    }

    backup.status = "form_filled";
    await saveBackup(backup);
    await notifyStatus(context.originTabId, backup, "form_filled", "Listing cloned and checked in the new form. Please review it manually before posting.", "success");
    await notifyStatus(sellTabId, backup, "form_filled", "Listing cloned and checked in the new form. Please review the details and images manually before posting.", "success");
  } catch (error) {
    if (backup) {
      backup.status = "failed";
      backup.errors.push({
        step: error.step || "workflow",
        message: error.message || String(error),
        timestamp: new Date().toISOString()
      });
      await saveBackup(backup).catch(() => {});
    }

    const failedDetail = error && error.message ? ` ${error.message}` : "";
    const failedMessage = `Cloning failed.${failedDetail} The extracted listing information has been saved locally where possible so you can retry or recover it.`;
    await safeNotify(context.originTabId, {
      type: "WORKFLOW_STATUS",
      status: "failed",
      workflowId: context.workflowId,
      itemId: context.itemId,
      backupId: backup && backup.id,
      kind: "error",
      message: failedMessage
    });
    if (sellTabId) {
      await safeNotify(sellTabId, {
        type: "WORKFLOW_STATUS",
        status: "failed",
        workflowId: context.workflowId,
        itemId: context.itemId,
        backupId: backup && backup.id,
        kind: "error",
        message: failedMessage
      });
    }
  } finally {
    if (tempTabId) await closeTabIfOpen(tempTabId);
  }
}

function createInitialBackup(context) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  return {
    id: context.workflowId || `vra-${context.itemId}-${now}`,
    workflowId: context.workflowId,
    itemId: context.itemId,
    sourceUrl: context.itemUrl,
    cardTitle: context.cardTitle || "",
    createdAt,
    expiresAt: new Date(now + RETENTION_MS).toISOString(),
    title: "",
    description: "",
    price: {
      amount: "",
      currency: ""
    },
    attributes: {},
    extractDebug: null,
    images: [],
    status: "started",
    warnings: [],
    errors: []
  };
}

function mergeExtractedData(backup, data) {
  return {
    ...backup,
    itemId: data.itemId || backup.itemId,
    sourceUrl: data.sourceUrl || backup.sourceUrl,
    title: data.title || backup.title,
    description: data.description || backup.description,
    price: {
      amount: data.price && data.price.amount ? String(data.price.amount) : backup.price.amount,
      currency: data.price && data.price.currency ? String(data.price.currency) : backup.price.currency
    },
    attributes: {
      ...backup.attributes,
      ...(data.attributes || {})
    },
    extractDebug: data.extractDebug || backup.extractDebug,
    images: Array.isArray(data.images) ? data.images.map((image, index) => ({
      index,
      originalUrl: image.originalUrl || image.url || "",
      cachedBlobId: image.cachedBlobId,
      filename: image.filename,
      mimeType: image.mimeType
    })).filter((image) => image.originalUrl) : backup.images
  };
}

function validateExtractedBackup(backup) {
  if (!backup.title) throw new WorkflowError("extract_title", "Could not extract title.");
  if (!backup.description) throw new WorkflowError("extract_description", "Could not extract description.");
  if (!backup.price || !backup.price.amount) throw new WorkflowError("extract_price", "Could not extract price.");
  if (!backup.images.length) throw new WorkflowError("extract_images", "Could not extract images.");
}

async function executeExtractor(tabId) {
  const results = await executeScriptFile(tabId, "src/extract-listing.js");
  return results && results[0] ? results[0].result : null;
}

async function cacheImagesForBackup(backup) {
  const results = await Promise.all(backup.images.map(async (image) => {
    try {
      const response = await fetch(image.originalUrl, {
        cache: "no-store",
        credentials: "include"
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const mimeType = blob.type || response.headers.get("content-type") || "application/octet-stream";
      const cachedBlobId = `${backup.id}-image-${image.index}`;
      const filename = image.filename || filenameForImage(backup.itemId, image.index, image.originalUrl, mimeType);

      await putImageRecord({
        id: cachedBlobId,
        backupId: backup.id,
        itemId: backup.itemId,
        index: image.index,
        originalUrl: image.originalUrl,
        filename,
        mimeType,
        blob,
        createdAt: backup.createdAt,
        expiresAt: backup.expiresAt
      });

      return {
        ok: true,
        index: image.index,
        cachedBlobId,
        filename,
        mimeType
      };
    } catch (error) {
      return {
        ok: false,
        index: image.index,
        error
      };
    }
  }));

  const failures = results.filter((result) => !result.ok);
  for (const result of results) {
    if (!result.ok) continue;
    const image = backup.images.find((candidate) => candidate.index === result.index);
    if (!image) continue;
    image.cachedBlobId = result.cachedBlobId;
    image.filename = result.filename;
    image.mimeType = result.mimeType;
  }

  await saveBackup(backup);

  if (failures.length) {
    throw new WorkflowError("cache_images", `Could not cache all images. ${failures.length} of ${backup.images.length} failed.`);
  }
}

async function getImageDataUrlsForBackup(backup) {
  const output = await Promise.all(backup.images.map(async (image) => {
    if (!image.cachedBlobId) {
      throw new WorkflowError("load_cached_images", "A cached image was missing from the backup.");
    }
    const record = await getImageRecord(image.cachedBlobId);
    if (!record || !record.blob) {
      throw new WorkflowError("load_cached_images", "A cached image blob could not be read.");
    }
    return {
      index: image.index,
      filename: image.filename || record.filename || filenameForImage(backup.itemId, image.index, image.originalUrl, record.mimeType),
      mimeType: image.mimeType || record.mimeType || record.blob.type || "application/octet-stream",
      dataUrl: await blobToDataUrl(record.blob)
    };
  }));
  return output.sort((a, b) => a.index - b.index);
}

function publicBackupForFill(backup) {
  return {
    id: backup.id,
    workflowId: backup.workflowId || backup.id,
    itemId: backup.itemId,
    sourceUrl: backup.sourceUrl,
    cardTitle: backup.cardTitle,
    title: backup.title,
    description: backup.description,
    price: backup.price,
    attributes: backup.attributes,
    images: backup.images.map((image) => ({
      index: image.index,
      originalUrl: image.originalUrl,
      cachedBlobId: image.cachedBlobId,
      filename: image.filename,
      mimeType: image.mimeType
    }))
  };
}

function filenameForImage(itemId, index, url, mimeType) {
  const extensionFromMime = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  }[String(mimeType || "").toLowerCase()];

  const extensionFromUrl = (() => {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-z0-9]{3,4})$/i);
      return match ? match[1].toLowerCase() : "";
    } catch (_error) {
      return "";
    }
  })();

  return `vinted-${itemId}-${index + 1}.${extensionFromMime || extensionFromUrl || "jpg"}`;
}

async function notifyStatus(tabId, backup, status, message, kind) {
  await safeNotify(tabId, {
    type: "WORKFLOW_STATUS",
    status,
    workflowId: backup.workflowId || backup.id,
    itemId: backup.itemId,
    backupId: backup.id,
    kind: kind || "info",
    message
  });
}

async function safeNotify(tabId, payload) {
  if (!tabId) return;
  try {
    await sendTabMessage(tabId, payload);
  } catch (_error) {
    // The source tab may have navigated away. The backup still holds the status.
  }
}

async function getBackups() {
  await cleanupExpiredBackups();
  const all = await storageGet(null);
  return Object.keys(all)
    .filter((key) => key.startsWith(BACKUP_PREFIX))
    .map((key) => all[key])
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

async function saveBackup(backup) {
  await storageSet({ [`${BACKUP_PREFIX}${backup.id}`]: backup });
  backupIndexWrite = backupIndexWrite
    .catch(() => {})
    .then(() => addBackupToIndex(backup.id));
  await backupIndexWrite;
}

async function addBackupToIndex(backupId) {
  const current = await storageGet(BACKUP_INDEX_KEY);
  const index = Array.isArray(current[BACKUP_INDEX_KEY]) ? current[BACKUP_INDEX_KEY] : [];
  const nextIndex = [backupId].concat(index.filter((id) => id !== backupId)).slice(0, 30);
  await storageSet({ [BACKUP_INDEX_KEY]: nextIndex });
}

async function cleanupExpiredBackups() {
  const all = await storageGet(null);
  const now = Date.now();
  const removeKeys = [];
  const expiredBackupIds = new Set();

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(BACKUP_PREFIX) || !value) continue;
    const expiresAt = Date.parse(value.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      removeKeys.push(key);
      expiredBackupIds.add(value.id);
    }
  }

  if (removeKeys.length) {
    await storageRemove(removeKeys);
  }

  const index = Array.isArray(all[BACKUP_INDEX_KEY]) ? all[BACKUP_INDEX_KEY] : [];
  const nextIndex = index.filter((id) => !expiredBackupIds.has(id));
  if (nextIndex.length !== index.length) {
    await storageSet({ [BACKUP_INDEX_KEY]: nextIndex });
  }

  await deleteExpiredImageRecords(now, expiredBackupIds);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => String(message || "").trim()).filter(Boolean);
}

function createWorkflowId(itemId) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `vra-${itemId}-${Date.now()}-${randomPart}`;
}

function cleanWorkflowId(value) {
  const text = String(value || "").trim();
  return text && /^[a-z0-9_-]+$/i.test(text) ? text : "";
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function closeTabIfOpen(tabId) {
  try {
    await tabsRemove(tabId);
  } catch (_error) {
    // Already closed or inaccessible.
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new WorkflowError("open_page", "Timed out waiting for the Vinted page to load."));
    }, timeoutMs);

    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        cleanup();
        reject(new WorkflowError("open_page", error.message));
      } else if (tab && tab.status === "complete") {
        cleanup();
        resolve();
      }
    });
  });
}

function executeScriptFile(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [file] }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(results || []);
    });
  });
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error || new Error("Could not open image cache."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function putImageRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readwrite");
    transaction.objectStore(IMAGE_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save image blob."));
  });
}

async function getImageRecord(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readonly");
    const request = transaction.objectStore(IMAGE_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read image blob."));
  });
}

async function deleteExpiredImageRecords(now, expiredBackupIds) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readwrite");
    const store = transaction.objectStore(IMAGE_STORE);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value;
      const expiresAt = Date.parse(record.expiresAt || "");
      if ((Number.isFinite(expiresAt) && expiresAt <= now) || expiredBackupIds.has(record.backupId)) {
        cursor.delete();
      }
      cursor.continue();
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not clean image cache."));
  });
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WorkflowError extends Error {
  constructor(step, message) {
    super(message);
    this.name = "WorkflowError";
    this.step = step;
  }
}
