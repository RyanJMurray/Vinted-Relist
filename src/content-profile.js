(function () {
  "use strict";

  const BUTTON_ATTR = "data-vra-relist-button";
  const LINK_SELECTOR = [
    'a.new-item-box__overlay[href^="/items/"]',
    'a[data-testid^="product-item-id-"][href*="/items/"]'
  ].join(",");
  const BUTTON_LIKE_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
  const ACTIVE_TEXT = "Cloning...";
  const DEFAULT_TEXT = "Relist";

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
      if (!message || message.type !== "WORKFLOW_STATUS") return;
      handleWorkflowStatus(message);
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

      const confirmed = await showConfirmation();
      if (!confirmed) return;

      setButtonBusy(button, true);
      activeButtons.set(itemId, button);

      chrome.runtime.sendMessage(
        {
          type: "START_RELIST",
          itemId,
          itemUrl,
          cardTitle
        },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            setButtonBusy(button, false);
            activeButtons.delete(itemId);
            showToast(`Could not start relist: ${error.message}`, "error");
            return;
          }

          if (!response || !response.ok) {
            setButtonBusy(button, false);
            activeButtons.delete(itemId);
            showToast(response && response.error ? response.error : "Could not start relist.", "error");
          }
        }
      );
    });

    return button;
  }

  function insertButtonNearBumpButton(bumpControl, button) {
    matchBumpButtonSize(bumpControl, button);

    const wrapper = document.createElement("div");
    wrapper.className = "vra-button-wrap";
    wrapper.appendChild(button);

    if (bumpControl.parentElement) {
      bumpControl.insertAdjacentElement("afterend", wrapper);
    }
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

  function handleWorkflowStatus(message) {
    if (message.message) {
      showToast(message.message, message.kind || kindFromStatus(message.status));
    }

    if (!message.itemId) return;
    const button = activeButtons.get(message.itemId) || document.querySelector(`[${BUTTON_ATTR}][data-vra-item-id="${cssEscape(message.itemId)}"]`);
    if (!button) return;

    if (message.status === "form_filled" || message.status === "failed") {
      setButtonBusy(button, false);
      activeButtons.delete(message.itemId);
    }
  }

  function kindFromStatus(status) {
    if (status === "failed") return "error";
    if (status === "form_filled") return "success";
    return "info";
  }

  function setButtonBusy(button, busy) {
    button.disabled = busy;
    button.textContent = busy ? ACTIVE_TEXT : DEFAULT_TEXT;
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

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
