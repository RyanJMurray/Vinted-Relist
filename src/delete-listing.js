(async function () {
  "use strict";

  try {
    await waitForPageReady();
    const deleteButton = await waitForButtonByText("Delete", 12000);
    clickElement(deleteButton);

    const confirmButton = await waitForButtonByText("Confirm and delete", 12000);
    clickElement(confirmButton);
    await delay(500);

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }

  function waitForPageReady() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  async function waitForButtonByText(label, timeoutMs) {
    const startedAt = Date.now();
    const expected = normalize(label);

    while (Date.now() - startedAt < timeoutMs) {
      const button = findButtonByText(expected);
      if (button) return button;

      window.scrollBy(0, Math.round(window.innerHeight * 0.65));
      await delay(250);
    }

    throw new Error(`Could not find the "${label}" button.`);
  }

  function findButtonByText(expected) {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return controls.find((control) => {
      if (!isVisible(control)) return false;
      const text = normalize(control.textContent || control.getAttribute("aria-label") || control.getAttribute("title") || "");
      return text === expected;
    }) || null;
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
