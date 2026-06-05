"use strict";

const summary = document.getElementById("summary");
const backupList = document.getElementById("backup-list");
const refreshButton = document.getElementById("refresh");
const clearExpiredButton = document.getElementById("clear-expired");
const imageModal = createImageModal();

refreshButton.addEventListener("click", loadBackups);
clearExpiredButton.addEventListener("click", clearAllBackups);

loadBackups();

function loadBackups() {
  sendMessage({ type: "GET_BACKUPS" })
    .then((response) => {
      if (!response.ok) throw new Error(response.error || "Could not load backups.");
      renderBackups(response.backups || []);
    })
    .catch((error) => {
      summary.textContent = error.message || String(error);
      backupList.innerHTML = "";
    });
}

function clearAllBackups() {
  clearExpiredButton.disabled = true;
  clearExpiredButton.textContent = "Clearing...";
  sendMessage({ type: "CLEAR_ALL_BACKUPS" })
    .then((response) => {
      if (!response.ok) throw new Error(response.error || "Could not clear backups.");
      renderBackups(response.backups || []);
    })
    .catch((error) => {
      summary.textContent = error.message || String(error);
    })
    .finally(() => {
      clearExpiredButton.disabled = false;
      clearExpiredButton.textContent = "Clear all";
    });
}

function renderBackups(backups) {
  const displayBackups = backups.filter(isDisplayableBackup);
  if (!displayBackups.length) {
    summary.textContent = "No recent backups saved in the last 24 hours.";
    backupList.innerHTML = '<p class="empty">Relist attempts will appear here.</p>';
    return;
  }

  summary.textContent = `${displayBackups.length} recent backup${displayBackups.length === 1 ? "" : "s"} saved locally.`;
  backupList.innerHTML = "";

  for (const backup of displayBackups) {
    const card = document.createElement("article");
    card.className = "backup";

    const title = document.createElement("h2");
    title.textContent = backup.title || backup.cardTitle || `Item ${backup.itemId}`;

    const status = document.createElement("span");
    status.className = `status-pill ${backup.status || ""}`;
    status.textContent = formatStatus(backup.status);

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = formatDate(backup.createdAt);

    const details = document.createElement("p");
    details.className = "details";
    details.textContent = backupSummary(backup);

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy details";
    copyButton.addEventListener("click", () => copyBackup(backup, copyButton));
    actions.appendChild(copyButton);

    card.appendChild(title);
    card.appendChild(row(status, meta));
    card.appendChild(renderImagePreview(backup));
    card.appendChild(details);
    card.appendChild(renderMessages(backup));
    card.appendChild(actions);
    backupList.appendChild(card);
  }
}

function isDisplayableBackup(backup) {
  if (!backup || !backup.createdAt || !backup.itemId) return false;
  if (backup.title || backup.cardTitle || backup.description) return true;
  if (backup.price && backup.price.amount) return true;
  if (backup.attributes && Object.values(backup.attributes).some(Boolean)) return true;
  return Array.isArray(backup.images) && backup.images.some((image) => image && image.originalUrl);
}

function row(...children) {
  const element = document.createElement("div");
  element.className = "row";
  for (const child of children) element.appendChild(child);
  return element;
}

function backupSummary(backup) {
  const parts = [];
  const price = formatPrice(backup.price);
  if (price) parts.push(price);
  const attributes = backup.attributes || {};
  for (const value of [attributes.brand, attributes.size, attributes.condition, attributes.colour, attributes.material]) {
    if (value) parts.push(value);
  }
  const imageCount = Array.isArray(backup.images) ? backup.images.length : 0;
  if (imageCount) parts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" | ") : "No listing details saved.";
}

function renderImagePreview(backup) {
  const images = Array.isArray(backup.images) ? backup.images.filter((image) => image && image.originalUrl) : [];
  const container = document.createElement("div");
  container.className = "image-strip";

  if (!images.length) {
    container.classList.add("image-strip-empty");
    container.textContent = "No image previews";
    return container;
  }

  const visibleImages = images.slice(0, 5);
  visibleImages.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-thumb";
    button.title = `Open image ${index + 1}`;
    button.addEventListener("click", () => openImageModal(images, index));

    const img = document.createElement("img");
    img.src = image.originalUrl;
    img.alt = `${backup.title || "Listing"} image ${index + 1}`;
    button.appendChild(img);

    if (index === 4 && images.length > 5) {
      const more = document.createElement("span");
      more.className = "image-more";
      more.textContent = `+${images.length - 5}`;
      button.appendChild(more);
    }

    container.appendChild(button);
  });

  return container;
}

function renderMessages(backup) {
  const container = document.createElement("div");
  container.className = "messages";

  const errors = Array.isArray(backup.errors) ? backup.errors : [];
  const warnings = Array.isArray(backup.warnings) ? backup.warnings : [];
  const failedFillFields = new Set();
  const seenMessages = new Set();

  for (const error of errors.slice(-3)) {
    const message = error.message || String(error);
    if (collectFillFailureFields(message, failedFillFields)) continue;

    const text = `${error.step || "error"}: ${message}`;
    const key = normalizeMessageKey(text);
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);

    const line = document.createElement("p");
    line.className = "message";
    line.textContent = text;
    container.appendChild(line);
  }

  for (const warning of warnings.slice(-3)) {
    if (collectFillFailureFields(warning, failedFillFields)) continue;

    const key = normalizeMessageKey(warning);
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);

    const line = document.createElement("p");
    line.className = "message warning";
    line.textContent = warning;
    container.appendChild(line);
  }

  if (failedFillFields.size) {
    container.appendChild(renderFillFailureMessage(failedFillFields));
  }

  if (!container.childElementCount) {
    container.hidden = true;
  }

  return container;
}

function collectFillFailureFields(value, output) {
  const text = String(value || "");
  const match = text.match(/Could not automatically fill:\s*(.+)$/i);
  if (!match) return false;

  match[1]
    .split(/\s*,\s*/)
    .map(formatFieldName)
    .filter(Boolean)
    .forEach((field) => output.add(field));
  return true;
}

function renderFillFailureMessage(fields) {
  const wrapper = document.createElement("div");
  wrapper.className = "message warning fill-failures";

  const title = document.createElement("p");
  title.textContent = "Could not automatically fill:";
  wrapper.appendChild(title);

  const list = document.createElement("ul");
  for (const field of fields) {
    const item = document.createElement("li");
    item.textContent = field;
    list.appendChild(item);
  }
  wrapper.appendChild(list);

  return wrapper;
}

function formatFieldName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function normalizeMessageKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function copyBackup(backup, button) {
  const text = cleanBackupText(backup);
  navigator.clipboard.writeText(text)
    .then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy details";
      }, 1400);
    })
    .catch(() => {
      button.textContent = "Copy failed";
      window.setTimeout(() => {
        button.textContent = "Copy details";
      }, 1400);
    });
}

function cleanBackupText(backup) {
  const attributes = backup.attributes || {};
  const values = [
    backup.title || backup.cardTitle || "",
    backup.description || "",
    formatPrice(backup.price),
    attributes.brand,
    attributes.size,
    attributes.condition,
    attributes.colour,
    attributes.material
  ];

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatPrice(price) {
  if (!price || !price.amount) return "";
  const amount = String(price.amount).trim();
  const currency = String(price.currency || "").trim().toUpperCase();
  if (currency === "GBP") return `£${amount}`;
  return currency ? `${amount} ${currency}` : amount;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || {});
    });
  });
}

function formatDate(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London"
  });
}

function formatStatus(status) {
  const labels = {
    form_filled: "Draft ready",
    failed: "Failed",
    images_cached: "Images cached",
    backup_saved: "Backup saved",
    extracted: "Extracted",
    sell_page_opened: "Draft opened",
    item_page_opened: "Reading listing",
    started: "Started"
  };
  return labels[status] || status || "Unknown";
}

function createImageModal() {
  const modal = document.createElement("div");
  modal.className = "image-modal";
  modal.hidden = true;
  modal.innerHTML = [
    '<div class="image-modal-panel" role="dialog" aria-modal="true" aria-label="Image preview">',
    '  <div class="image-modal-top">',
    '    <span data-image-counter></span>',
    '    <div>',
    '      <a data-image-open target="_blank" rel="noreferrer">Open image</a>',
    '      <button type="button" data-image-close>Close</button>',
    "    </div>",
    "  </div>",
    '  <div class="image-modal-stage">',
    '    <button type="button" data-image-prev>Prev</button>',
    '    <img data-image-large alt="Listing image">',
    '    <button type="button" data-image-next>Next</button>',
    "  </div>",
    "</div>"
  ].join("");

  document.body.appendChild(modal);

  const state = {
    images: [],
    index: 0,
    img: modal.querySelector("[data-image-large]"),
    counter: modal.querySelector("[data-image-counter]"),
    openLink: modal.querySelector("[data-image-open]")
  };

  modal.querySelector("[data-image-close]").addEventListener("click", () => closeImageModal(modal));
  modal.querySelector("[data-image-prev]").addEventListener("click", () => showImage(state, state.index - 1));
  modal.querySelector("[data-image-next]").addEventListener("click", () => showImage(state, state.index + 1));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeImageModal(modal);
  });
  document.addEventListener("keydown", (event) => {
    if (modal.hidden) return;
    if (event.key === "Escape") closeImageModal(modal);
    if (event.key === "ArrowLeft") showImage(state, state.index - 1);
    if (event.key === "ArrowRight") showImage(state, state.index + 1);
  });

  modal.__imageState = state;
  return modal;
}

function openImageModal(images, index) {
  const state = imageModal.__imageState;
  state.images = images;
  imageModal.hidden = false;
  showImage(state, index);
}

function closeImageModal(modal) {
  modal.hidden = true;
}

function showImage(state, index) {
  if (!state.images.length) return;
  state.index = (index + state.images.length) % state.images.length;
  const image = state.images[state.index];
  state.img.src = image.originalUrl;
  state.openLink.href = image.originalUrl;
  state.counter.textContent = `Image ${state.index + 1} of ${state.images.length}`;
}
