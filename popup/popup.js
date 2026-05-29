"use strict";

const summary = document.getElementById("summary");
const backupList = document.getElementById("backup-list");
const refreshButton = document.getElementById("refresh");
const clearExpiredButton = document.getElementById("clear-expired");

refreshButton.addEventListener("click", loadBackups);
clearExpiredButton.addEventListener("click", clearExpired);

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

function clearExpired() {
  sendMessage({ type: "CLEAR_EXPIRED" })
    .then((response) => {
      if (!response.ok) throw new Error(response.error || "Could not clear expired backups.");
      renderBackups(response.backups || []);
    })
    .catch((error) => {
      summary.textContent = error.message || String(error);
    });
}

function renderBackups(backups) {
  if (!backups.length) {
    summary.textContent = "No recent backups saved in the last 24 hours.";
    backupList.innerHTML = '<p class="empty">Relist attempts will appear here.</p>';
    return;
  }

  summary.textContent = `${backups.length} recent backup${backups.length === 1 ? "" : "s"} saved locally.`;
  backupList.innerHTML = "";

  for (const backup of backups) {
    const card = document.createElement("article");
    card.className = "backup";

    const title = document.createElement("h2");
    title.textContent = backup.title || backup.cardTitle || `Item ${backup.itemId}`;

    const status = document.createElement("span");
    status.className = `status-pill ${backup.status || ""}`;
    status.textContent = backup.status || "unknown";

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${formatDate(backup.createdAt)} - ${backup.itemId || "unknown item"}`;

    const details = document.createElement("p");
    details.className = "details";
    details.textContent = `${backup.images ? backup.images.length : 0} image(s), ${backup.price && backup.price.amount ? backup.price.amount : "no price"} ${backup.price && backup.price.currency ? backup.price.currency : ""}`.trim();

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy JSON";
    copyButton.addEventListener("click", () => copyBackup(backup, copyButton));
    actions.appendChild(copyButton);

    card.appendChild(title);
    card.appendChild(status);
    card.appendChild(meta);
    card.appendChild(details);
    card.appendChild(renderMessages(backup));
    card.appendChild(actions);
    backupList.appendChild(card);
  }
}

function renderMessages(backup) {
  const container = document.createElement("div");
  container.className = "messages";

  const errors = Array.isArray(backup.errors) ? backup.errors : [];
  const warnings = Array.isArray(backup.warnings) ? backup.warnings : [];

  for (const error of errors.slice(-3)) {
    const line = document.createElement("p");
    line.className = "message";
    line.textContent = `${error.step || "error"}: ${error.message || String(error)}`;
    container.appendChild(line);
  }

  for (const warning of warnings.slice(-3)) {
    const line = document.createElement("p");
    line.className = "message warning";
    line.textContent = warning;
    container.appendChild(line);
  }

  if (!container.childElementCount) {
    const line = document.createElement("p");
    line.className = "message warning";
    line.textContent = "No errors recorded.";
    container.appendChild(line);
  }

  return container;
}

function copyBackup(backup, button) {
  const json = JSON.stringify(backup, null, 2);
  navigator.clipboard.writeText(json)
    .then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy JSON";
      }, 1400);
    })
    .catch(() => {
      button.textContent = "Copy failed";
      window.setTimeout(() => {
        button.textContent = "Copy JSON";
      }, 1400);
    });
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
  return date.toLocaleString();
}
