(function () {
  "use strict";

  const BUTTON_ATTR = "data-vra-relist-button";
  const LINK_SELECTOR = [
    'a.new-item-box__overlay[href^="/items/"]',
    'a[data-testid^="product-item-id-"][href*="/items/"]'
  ].join(",");
  const BUTTON_LIKE_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
  const DEFAULT_TEXT = "Relist";
  const READY_TEXT = "Review";
  const STATUS_LABELS = {
    started: "Starting Draft...",
    item_page_opened: "Retrieving Listing Data...",
    backup_saved: "Saved Backup",
    images_cached: "Images Cached...",
    sell_page_opened: "Drafting listing...",
    form_filled: READY_TEXT,
    failed: DEFAULT_TEXT
  };

  const activeButtons = new Map();
  let scanTimer = null;
  let observer = null;

  init();

  function init() {
    injectRelistButtonsOnProfilePage();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("pageshow", scheduleScan);
    chrome.runtime.onMessage.addListener((message) => {
      if (!message) return;
      if (message.type === "WORKFLOW_STATUS") {
        handleWorkflowStatus(message);
      } else if (message.type === "DELETE_STATUS") {
        handleDeleteStatus(message);
      }
    });
  }

  function scheduleScan() {
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(injectRelistButtonsOnProfilePage, 250);
  }

  function injectRelistButtonsOnProfilePage() {
    if (!location.hostname.endsWith("vinted.co.uk")) return;

    const links = Array.from(document.querySelectorAll(LINK_SELECTOR));
    for (const link of links) {
      const itemId = extractItemId(link);
      if (!itemId) continue;

      const href = link.getAttribute("href");
      if (!href) continue;

      const itemUrl = new URL(href, window.location.origin).toString();
      const card = findParentItemCard(link);
      if (!card || card.querySelector(`[${BUTTON_ATTR}]`)) continue;

      const bumpControl = findBumpControl(card);
      if (!bumpControl) continue;

      const button = createRelistButton(itemId, itemUrl, link.getAttribute("title") || "");
      insertButtonNearBumpButton(bumpControl, button);
    }
  }

  function extractItemId(link) {
    const href = link.getAttribute("href") || "";
    const hrefMatch = href.match(/\/items\/(\d+)/);
    if (hrefMatch) return hrefMatch[1];

    const testId = link.getAttribute("data-testid") || "";
    const testIdMatch = testId.match(/product-item-id-(\d+)/);
    return testIdMatch ? testIdMatch[1] : null;
  }

  function findParentItemCard(link) {
    let current = link.parentElement;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      if (current.querySelector && current.querySelector(LINK_SELECTOR) && findBumpControl(current)) {
        return current;
      }
    }
    return null;
  }

  function findBumpControl(root) {
    const controls = Array.from(root.querySelectorAll(BUTTON_LIKE_SELECTOR));
    return controls.find((control) => isVisible(control) && getElementText(control).trim().toLowerCase() === "bump") || null;
  }

  function createRelistButton(itemId, itemUrl, cardTitle) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vra-relist-button";
    button.textContent = DEFAULT_TEXT;
    button.setAttribute(BUTTON_ATTR, "true");
    button.dataset.vraItemId = itemId;
    button.dataset.vraItemUrl = itemUrl;

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (button.dataset.vraDraftTabId) {
        openDraftFromButton(button);
        return;
      }

      const confirmed = await showConfirmation();
      if (!confirmed) return;

      const workflowId = createWorkflowId(itemId);
      button.dataset.vraWorkflowId = workflowId;
      delete button.dataset.vraDraftTabId;
      setButtonStatus(button, "started");
      activeButtons.set(workflowId, button);

      chrome.runtime.sendMessage(
        {
          type: "START_RELIST",
          workflowId,
          itemId,
          itemUrl,
          cardTitle
        },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            setButtonStatus(button, "failed");
            clearButtonWorkflow(button, workflowId);
            showToast(`Could not start relist: ${error.message}`, "error");
            return;
          }

          if (!response || !response.ok) {
            setButtonStatus(button, "failed");
            clearButtonWorkflow(button, workflowId);
            showToast(response && response.error ? response.error : "Could not start relist.", "error");
          }
        }
      );
    });

    return button;
  }

  function openDraftFromButton(button) {
    const tabId = Number(button.dataset.vraDraftTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      showToast("The draft tab could not be found.", "error");
      return;
    }

    chrome.runtime.sendMessage({ type: "OPEN_DRAFT_TAB", tabId }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        showToast(`Could not open draft: ${error.message}`, "error");
        return;
      }

      if (!response || !response.ok) {
        showToast(response && response.error ? response.error : "Could not open draft.", "error");
      }
    });
  }

  function insertButtonNearBumpButton(bumpControl, button) {
    matchBumpButtonSize(bumpControl, button);

    const wrapper = document.createElement("div");
    wrapper.className = "vra-button-wrap";
    wrapper.style.setProperty("--vra-bump-width", button.style.getPropertyValue("--vra-bump-width") || "72px");
    wrapper.style.setProperty("--vra-bump-height", button.style.getPropertyValue("--vra-bump-height") || "32px");
    wrapper.appendChild(button);
    wrapper.appendChild(createResetButton(button));
    wrapper.appendChild(createDeleteButton(button));

    if (bumpControl.parentElement) {
      bumpControl.insertAdjacentElement("afterend", wrapper);
    }
  }

  function createResetButton(relistButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vra-reset-button";
    button.textContent = "↻";
    button.title = "Reset to relist again";
    button.setAttribute("aria-label", "Reset to relist again");
    button.hidden = true;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetButtonForRelist(relistButton);
    });

    return button;
  }

  function createDeleteButton(relistButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vra-delete-button";
    button.textContent = "🗑";
    button.title = "Delete original listing";
    button.setAttribute("aria-label", "Delete original listing");
    button.hidden = true;

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const confirmed = await showDeleteConfirmation();
      if (!confirmed) return;

      button.disabled = true;
      button.textContent = "...";
      chrome.runtime.sendMessage(
        {
          type: "DELETE_LISTING",
          itemId: relistButton.dataset.vraItemId,
          itemUrl: relistButton.dataset.vraItemUrl
        },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            button.disabled = false;
            button.textContent = "🗑";
            showToast(`Could not start delete: ${error.message}`, "error");
            return;
          }

          if (!response || !response.ok) {
            button.disabled = false;
            button.textContent = "🗑";
            showToast(response && response.error ? response.error : "Could not start delete.", "error");
          }
        }
      );
    });

    return button;
  }

  function matchBumpButtonSize(bumpControl, button) {
    const rect = bumpControl.getBoundingClientRect();
    const style = window.getComputedStyle(bumpControl);

    if (rect.width > 0) {
      const width = `${Math.round(rect.width)}px`;
      button.style.setProperty("--vra-bump-width", width);
      button.style.width = width;
    }

    if (rect.height > 0) {
      const height = `${Math.round(rect.height)}px`;
      button.style.setProperty("--vra-bump-height", height);
      button.style.height = height;
    }

    button.style.borderRadius = style.borderRadius;
    button.style.fontSize = style.fontSize;
    button.style.fontWeight = style.fontWeight;
    button.style.lineHeight = style.lineHeight;
  }

  function showConfirmation() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "vra-modal-backdrop";
      backdrop.innerHTML = [
        '<div class="vra-modal" role="dialog" aria-modal="true" aria-labelledby="vra-modal-title">',
        '  <h2 id="vra-modal-title">Clone this listing?</h2>',
        "  <p>This will clone this listing into a new Vinted listing form. It will save a local backup first. It will not delete or submit anything automatically.</p>",
        '  <div class="vra-modal-actions">',
        '    <button type="button" data-vra-cancel>Cancel</button>',
        '    <button type="button" data-vra-confirm>Clone listing</button>',
        "  </div>",
        "</div>"
      ].join("");

      const onKeydown = (event) => {
        if (event.key === "Escape") {
          close(false);
        }
      };

      const close = (result) => {
        document.removeEventListener("keydown", onKeydown);
        backdrop.remove();
        resolve(result);
      };

      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close(false);
      });
      backdrop.querySelector("[data-vra-cancel]").addEventListener("click", () => close(false));
      backdrop.querySelector("[data-vra-confirm]").addEventListener("click", () => close(true));
      document.addEventListener("keydown", onKeydown);

      document.body.appendChild(backdrop);
      backdrop.querySelector("[data-vra-confirm]").focus();
    });
  }

  function showDeleteConfirmation() {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "vra-modal-backdrop";
      backdrop.innerHTML = [
        '<div class="vra-modal" role="dialog" aria-modal="true" aria-labelledby="vra-delete-modal-title">',
        '  <h2 id="vra-delete-modal-title">Delete original listing?</h2>',
        "  <p>This will open the original Vinted listing and confirm deletion automatically. Only continue after you have reviewed the new draft.</p>",
        '  <div class="vra-modal-actions">',
        '    <button type="button" data-vra-cancel>Cancel</button>',
        '    <button type="button" data-vra-confirm>Delete original</button>',
        "  </div>",
        "</div>"
      ].join("");

      const onKeydown = (event) => {
        if (event.key === "Escape") close(false);
      };

      const close = (result) => {
        document.removeEventListener("keydown", onKeydown);
        backdrop.remove();
        resolve(result);
      };

      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close(false);
      });
      backdrop.querySelector("[data-vra-cancel]").addEventListener("click", () => close(false));
      backdrop.querySelector("[data-vra-confirm]").addEventListener("click", () => close(true));
      document.addEventListener("keydown", onKeydown);

      document.body.appendChild(backdrop);
      backdrop.querySelector("[data-vra-cancel]").focus();
    });
  }

  function handleWorkflowStatus(message) {
    if (message.message) {
      showToast(message.message, message.kind || kindFromStatus(message.status));
    }

    const button = findWorkflowButton(message);
    if (!button) return;

    setButtonStatus(button, message.status);

    if (message.status === "form_filled") {
      if (message.draftTabId) button.dataset.vraDraftTabId = String(message.draftTabId);
      clearButtonWorkflow(button, message.workflowId || message.backupId);
      return;
    }

    if (message.status === "failed") {
      clearButtonWorkflow(button, message.workflowId || message.backupId);
    }
  }

  function findWorkflowButton(message) {
    const workflowId = message.workflowId || message.backupId || "";
    if (workflowId && activeButtons.has(workflowId)) {
      return activeButtons.get(workflowId);
    }

    if (workflowId) {
      const workflowButton = document.querySelector(`[${BUTTON_ATTR}][data-vra-workflow-id="${cssEscape(workflowId)}"]`);
      if (workflowButton) return workflowButton;
    }

    if (!message.itemId) return null;
    return document.querySelector(`[${BUTTON_ATTR}][data-vra-item-id="${cssEscape(message.itemId)}"]`);
  }

  function handleDeleteStatus(message) {
    if (message.message) {
      showToast(message.message, message.kind || kindFromStatus(message.status));
    }

    const button = findDeleteButton(message.itemId);
    if (!button) return;

    if (message.status === "deleted") {
      button.textContent = "✓";
      button.disabled = true;
    } else if (message.status === "delete_failed") {
      button.textContent = "🗑";
      button.disabled = false;
    }
  }

  function findDeleteButton(itemId) {
    if (!itemId) return null;
    const relistButton = document.querySelector(`[${BUTTON_ATTR}][data-vra-item-id="${cssEscape(itemId)}"]`);
    const wrapper = relistButton && relistButton.closest(".vra-button-wrap");
    return wrapper ? wrapper.querySelector(".vra-delete-button") : null;
  }

  function clearButtonWorkflow(button, workflowId) {
    if (workflowId) activeButtons.delete(workflowId);
    if (button && button.dataset.vraWorkflowId === workflowId) {
      delete button.dataset.vraWorkflowId;
    }
  }

  function kindFromStatus(status) {
    if (status === "failed") return "error";
    if (status === "form_filled") return "success";
    return "info";
  }

  function setButtonStatus(button, status) {
    if (!button) return;
    const isReady = status === "form_filled";
    const isFailed = status === "failed";
    button.disabled = !isReady && !isFailed;
    button.textContent = STATUS_LABELS[status] || STATUS_LABELS.started;
    button.dataset.vraStatus = status || "";
    updateSplitControls(button, isReady);
  }

  function updateSplitControls(button, isReady) {
    const wrapper = button.closest(".vra-button-wrap");
    if (!wrapper) return;

    const resetButton = wrapper.querySelector(".vra-reset-button");
    const deleteButton = wrapper.querySelector(".vra-delete-button");
    wrapper.classList.toggle("vra-button-wrap--ready", isReady);
    button.style.width = isReady ? "100%" : "var(--vra-bump-width, 72px)";

    if (resetButton) {
      resetButton.hidden = !isReady;
    }

    if (deleteButton) {
      deleteButton.hidden = !isReady;
      if (isReady) {
        deleteButton.disabled = false;
        deleteButton.textContent = "🗑";
      }
    }
  }

  function resetButtonForRelist(button) {
    delete button.dataset.vraDraftTabId;
    delete button.dataset.vraStatus;
    button.disabled = false;
    button.textContent = DEFAULT_TEXT;
    updateSplitControls(button, false);
  }

  function showToast(message, kind) {
    let stack = document.querySelector(".vra-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "vra-toast-stack";
      document.documentElement.appendChild(stack);
    }

    const toast = document.createElement("div");
    toast.className = "vra-toast";
    toast.dataset.kind = kind || "info";
    toast.textContent = message;
    stack.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
      if (!stack.childElementCount) stack.remove();
    }, kind === "error" ? 9000 : 6000);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function getElementText(element) {
    if (element instanceof HTMLInputElement) return element.value || element.getAttribute("aria-label") || "";
    return element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "";
  }

  function createWorkflowId(itemId) {
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `vra-${itemId}-${Date.now()}-${randomPart}`;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
