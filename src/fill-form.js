(function () {
  "use strict";

  if (window.__vraFillFormInstalled) return;
  window.__vraFillFormInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "FILL_FROM_BACKUP") return false;

    fillFromBackup(message.backup, message.imageDataUrls || [])
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  function resetFillDebug(backup) {
    window.__vraLastFillDebug = [];
    debugFill("start", {
      backupId: backup && backup.id,
      itemId: backup && backup.itemId,
      title: backup && backup.title
    });
  }

  function debugFill(event, details) {
    const entry = {
      time: new Date().toISOString(),
      event,
      ...(details || {})
    };

    if (!Array.isArray(window.__vraLastFillDebug)) {
      window.__vraLastFillDebug = [];
    }
    window.__vraLastFillDebug.push(entry);

    try {
      console.log("[VRA fill]", event, details || {});
    } catch (_error) {
      // Console logging is best-effort only.
    }
  }

  function getFillDebug() {
    return Array.isArray(window.__vraLastFillDebug) ? window.__vraLastFillDebug.slice() : [];
  }

  async function fillFromBackup(backup, imageDataUrls) {
    const warnings = [];
    const failedFields = [];
    resetFillDebug(backup);
    await waitForFormReady();

    const pageText = document.body.innerText || "";
    if (/captcha|security check|verify you are human/i.test(pageText)) {
      throw new Error("Vinted is showing a captcha or security check.");
    }
    if (/log in|sign up/i.test(pageText) && !document.querySelector("form")) {
      throw new Error("Vinted appears to require login before the sell form can be filled.");
    }

    const uploadResult = await uploadImages(imageDataUrls);
    warnings.push(...uploadResult.warnings);
    await waitForImageDrivenSuggestions();

    if (!fillTextField(["title", "item title"], backup.title || "")) {
      warnings.push("title");
    }

    if (!fillTextArea(["description", "describe your item"], backup.description || "")) {
      warnings.push("description");
    }

    const attributes = { ...(backup.attributes || {}) };
    if (!attributes.size) {
      attributes.size = inferSizeFromListingTitle(backup.title || "");
    }
    if (!attributes.condition) {
      attributes.condition = inferConditionFromBackupText(backup);
    }
    if (!attributes.colour) {
      attributes.colour = inferColourFromBackupText(backup);
    }
    debugFill("attributes", { attributes });
    if (attributes.category) {
      debugFill("field:start", { field: "category", value: attributes.category });
      const categoryHandled = await fillCategoryPath(attributes.category);
      debugFill("field:finish", { field: "category", value: attributes.category, handled: categoryHandled });
      if (!categoryHandled) {
        warnings.push("category");
        failedFields.push("category");
      }
      await delay(1000);
      await waitForDependentCategoryFields();
    }

    const toggleResults = [
      ["brand", attributes.brand],
      ["size", attributes.size],
      ["condition", attributes.condition],
      ["colour", attributes.colour],
      ["material", attributes.material],
      ["parcel size", attributes.parcelSize],
      ["package size", attributes.parcelSize]
    ];

    for (const [label, value] of toggleResults) {
      if (!value) {
        debugFill("field:skip", { field: label, reason: "missing extracted value" });
        if (label === "condition" || label === "colour") {
          warnings.push(`${label} missing from extracted listing data`);
        }
        continue;
      }
      debugFill("field:start", { field: label, value });
      const handled = await fillToggleField(label, value);
      debugFill("field:finish", { field: label, value, handled });
      if (!handled) {
        if (!warnings.includes(label)) warnings.push(label);
        failedFields.push(label);
      }
      await delay(500);
    }

    debugFill("field:start", { field: "price", value: backup.price && backup.price.amount ? backup.price.amount : "" });
    const priceHandled = await fillPrice(backup.price && backup.price.amount ? backup.price.amount : "");
    debugFill("field:finish", { field: "price", value: backup.price && backup.price.amount ? backup.price.amount : "", handled: priceHandled });
    if (!priceHandled) {
      warnings.push("price");
    }

    const blockingFailures = failedFields.filter((field) => isBlockingFillField(field, attributes));
    if (blockingFailures.length) {
      return {
        ok: false,
        error: `Could not automatically fill: ${Array.from(new Set(blockingFailures)).join(", ")}`,
        warnings: warnings.map(warningMessageFor),
        debug: getFillDebug()
      };
    }

    return {
      ok: true,
      warnings: warnings.map(warningMessageFor),
      debug: getFillDebug()
    };
  }

  function warningMessageFor(field) {
    const text = String(field || "");
    if (/missing from extracted listing data/i.test(text)) return text;
    return `Could not automatically fill: ${text}`;
  }

  function isBlockingFillField(field, attributes) {
    const normalizedField = normalize(field);
    if (normalizedField === "category") return Boolean(attributes.category);
    if (normalizedField === "brand") return Boolean(attributes.brand);
    if (normalizedField === "size") return Boolean(attributes.size);
    if (normalizedField === "condition") return Boolean(attributes.condition);
    if (normalizedField === "colour" || normalizedField === "color") return Boolean(attributes.colour);
    return false;
  }

  async function waitForFormReady() {
    await waitFor(() => document.querySelector('input, textarea, [role="textbox"], button'), 45000);
    await delay(250);
  }

  function fillTextField(labels, value) {
    if (!value) return false;
    const control = findInputByNames(labels, 'input:not([type="file"]):not([type="hidden"]), [role="textbox"]');
    if (!control) return false;
    setControlValue(control, value);
    return true;
  }

  function fillTextArea(labels, value) {
    if (!value) return false;
    const control = findInputByNames(labels, "textarea, [contenteditable='true'], [role='textbox']");
    if (!control) return false;
    setControlValue(control, value);
    return true;
  }

  async function fillPrice(value) {
    if (!value) return false;
    const amount = priceTextForTyping(value);
    const control = findInputByNames(["price", "amount"], 'input:not([type="file"]):not([type="hidden"])') ||
      Array.from(document.querySelectorAll('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[type="text"]'))
        .find((input) => isVisible(input) && /price|amount|£|gbp/i.test(labelTextFor(input) + " " + nearbyText(input)));
    if (!control) return false;
    await commitPriceValue(control, amount);
    debugFill("price:filled", { typed: amount, value: control.value || "" });
    return true;
  }

  async function fillCategoryPath(value) {
    const parts = splitCategoryPath(value);
    if (!parts.length) return false;

    const opened = await openCategoryField();
    if (!opened) return false;

    const autoSuggestion = await waitForOptional(() => findCategorySuggestion(parts, { preferFirstSuggestion: true }), 3500);
    if (autoSuggestion && await selectCategorySuggestion(autoSuggestion)) {
      return true;
    }

    const searchInput = await waitForOptional(() => findOpenCategorySearchInput(), 1500);
    if (!searchInput) {
      closeOpenPicker();
      return false;
    }

    const attempts = Array.from(new Set([
      parts.join(" > "),
      parts[parts.length - 1]
    ].map(cleanText).filter(Boolean)));

    for (const attempt of attempts) {
      pasteControlValue(searchInput, attempt);
      await delay(500);

      const suggestion = await waitForOptional(() => findCategorySuggestion(parts, { preferFirstSuggestion: true }), 2500);
      if (suggestion && await selectCategorySuggestion(suggestion)) return true;
    }

    closeOpenPicker();
    return false;
  }

  async function waitForImageDrivenSuggestions() {
    await delay(1200);
  }

  async function fillToggleField(label, value) {
    const normalizedLabel = normalize(label);
    if (normalizedLabel === "brand") return fillBrandField(value);
    if (normalizedLabel === "size") return fillSizeField(value);
    if (normalizedLabel === "condition") return fillConditionField(value);
    if (normalizedLabel === "colour" || normalizedLabel === "color") return fillColourField(value);

    const values = splitToggleValues(value);
    if (!values.length) return false;

    let filledAny = false;
    for (const optionValue of values) {
      const opened = await openToggleField(label);
      if (!opened) return filledAny;

      await waitForOptionListOrSearch(label, optionValue);
      let clicked = await clickOptionByAliases(label, optionValue);
      if (!clicked) {
        const searchInput = findOpenPickerSearchInput(label);
        if (searchInput) {
          pasteControlValue(searchInput, optionValue);
          await delay(500);
          clicked = await clickOptionByAliases(label, optionValue);
        }
      }

      if (!clicked) {
        closeOpenPicker();
        return filledAny;
      }

      filledAny = true;
      await delay(200);
    }

    return filledAny;
  }

  async function fillBrandField(value) {
    const brand = cleanText(value);
    if (!brand) return false;

    const opened = await openBrandField();
    if (!opened) return false;

    const searchInput = await waitForOptional(() => findBrandSearchInput(), 2500);
    if (!searchInput) {
      closeOpenPicker();
      return false;
    }

    await typeBrandSearchValue(searchInput, brand);

    const suggestion = await waitForOptional(() => findBrandSuggestion(), 3000);
    if (!suggestion) {
      closeOpenPicker();
      return false;
    }

    const selected = await selectBrandSuggestion(suggestion, brand);
    if (!selected) {
      closeOpenPicker();
      return false;
    }

    await waitForBrandPickerSettled();
    return true;
  }

  async function fillColourField(value) {
    const values = splitColourValues(value);
    if (!values.length) {
      debugFill("colour:empty", { value });
      return false;
    }

    let filledAny = false;
    for (const colour of values) {
      if (currentColourSelectionIncludes(colour)) {
        debugFill("colour:already-selected", { colour });
        filledAny = true;
        continue;
      }

      const opened = await openColourField();
      debugFill("colour:opened", { colour, opened });
      if (!opened) return filledAny;

      await waitForOptional(() => findColourOption(colour) || findOpenPickerSearchInput("colour"), 700);

      let option = findColourOption(colour);
      debugFill("colour:option", { colour, found: Boolean(option), title: option ? colourOptionTitle(option) : "" });
      if (!option) {
        const searchInput = findOpenPickerSearchInput("colour");
        if (searchInput) {
          debugFill("colour:search", { colour });
          pasteControlValue(searchInput, colour);
          await delay(120);
          option = findColourOption(colour);
          debugFill("colour:option-after-search", { colour, found: Boolean(option), title: option ? colourOptionTitle(option) : "" });
        }
      }

      if (!option) {
        closeOpenPicker();
        return filledAny;
      }

      const selected = await selectColourOption(option, colour);
      debugFill("colour:selected", { colour, selected });
      if (!selected) {
        closeOpenPicker();
        return filledAny;
      }

      filledAny = true;
      await delay(40);
    }

    closeOpenPicker();
    return filledAny;
  }

  async function fillSizeField(value) {
    const size = cleanSizeValue(value);
    if (!size) return false;

    if (currentSizeSelectionMatches(size)) return true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opened = await openSizeField();
      if (!opened) {
        closeOpenPicker();
        await delay(100);
        continue;
      }

      await waitForOptional(() => findSizeOption(size), 800);
      const option = findSizeOption(size);
      if (!option) {
        closeOpenPicker();
        await delay(100);
        continue;
      }

      const selected = await selectSizeOption(option, size);
      if (selected) return true;

      closeOpenPicker();
      await delay(120);
    }

    return false;
  }

  async function fillConditionField(value) {
    const condition = cleanConditionValue(value);
    const conditionId = conditionIdFor(normalizeCondition(condition));
    debugFill("condition:normalised", { raw: value, condition, conditionId });
    if (!condition) return false;

    await waitForConditionFieldSettled();

    if (currentConditionSelectionMatches(condition)) {
      debugFill("condition:already-selected", { condition, conditionId });
      return true;
    }

    const opened = await openConditionField();
    debugFill("condition:opened", { condition, conditionId, opened });
    if (!opened) return false;

    await waitForOptional(() => findConditionOption(condition), 700);
    const option = findConditionOption(condition);
    debugFill("condition:option", { condition, conditionId, found: Boolean(option), title: option ? conditionOptionTitle(option) : "" });
    if (!option) {
      closeOpenPicker();
      return false;
    }

    const selected = await selectConditionOption(option, condition);
    debugFill("condition:selected", { condition, conditionId, selected });
    if (!selected) {
      closeOpenPicker();
      return false;
    }

    return true;
  }

  function findBrandSearchInput() {
    return Array.from(document.querySelectorAll([
      "#brand-search-input",
      'input[name="brand-search-input"]',
      'input[data-testid="brand-search--input"]',
      'input[placeholder="Search brands"]'
    ].join(","))).find(isVisible) || null;
  }

  async function openBrandField() {
    const opener = findBrandOpener();
    if (!opener) return false;

    clickElement(opener);
    return Boolean(await waitForOptional(() => findBrandSearchInput(), 2500));
  }

  function findBrandOpener() {
    return Array.from(document.querySelectorAll([
      '[data-testid="brand-select-dropdown-input"]',
      '#brand',
      'input[name="brand"]'
    ].join(","))).find((element) => isVisible(element) && !element.matches("#brand-search-input, [data-testid='brand-search--input']")) ||
      findFieldOpenerByLabel("Brand") ||
      findCustomSelectOpener("brand");
  }

  async function typeBrandSearchValue(input, brand) {
    if (typeof input.focus === "function") input.focus();
    pasteControlValue(input, brand.slice(0, 1));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: brand.slice(0, 1).toLowerCase() || " " }));
    await delay(150);
    pasteControlValue(input, brand);
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: brand.slice(-1).toLowerCase() || " " }));
    await delay(500);
  }

  function findBrandSuggestion() {
    const candidates = getBrandSuggestionCells();
    return candidates[0] || null;
  }

  function getBrandSuggestionCells() {
    const nodes = Array.from(document.querySelectorAll([
      '[id^="brand-"][role="button"]',
      '[id^="suggested-brand-"]',
      'input[type="radio"][id^="brand-radio-"]',
      'input[type="radio"][id^="suggested-brand-radio-"]',
      'label[for^="brand-radio-"]',
      'label[for^="suggested-brand-radio-"]'
    ].join(",")));

    return Array.from(new Set(nodes
      .map((node) => node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='button']") || node)))
      .filter(isVisible)
      .filter((element) => /^(?:suggested-)?brand-\d+$/.test(element.id || element.getAttribute("data-testid") || "") ||
        element.querySelector('input[type="radio"][id^="brand-radio-"], input[type="radio"][id^="suggested-brand-radio-"], label[for^="brand-radio-"], label[for^="suggested-brand-radio-"]'));
  }

  async function selectBrandSuggestion(suggestion, brand) {
    suggestion.scrollIntoView({ block: "center", inline: "nearest" });

    for (const target of brandSuggestionClickTargets(suggestion)) {
      clickElement(target);
      const selected = await waitForOptional(() => brandSelectionSettled(suggestion, brand), 1800);
      if (selected) return true;
    }

    return false;
  }

  function brandSuggestionClickTargets(suggestion) {
    return Array.from(new Set([
      suggestion.querySelector(".web_ui__Cell__content, [class*='web_ui__Cell__content']"),
      suggestion.querySelector(".web_ui__Cell__heading, [class*='web_ui__Cell__heading']"),
      suggestion.querySelector(".web_ui__Cell__title, [class*='web_ui__Cell__title']"),
      suggestion,
      suggestion.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button']"),
      suggestion.querySelector('input[type="radio"]')
    ].filter(Boolean).filter(isVisible)));
  }

  function brandSelectionSettled(suggestion, brand) {
    return !isStillVisible(suggestion) || currentBrandSelectionMatches(brand);
  }

  function currentBrandSelectionMatches(brand) {
    const opener = findBrandOpener();
    const openerValue = cleanText((opener && (opener.value || opener.getAttribute("value") || opener.textContent)) || "");
    return openerValue && normalize(openerValue).includes(normalize(brand));
  }

  async function waitForBrandPickerSettled() {
    await waitForOptional(() => !findBrandSearchInput(), 2000);
    await delay(500);
  }

  function findSizeOption(value) {
    const aliases = sizeAliases(value);
    const candidates = getSizeOptionCells();

    for (const cell of candidates) {
      const title = sizeOptionTitle(cell);
      if (sizeTitleMatches(title, aliases)) return cell;
    }

    return null;
  }

  async function openSizeField() {
    closeOpenPicker();
    await delay(100);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (findOpenSizeDropdownContent()) return true;

      const opener = await waitForOptional(() => findReadySizeOpener(), 900);
      if (!opener) return false;

      for (const target of sizeOpenerClickTargets(opener)) {
        target.scrollIntoView({ block: "center", inline: "nearest" });
        await delay(40);
        clickElement(target);

        const opened = await waitForOptional(() => findOpenSizeDropdownContent(), 650);
        if (opened) return true;
      }

      closeOpenPicker();
      await delay(120);
    }

    return false;
  }

  function findReadySizeOpener() {
    const opener = findSizeOpener();
    if (!opener || !isVisible(opener)) return null;
    if (opener.disabled || opener.getAttribute("aria-disabled") === "true") return null;
    return opener;
  }

  function findSizeOpener() {
    const exact = Array.from(document.querySelectorAll([
      '[data-testid="size-select-dropdown-input"]',
      '#size',
      'input[name="size"]'
    ].join(","))).find(isVisible);
    if (exact) return exact;

    return (
      findFieldOpenerByLabel("Size") ||
      findCustomSelectOpener("size")
    );
  }

  function sizeOpenerClickTargets(opener) {
    const chevronButton = findSizeChevronButton(opener);
    const root = findSizeInputRoot(opener);
    return Array.from(new Set([
      opener,
      root,
      chevronButton,
      chevronButton && chevronButton.querySelector('[data-testid="size-select-dropdown-chevron-down"]'),
      opener.parentElement,
      opener.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell']")
    ].filter(Boolean).filter(isVisible)));
  }

  function findSizeChevronButton(opener) {
    const root = findSizeInputRoot(opener);
    const chevron = (root || document).querySelector('[data-testid="size-select-dropdown-chevron-down"]') ||
      document.querySelector('[data-testid="size-select-dropdown-chevron-down"]');
    if (!chevron) return null;
    return chevron.closest('[role="button"], button, .c-input__icon, [class*="c-input__icon"]') || chevron;
  }

  function findSizeInputRoot(opener) {
    let current = opener;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (current.querySelector && current.querySelector('[data-testid="size-select-dropdown-chevron-down"]')) {
        return current;
      }
    }
    return opener && (
      opener.closest(".c-input") ||
      opener.closest(".web_ui__InputBar__input-bar, [class*='InputBar']") ||
      opener.parentElement
    );
  }

  function findOpenSizeDropdownContent() {
    const exact = Array.from(document.querySelectorAll([
      '[data-testid="size-select-dropdown-content"]',
      '.input-dropdown[data-testid="size-select-dropdown-content"]'
    ].join(","))).find(isVisible);
    if (exact) return exact;

    return Array.from(document.querySelectorAll([
      '.input-dropdown__content--scrollable'
    ].join(","))).find((element) => isVisible(element) && element.querySelector([
      '[data-testid^="suggested-size-"][role="button"]',
      '[id^="suggested-size-"][role="button"]',
      '[data-testid^="size-"][role="button"]',
      '[id^="size-"][role="button"]',
      '[data-testid^="suggested-size-"]',
      '[data-testid^="size-"]'
    ].join(","))) || null;
  }

  function getSizeOptionCells() {
    const root = findOpenSizeDropdownContent();
    if (!root) return [];

    return Array.from(root.querySelectorAll([
      '[data-testid^="suggested-size-"][role="button"]',
      '[id^="suggested-size-"][role="button"]',
      '[data-testid^="size-"][role="button"]',
      '[id^="size-"][role="button"]',
      '[data-testid^="suggested-size-"]',
      '[data-testid^="size-"]'
    ].join(",")))
      .filter((cell) => /^(?:suggested-)?size-\d+$/.test(cell.getAttribute("data-testid") || cell.id || ""))
      .filter((cell) => cell.querySelector('[data-testid^="suggested-size-"][data-testid$="-title"], [data-testid^="size-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]'));
  }

  function sizeOptionTitle(cell) {
    return cleanText((cell.querySelector('[data-testid^="suggested-size-"][data-testid$="-title"], [data-testid^="size-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]') || {}).textContent || "");
  }

  async function selectSizeOption(option, size) {
    let currentOption = option;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!currentOption || !document.documentElement.contains(currentOption)) {
        currentOption = findSizeOption(size);
      }
      if (!currentOption) return false;

      currentOption.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(40);

      for (const target of sizeOptionClickTargets(currentOption)) {
        activateOption(target);
        const selected = await waitForOptional(() => currentSizeSelectionMatches(size), 650);
        if (selected) return true;
      }

      if (!findOpenSizeDropdownContent()) {
        await openSizeField();
        currentOption = findSizeOption(size);
      }
    }

    return false;
  }

  function sizeOptionClickTargets(option) {
    return Array.from(new Set([
      option.querySelector(".web_ui__Cell__content, [class*='web_ui__Cell__content']"),
      option,
      option.querySelector('[data-testid^="suggested-size-"][data-testid$="-title"], [data-testid^="size-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]'),
      option.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button']"),
      option.querySelector('label[for^="suggested-size-radio-"], label[for^="size-radio-"]'),
      option.querySelector('input[type="radio"]')
    ].filter(Boolean)));
  }

  function currentSizeSelectionMatches(size) {
    const opener = findSizeOpener();
    const openerValue = cleanText((opener && (opener.value || opener.getAttribute("value") || opener.textContent)) || "");
    return openerValue && sizeTitleMatches(openerValue, sizeAliases(size));
  }

  function findConditionOption(value) {
    const wanted = normalizeCondition(value);
    const conditionId = conditionIdFor(wanted);
    const candidates = getConditionOptionCells();

    if (conditionId) {
      const exact = findConditionOptionById(conditionId);
      if (exact) return exact;

      const direct = candidates.find((cell) => (
        cell.id === `condition-${conditionId}` ||
        cell.getAttribute("data-testid") === `condition-${conditionId}`
      ));
      if (direct) return direct;
    }

    for (const cell of candidates) {
      const title = conditionOptionTitle(cell);
      if (normalizeCondition(title) === wanted) return cell;
    }

    return null;
  }

  function findConditionOptionById(conditionId) {
    const root = findOpenConditionDropdownContent() || document;
    const id = String(conditionId).replace(/[^\d]/g, "");
    if (!id) return null;

    const selectors = [
      `[data-testid="condition-${id}"]`,
      `[id="condition-${id}"]`,
      `[data-testid="condition-${id}--content"]`,
      `[data-testid="condition-${id}--title"]`,
      `input[type="radio"][id="condition-radio-${id}"]`,
      `label[for="condition-radio-${id}"]`
    ];

    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (!node || !isVisible(node)) continue;

      const option = node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='button']") || node;
      if (option && isVisible(option)) return option;
    }

    return null;
  }

  async function openConditionField() {
    closeOpenPicker();
    await delay(100);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (findOpenConditionDropdownContent()) return true;

      const opener = await waitForOptional(() => findReadyConditionOpener(), 900);
      if (!opener) return false;

      for (const target of conditionOpenerClickTargets(opener)) {
        target.scrollIntoView({ block: "center", inline: "nearest" });
        await delay(40);
        clickElement(target);

        const opened = await waitForOptional(() => findOpenConditionDropdownContent(), 650);
        if (opened) return true;
      }

      closeOpenPicker();
      await delay(120);
    }

    return false;
  }

  async function waitForConditionFieldSettled() {
    await waitForOptional(() => findReadyConditionOpener(), 1000);
    await delay(150);
  }

  function findReadyConditionOpener() {
    const opener = findConditionOpener();
    if (!opener || !isVisible(opener)) return null;
    if (opener.disabled || opener.getAttribute("aria-disabled") === "true") return null;
    return opener;
  }

  function findConditionOpener() {
    return Array.from(document.querySelectorAll([
      '[data-testid="category-condition-single-list-input"]',
      '[data-testid="condition-select-dropdown-input"]',
      '[data-testid="status-select-dropdown-input"]',
      '#condition',
      '#status',
      'input[name="condition"]',
      'input[name="status"]'
    ].join(","))).find(isVisible) ||
      findFieldOpenerByLabel("Condition") ||
      findCustomSelectOpener("condition");
  }

  function conditionOpenerClickTargets(opener) {
    const chevronButton = findConditionChevronButton(opener);
    const root = findConditionInputRoot(opener);
    return Array.from(new Set([
      opener,
      root,
      chevronButton,
      chevronButton && chevronButton.querySelector('[data-testid*="condition"][data-testid*="chevron"], [data-testid*="status"][data-testid*="chevron"]'),
      opener.parentElement,
      opener.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell']")
    ].filter(Boolean).filter(isVisible)));
  }

  function findConditionChevronButton(opener) {
    const root = findConditionInputRoot(opener);
    const chevron = (root || document).querySelector([
      '[data-testid="category-condition-single-list-chevron-down"]',
      '[data-testid="condition-select-dropdown-chevron-down"]',
      '[data-testid="status-select-dropdown-chevron-down"]',
      '[data-testid*="condition"][data-testid*="chevron"]',
      '[data-testid*="status"][data-testid*="chevron"]'
    ].join(",")) || document.querySelector([
      '[data-testid="category-condition-single-list-chevron-down"]',
      '[data-testid="condition-select-dropdown-chevron-down"]',
      '[data-testid="status-select-dropdown-chevron-down"]'
    ].join(","));
    if (!chevron) return null;
    return chevron.closest('[role="button"], button, .c-input__icon, [class*="c-input__icon"]') || chevron;
  }

  function findConditionInputRoot(opener) {
    let current = opener;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (current.querySelector && current.querySelector([
        '[data-testid="category-condition-single-list-chevron-down"]',
        '[data-testid="condition-select-dropdown-chevron-down"]',
        '[data-testid="status-select-dropdown-chevron-down"]',
        '[data-testid*="condition"][data-testid*="chevron"]',
        '[data-testid*="status"][data-testid*="chevron"]'
      ].join(","))) {
        return current;
      }
    }
    return opener && (
      opener.closest(".c-input") ||
      opener.closest(".web_ui__InputBar__input-bar, [class*='InputBar']") ||
      opener.parentElement
    );
  }

  function findOpenConditionDropdownContent() {
    return Array.from(document.querySelectorAll([
      '.input-dropdown__content--scrollable',
      '.input-dropdown',
      '.web_ui__Card__card'
    ].join(","))).find((element) => isVisible(element) && element.querySelector([
      '[data-testid^="condition-"][role="button"]',
      '[data-testid^="condition-"][data-testid$="--content"]',
      '[data-testid^="condition-"]',
      'input[type="radio"][id^="condition-radio-"]'
    ].join(","))) || null;
  }

  function getConditionOptionCells() {
    const root = findOpenConditionDropdownContent();
    if (!root) return [];

    return Array.from(root.querySelectorAll([
      '[data-testid^="condition-"][role="button"]',
      '[id][role="button"]',
      '[data-testid^="condition-"]',
      'input[type="radio"][id^="condition-radio-"]',
      'label[for^="condition-radio-"]'
    ].join(",")))
      .map((node) => node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='button']") || node)
      .filter((cell, index, cells) => cells.indexOf(cell) === index)
      .filter(isVisible)
      .filter((cell) => /^condition-\d+$/.test(cell.getAttribute("data-testid") || cell.id || "") || /^\d+$/.test(cell.id || "") || cell.querySelector('input[type="radio"][id^="condition-radio-"], label[for^="condition-radio-"]'))
      .filter((cell) => cell.querySelector('[data-testid^="condition-"][data-testid$="--title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]'));
  }

  function conditionOptionTitle(cell) {
    return cleanText((cell.querySelector('[data-testid^="condition-"][data-testid$="--title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]') || {}).textContent || "");
  }

  async function selectConditionOption(option, condition) {
    const conditionId = conditionIdFor(normalizeCondition(condition));
    if (conditionId && await selectConditionById(conditionId, condition)) return true;

    let currentOption = option;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!currentOption || !document.documentElement.contains(currentOption)) {
        currentOption = findConditionOption(condition);
      }
      if (!currentOption) return false;

      currentOption.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(40);

      for (const target of conditionOptionClickTargets(currentOption)) {
        clickElement(target);
        const selected = await waitForOptional(() => currentConditionSelectionMatches(condition) || !isStillVisible(currentOption), 650);
        if (selected) return true;
      }

      if (!findOpenConditionDropdownContent()) {
        await openConditionField();
        currentOption = findConditionOption(condition);
      }
    }

    return false;
  }

  function conditionOptionClickTargets(option) {
    return Array.from(new Set([
      option.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button']"),
      option.querySelector('label[for^="condition-radio-"]'),
      option.querySelector('input[type="radio"]'),
      option.querySelector('[data-testid^="condition-"][data-testid$="--content"]'),
      option.querySelector('[data-testid^="condition-"][data-testid$="--title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]'),
      option.querySelector(".web_ui__Cell__content, [class*='web_ui__Cell__content']"),
      option
    ].filter(Boolean)));
  }

  function currentConditionSelectionMatches(condition) {
    const conditionId = conditionIdFor(normalizeCondition(condition));
    if (conditionId && currentConditionRadioChecked(conditionId)) return true;

    const opener = findConditionOpener();
    const openerValue = cleanText((opener && (opener.value || opener.getAttribute("value") || opener.textContent)) || "");
    return openerValue && normalizeCondition(openerValue) === normalizeCondition(condition);
  }

  async function selectConditionById(conditionId, condition) {
    for (const target of conditionRadioClickTargets(conditionId)) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(40);
      clickElement(target);

      const selected = await waitForOptional(() => currentConditionRadioChecked(conditionId) || currentConditionSelectionMatches(condition), 650);
      if (selected) return true;
    }

    return false;
  }

  function conditionRadioClickTargets(conditionId) {
    const id = String(conditionId).replace(/[^\d]/g, "");
    if (!id) return [];

    const root = findOpenConditionDropdownContent() || document;
    const selectors = [
      `[data-testid="condition-radio-${id}"] .web_ui__Radio__button`,
      `[data-testid="condition-radio-${id}"] [class*="web_ui__Radio__button"]`,
      `[data-testid="condition-${id}--suffix"] .web_ui__Radio__button`,
      `[data-testid="condition-${id}--suffix"] [class*="web_ui__Radio__button"]`,
      `[data-testid="condition-radio-${id}"]`,
      `label[for="condition-radio-${id}"]`,
      `[data-testid="condition-${id}--suffix"] label`,
      `[data-testid="condition-${id}--content"]`,
      `[data-testid="condition-${id}--title"]`,
      `[data-testid="condition-${id}"]`
    ];

    return Array.from(new Set(selectors
      .map((selector) => root.querySelector(selector))
      .filter(Boolean)
      .filter(isVisible)));
  }

  function currentConditionRadioChecked(conditionId) {
    const id = String(conditionId).replace(/[^\d]/g, "");
    if (!id) return false;

    const radio = document.querySelector(`#condition-radio-${cssEscape(id)}, [data-testid="condition-radio-${id}--input"]`);
    return Boolean(radio && radio.checked);
  }

  async function openColourField() {
    closeOpenPicker();
    await delay(80);

    const opener = findColourOpener();
    if (!opener) return false;

    for (const target of colourOpenerClickTargets(opener)) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
      await delay(40);
      clickElement(target);

      const opened = await waitForOptional(() => findOpenColourDropdownContent(), 650);
      if (opened) return true;
    }

    return false;
  }

  function findColourOpener() {
    return Array.from(document.querySelectorAll([
      '[data-testid="color-select-dropdown-input"]',
      '[data-testid="colour-select-dropdown-input"]',
      '#color',
      '#colour',
      'input[name="color"]',
      'input[name="colour"]'
    ].join(","))).find(isVisible) ||
      findFieldOpenerByLabel("Colours") ||
      findFieldOpenerByLabel("Colour") ||
      findFieldOpenerByLabel("Color") ||
      findCustomSelectOpener("colour") ||
      findCustomSelectOpener("color");
  }

  function colourOpenerClickTargets(opener) {
    const root = opener.closest(".c-input") || opener.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell']") || opener.parentElement;
    return Array.from(new Set([
      opener,
      root,
      root && root.querySelector('[data-testid*="color-select-dropdown-chevron"], [data-testid*="colour-select-dropdown-chevron"], .c-input__icon, [class*="c-input__icon"]'),
      opener.parentElement
    ].filter(Boolean).filter(isVisible)));
  }

  function findOpenColourDropdownContent() {
    return Array.from(document.querySelectorAll([
      '.input-dropdown__content--scrollable',
      '.input-dropdown',
      '.web_ui__Card__card',
      '[role="dialog"]'
    ].join(","))).find((element) => isVisible(element) && element.querySelector([
      '[data-testid^="color-"]',
      '[data-testid^="colour-"]',
      'input[type="checkbox"][id^="color-checkbox-"]',
      'input[type="checkbox"][id^="colour-checkbox-"]'
    ].join(","))) || null;
  }

  function findColourOption(value) {
    const aliases = colourAliases(value);
    const candidates = getColourOptionCells();

    for (const cell of candidates) {
      const title = colourOptionTitle(cell);
      if (aliases.includes(normalizeColour(title))) return cell;
    }

    return null;
  }

  function getColourOptionCells() {
    const root = findOpenColourDropdownContent();
    if (!root) return [];

    return Array.from(root.querySelectorAll([
      '[data-testid^="color-"]',
      '[data-testid^="colour-"]',
      'input[type="checkbox"][id^="color-checkbox-"]',
      'input[type="checkbox"][id^="colour-checkbox-"]',
      'label[for^="color-checkbox-"]',
      'label[for^="colour-checkbox-"]'
    ].join(",")))
      .map((node) => node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='button'], li") || node)
      .filter((cell, index, cells) => cells.indexOf(cell) === index)
      .filter((cell) => cell.querySelector('[data-testid^="color-"][data-testid$="-title"], [data-testid^="colour-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]') ||
        cell.querySelector('input[type="checkbox"][id^="color-checkbox-"], input[type="checkbox"][id^="colour-checkbox-"], label[for^="color-checkbox-"], label[for^="colour-checkbox-"]'));
  }

  function colourOptionTitle(cell) {
    const title = cell.querySelector('[data-testid^="color-"][data-testid$="-title"], [data-testid^="colour-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]');
    if (title) return cleanText(title.textContent || "");

    const label = cell.querySelector('label[for^="color-checkbox-"], label[for^="colour-checkbox-"]') || (cell.matches && cell.matches("label") ? cell : null);
    return cleanText((label && label.textContent) || cell.textContent || "");
  }

  async function selectColourOption(option, colour) {
    option.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(40);

    for (const target of colourOptionClickTargets(option)) {
      activateOption(target);
      const selected = await waitForOptional(() => currentColourSelectionIncludes(colour) || optionHasCheckedInput(option), 650);
      if (selected) return true;
    }

    return false;
  }

  function colourOptionClickTargets(option) {
    return Array.from(new Set([
      option.querySelector(".web_ui__Cell__content, [class*='web_ui__Cell__content']"),
      option.querySelector('[data-testid^="color-"][data-testid$="-title"], [data-testid^="colour-"][data-testid$="-title"], .web_ui__Cell__title, [class*="web_ui__Cell__title"]'),
      option.querySelector(".web_ui__Checkbox__button, [class*='web_ui__Checkbox__button']"),
      option.querySelector('label[for^="color-checkbox-"], label[for^="colour-checkbox-"]'),
      option,
      option.querySelector('input[type="checkbox"]')
    ].filter(Boolean)));
  }

  function currentColourSelectionIncludes(colour) {
    const opener = findColourOpener();
    const openerValue = cleanText((opener && (opener.value || opener.getAttribute("value") || opener.textContent)) || "");
    if (!openerValue) return false;

    return colourAliases(colour).some((alias) => normalizeColour(openerValue).includes(alias));
  }

  function optionHasCheckedInput(option) {
    const checked = option.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked');
    return Boolean(checked);
  }

  async function openToggleField(label) {
    const opener = findCustomSelectOpener(label);
    if (!opener) return false;
    clickElement(opener);
    await delay(250);
    return true;
  }

  async function openCategoryField() {
    const direct = findCategoryOpener();
    if (direct) {
      clickElement(direct);
      await delay(300);
      return true;
    }

    return openToggleField("category");
  }

  function findCategoryOpener() {
    const exact = Array.from(document.querySelectorAll([
      '[data-testid="catalog-select-dropdown-input"]',
      '#catalog',
      'input[name="catalog"]',
      'input[name="catalog_id"]'
    ].join(","))).find(isVisible);
    if (exact) return exact;

    const directSelectors = [
      'input[name*="catalog" i]',
      'input[id*="catalog" i]',
      'input[data-testid*="catalog" i]',
      'input[name*="category" i]',
      'input[id*="category" i]',
      'input[data-testid*="category" i]',
      'input[placeholder*="category" i]',
      'input[placeholder*="catalog" i]',
      '[data-testid*="catalog" i][role="button"]',
      '[data-testid*="category" i][role="button"]',
      '[data-testid*="catalog" i] button',
      '[data-testid*="category" i] button'
    ].join(",");

    const direct = Array.from(document.querySelectorAll(directSelectors))
      .filter(isVisible)
      .filter((element) => !isGlobalSearchInput(element) && !isNonFieldControl(element))[0];
    if (direct) return direct;

    return findFieldOpenerByLabel("Category");
  }

  async function waitForOptionListOrSearch(label, value) {
    try {
      await waitFor(() => findVisibleOption(value, { allowContains: true }) || findOpenPickerSearchInput(label), 1800);
    } catch (_error) {
      // The picker may still be searchable only after typing; the caller handles that fallback.
    }
  }

  async function clickOptionByAliases(label, value) {
    const aliases = optionAliases(label, value);
    for (const alias of aliases) {
      if (await clickOptionMatching(alias, { exactOnly: true })) return true;
    }
    for (const alias of aliases) {
      if (await clickOptionMatching(alias, { allowContains: true })) return true;
    }
    return false;
  }

  function cellTitleText(element) {
    return cleanText((element.querySelector(".web_ui__Cell__title, [class*='web_ui__Cell__title'], [data-testid$='--title']") || {}).textContent || "");
  }

  function cleanSizeValue(value) {
    const raw = cleanText(String(value || "").split("·")[0]);
    if (!raw) return "";
    if (/one size/i.test(raw)) return "One size";

    const brandless = raw.replace(/^(?:nike|adidas|puma|reebok|new balance|converse|vans)\s*/i, "").trim();

    const alphaSizeMatch = brandless.match(/^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL)$/i);
    if (alphaSizeMatch) return alphaSizeMatch[0].toUpperCase();

    const wordSize = wordSizeAlias(brandless);
    if (wordSize) return wordSize;

    const ukMatch = brandless.match(/^UK\s*(\d+(?:\.\d+)?)$/i);
    if (ukMatch) return ukMatch[1];

    return brandless;
  }

  function normalizeSize(value) {
    return cleanSizeValue(value).toLowerCase();
  }

  function sizeAliases(value) {
    const raw = cleanText(String(value || "").split("·")[0]);
    const output = [
      cleanSizeValue(raw),
      raw
    ];

    const wordAlias = wordSizeAlias(raw);
    if (wordAlias) output.push(wordAlias);

    const normalized = raw.toLowerCase();
    const abbreviationAliases = {
      xxxs: ["3XS", "Extra extra extra small"],
      xxs: ["2XS", "Extra extra small"],
      xs: ["Extra small", "X small", "X-small"],
      s: ["Small"],
      m: ["Medium"],
      l: ["Large"],
      xl: ["Extra large", "X large", "X-large"],
      xxl: ["2XL", "Extra extra large", "XX large", "XX-large"],
      xxxl: ["3XL", "Extra extra extra large", "XXX large", "XXX-large"],
      xxxxl: ["4XL", "Extra extra extra extra large"]
    };

    for (const [shortSize, labels] of Object.entries(abbreviationAliases)) {
      if (normalizeSize(raw) === shortSize || labels.some((label) => normalized.includes(label.toLowerCase()))) {
        output.push(shortSize.toUpperCase(), ...labels);
      }
    }

    const parts = raw
      .split(/\s*(?:,|;|\||\/|>|›|\n)\s*/g)
      .map(cleanText)
      .filter(Boolean);
    for (const part of parts) {
      output.push(cleanSizeValue(part), part);
    }

    const ukMatch = raw.match(/\bUK\s*(\d+(?:\.\d+)?)\b/i);
    if (ukMatch) output.push(ukMatch[1], `UK ${ukMatch[1]}`);

    return Array.from(new Set(output.map(normalizeSize).filter(Boolean)));
  }

  function sizeTitleMatches(title, aliases) {
    const normalizedTitle = normalizeSize(title);
    if (!normalizedTitle) return false;
    if (aliases.includes(normalizedTitle)) return true;

    const titleParts = sizeLabelParts(title);
    return aliases.some((alias) => {
      if (!alias) return false;
      if (titleParts.includes(alias)) return true;
      return titleParts.some((part) => part === alias || (alias.length >= 3 && part.startsWith(alias)));
    });
  }

  function sizeLabelParts(value) {
    return String(value || "")
      .split(/\s*(?:,|;|\||\/|>|›|\n)\s*/g)
      .map(normalizeSize)
      .filter(Boolean);
  }

  function wordSizeAlias(value) {
    const normalized = cleanText(value).toLowerCase().replace(/[-_]+/g, " ");
    const aliases = [
      [/extra extra extra extra large|xxxx large|4x large|4xl/, "XXXXL"],
      [/extra extra extra small|xxx small|3x small|3xs/, "XXXS"],
      [/extra extra extra large|xxx large|3x large|3xl/, "XXXL"],
      [/extra extra small|xx small|2x small|2xs/, "XXS"],
      [/extra extra large|xx large|2x large|2xl/, "XXL"],
      [/\bextra small\b|\bx small\b|\bxsmall\b/, "XS"],
      [/\bextra large\b|\bx large\b|\bxlarge\b/, "XL"],
      [/\bsmall\b/, "S"],
      [/\bmedium\b/, "M"],
      [/\blarge\b/, "L"]
    ];

    const match = aliases.find(([pattern]) => pattern.test(normalized));
    return match ? match[1] : "";
  }

  function inferSizeFromListingTitle(value) {
    const title = cleanText(value);
    if (!title) return "";

    if (/one size/i.test(title)) return "One size";

    const explicit = title.match(/\b(?:size|labelled|label|tagged|tag)\s*[:\-]?\s*(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|3XS|2XS|2XL|3XL|4XL|small|medium|large|extra small|extra large|x-small|x-large)\b/i);
    if (explicit) return cleanSizeValue(explicit[1]);

    const ending = title.match(/\b(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|3XS|2XS|2XL|3XL|4XL|small|medium|large|extra small|extra large|x-small|x-large)\s*$/i);
    if (ending) return cleanSizeValue(ending[1]);

    const ukMatch = title.match(/\bUK\s*(\d+(?:\.\d+)?)\b/i);
    if (ukMatch) return ukMatch[1];

    return "";
  }

  function inferConditionFromBackupText(backup) {
    const text = backupText(backup);
    const labelled = text.match(/\bcondition\s*:\s*(new with tags|new without tags|very good|good|satisfactory)\b/i);
    if (labelled) return cleanConditionValue(labelled[1]);

    return "";
  }

  function inferColourFromBackupText(backup) {
    const text = backupText(backup);
    if (!text) return "";

    const labelled = text.match(/\bcolo[u]?r\s*:\s*([a-z ,&/]{3,60})(?:\.|£|$)/i);
    if (labelled) {
      const labelledColours = knownColourValuesFromText(labelled[1]);
      if (labelledColours.length) return labelledColours.join(", ");
    }

    return knownColourValuesFromText([
      backup && backup.title,
      backup && backup.cardTitle,
      backup && backup.description
    ].filter(Boolean).join(" ")).join(", ");
  }

  function knownColourValuesFromText(value) {
    const text = normalizeColour(value);
    if (!text) return [];

    const colours = [
      ["Light blue", /\blight blue\b/g],
      ["Dark green", /\bdark green\b/g],
      ["Mustard", /\bmustard(?: yellow)?\b/g],
      ["Yellow", /\byellow\b/g],
      ["Silver", /\bsilver\b/g],
      ["Gold", /\bgold\b/g],
      ["Multi", /\bmulticolour\b/g],
      ["Clear", /\b(clear|transparent)\b/g],
      ["Turquoise", /\b(turquoise|teal)\b/g],
      ["Mint", /\bmint(?: green)?\b/g],
      ["Green", /\bgreen\b/g],
      ["Khaki", /\bkhaki(?: green)?\b/g],
      ["Brown", /\b(brown|tan)\b/g],
      ["Rose", /\b(rose(?: pink)?|blush)\b/g],
      ["Purple", /\b(purple|violet)\b/g],
      ["Lilac", /\b(lilac|lavender)\b/g],
      ["Blue", /\b(blue|denim)\b/g],
      ["Navy", /\b(navy(?: blue)?|dark blue)\b/g],
      ["Apricot", /\bapricot\b/g],
      ["Orange", /\borange\b/g],
      ["Coral", /\bcoral(?: orange)?\b/g],
      ["Red", /\bred\b/g],
      ["Burgundy", /\b(burgundy(?: red)?|maroon)\b/g],
      ["Pink", /\bpink\b/g],
      ["Black", /\bblack\b/g],
      ["Grey", /\bgrey\b/g],
      ["White", /\bwhite\b/g],
      ["Cream", /\bcream\b/g],
      ["Beige", /\b(beige|nude)\b/g]
    ];

    const matches = [];
    for (const [label, pattern] of colours) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        matches.push({
          label,
          index: match.index || 0,
          end: (match.index || 0) + match[0].length
        });
      }
    }

    const seen = new Set();
    const usedRanges = [];
    return matches
      .sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index))
      .filter((match) => {
        const overlaps = usedRanges.some((range) => match.index < range.end && match.end > range.index);
        if (overlaps) return false;
        usedRanges.push({ index: match.index, end: match.end });
        return true;
      })
      .map((match) => match.label)
      .filter((label) => {
        const key = normalizeColour(label);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function backupText(backup) {
    return cleanText([
      backup && backup.cardTitle,
      backup && backup.title,
      backup && backup.description,
      backup && backup.sourceUrl
    ].filter(Boolean).join(" "));
  }

  function cleanConditionValue(value) {
    const raw = cleanText(String(value || "").split("·").pop() || value);
    const normalizedValue = canonicalCondition(raw);
    const labels = {
      "new with tags": "New with tags",
      "new without tags": "New without tags",
      "very good": "Very good",
      good: "Good",
      satisfactory: "Satisfactory"
    };
    return labels[normalizedValue] || raw;
  }

  function normalizeCondition(value) {
    return canonicalCondition(value);
  }

  function canonicalCondition(value) {
    const normalized = cleanText(value)
      .toLowerCase()
      .replace(/\bnew without tag\b/g, "new without tags")
      .replace(/\bnew with tag\b/g, "new with tags")
      .replace(/\bnew without label\b/g, "new without tags")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (/\bnew with tags\b/.test(normalized)) return "new with tags";
    if (/\bnew without tags\b/.test(normalized)) return "new without tags";
    if (/\bvery good\b/.test(normalized)) return "very good";
    if (/\bsatisfactory\b/.test(normalized)) return "satisfactory";
    if (/\bgood\b/.test(normalized)) return "good";

    return normalized;
  }

  function normalizeColour(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/\bcolors\b/g, "colours")
      .replace(/\bgray\b/g, "grey")
      .replace(/\bmulticolou?red\b/g, "multicolour")
      .replace(/\bmulticolor\b/g, "multicolour")
      .replace(/\bmulti colour\b/g, "multicolour")
      .replace(/\bmulti color\b/g, "multicolour")
      .replace(/\bmulti\b/g, "multicolour")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function conditionIdFor(normalizedCondition) {
    return {
      "new without tags": "1",
      "very good": "2",
      good: "3",
      satisfactory: "4",
      "new with tags": "6"
    }[normalizedCondition] || "";
  }

  function optionAliases(label, value) {
    const output = [String(value || "")];
    const normalizedLabel = normalize(label);
    const normalizedValue = normalize(value);

    if ((normalizedLabel === "colour" || normalizedLabel === "color") && normalizedValue === "multi") {
      output.push("Multicolour", "Multicolored", "Multicolor", "Multicoloured");
    }
    if (normalizedLabel === "condition" && normalizedValue === "new without tags") {
      output.push("New without label", "New without tag");
    }

    return Array.from(new Set(output.map(cleanText).filter(Boolean)));
  }

  function colourAliases(value) {
    const rawValues = splitColourValues(value);
    const output = rawValues.length ? rawValues : [String(value || "")];

    for (const rawValue of output.slice()) {
      const normalized = normalizeColour(rawValue);
      const aliases = {
        grey: ["Gray"],
        multicolour: ["Multi", "Multicolor", "Multicolored", "Multicoloured", "Multi colour", "Multi color"],
        clear: ["Transparent"],
        beige: ["Nude"],
        brown: ["Tan"],
        navy: ["Dark blue"],
        burgundy: ["Maroon"],
        purple: ["Violet"],
        lilac: ["Lavender"],
        rose: ["Blush"],
        turquoise: ["Teal"],
        blue: ["Denim"]
      }[normalized] || [];
      output.push(...aliases);
    }

    return Array.from(new Set(output.map(normalizeColour).filter(Boolean)));
  }

  async function fillKnownField(label, value) {
    if (!value) return false;

    const directInput = findInputByNames([label], 'input:not([type="file"]):not([type="hidden"]), [role="combobox"], [role="textbox"]');
    if (directInput && !isLikelyButtonBackedSelect(directInput)) {
      setControlValue(directInput, value);
      return true;
    }

    const nativeSelect = findInputByNames([label], "select");
    if (nativeSelect && selectNativeOption(nativeSelect, value)) return true;

    return selectCustomOption(label, value);
  }

  function findInputByNames(names, selector) {
    const lowered = names.map((name) => name.toLowerCase());
    const controls = Array.from(document.querySelectorAll(selector)).filter(isVisible);

    for (const control of controls) {
      const haystack = [
        control.getAttribute("name"),
        control.getAttribute("id"),
        control.getAttribute("aria-label"),
        control.getAttribute("placeholder"),
        control.getAttribute("data-testid"),
        labelTextFor(control),
        nearbyText(control)
      ].filter(Boolean).join(" ").toLowerCase();

      if (lowered.some((name) => haystack.includes(name))) {
        return control;
      }
    }

    return null;
  }

  function selectNativeOption(select, value) {
    const wanted = normalize(value);
    const option = Array.from(select.options).find((candidate) => normalize(candidate.textContent) === wanted);
    if (!option) return false;
    select.value = option.value;
    dispatchInputEvents(select);
    return true;
  }

  async function selectCustomOption(label, value) {
    const opener = findCustomSelectOpener(label);
    if (!opener) return false;

    opener.click();
    await delay(200);

    const wanted = normalize(value);
    const options = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], button, li, a'))
      .filter(isVisible)
      .filter((element) => normalize(element.textContent || element.getAttribute("aria-label") || "") === wanted);

    if (!options.length) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }

    activateOption(options[0]);
    await delay(100);
    return true;
  }

  async function clickOptionMatching(value, options) {
    const option = findVisibleOption(value, options || {});
    if (!option) return false;
    option.scrollIntoView({ block: "center", inline: "nearest" });
    activateOption(option);
    await delay(150);
    return true;
  }

  async function clickCategorySuggestion(parts, options) {
    const suggestion = findCategorySuggestion(parts, options || {});
    if (!suggestion) return false;

    return selectCategorySuggestion(suggestion);
  }

  async function selectCategorySuggestion(suggestion) {
    suggestion.scrollIntoView({ block: "center", inline: "nearest" });

    for (const target of categorySuggestionClickTargets(suggestion)) {
      clickElement(target);
      const settled = await waitForOptional(() => categorySelectionSettled(suggestion), 1800);
      if (settled) return true;
    }

    return false;
  }

  function categorySuggestionClickTargets(suggestion) {
    return Array.from(new Set([
      suggestion.querySelector(".web_ui__Cell__body, [class*='web_ui__Cell__body']"),
      suggestion.querySelector(".web_ui__Cell__content, [class*='web_ui__Cell__content']"),
      suggestion.querySelector(".web_ui__Cell__heading, [class*='web_ui__Cell__heading']"),
      suggestion.querySelector(".web_ui__Cell__title, [class*='web_ui__Cell__title']"),
      suggestion,
      suggestion.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button']"),
      suggestion.querySelector('input[type="radio"]')
    ].filter(Boolean).filter(isVisible)));
  }

  function categorySelectionSettled(suggestion) {
    return !isStillVisible(suggestion) ||
      findCustomSelectOpener("brand") ||
      findCustomSelectOpener("size") ||
      findCustomSelectOpener("condition");
  }

  function findCategorySuggestion(parts, options) {
    const targetPath = normalizePath(parts.join(" > "));
    const targetParentPath = normalizePath(parts.slice(0, -1).join(" > "));
    const targetLeaf = normalize(parts[parts.length - 1]);

    const candidates = getCategorySuggestionCandidates();
    if (options.preferFirstSuggestion && candidates.length) {
      const exact = bestMatchingCategorySuggestion(candidates, targetPath, targetParentPath, targetLeaf);
      return exact || candidates[0];
    }

    return bestMatchingCategorySuggestion(candidates, targetPath, targetParentPath, targetLeaf);
  }

  function getCategorySuggestionCandidates() {
    const nodes = Array.from(document.querySelectorAll([
      '[id^="catalog-suggestion-"]',
      'input[type="radio"][id*="catalog-suggestion"]',
      'input[type="radio"][aria-labelledby^="catalog-suggestion-"]',
      'label[for*="catalog-suggestion"]'
    ].join(",")));

    return Array.from(new Set(nodes
      .map((node) => node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='button']") || node)))
      .filter(isVisible)
      .filter((element) => element.id.startsWith("catalog-suggestion-") ||
        element.querySelector('input[type="radio"][id*="catalog-suggestion"], input[type="radio"][aria-labelledby^="catalog-suggestion-"], label[for*="catalog-suggestion"], .web_ui__Radio__button, [class*="web_ui__Radio__button"]'));
  }

  function bestMatchingCategorySuggestion(candidates, targetPath, targetParentPath, targetLeaf) {
    let best = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const suggestion = categorySuggestionData(candidate);
      const fullPath = normalizePath(suggestion.fullPath);
      const bodyPath = normalizePath(suggestion.body);
      const title = normalize(suggestion.title);
      const textPath = normalizePath(suggestion.text);
      let score = 0;

      if (fullPath && fullPath === targetPath) score = 100;
      else if (bodyPath && bodyPath === targetParentPath && title === targetLeaf) score = 95;
      else if (bodyPath && bodyPath === targetPath) score = 90;
      else if (textPath && textPath === targetPath) score = 80;
      else if (fullPath && fullPath.includes(targetPath)) score = 60;
      else if (textPath && textPath.includes(targetPath)) score = 50;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  function categorySuggestionData(element) {
    const title = cleanText((element.querySelector(".web_ui__Cell__title, [class*='web_ui__Cell__title']") || {}).textContent || "");
    const body = cleanText((element.querySelector(".web_ui__Cell__body, [class*='web_ui__Cell__body']") || {}).textContent || "");
    const bodyParts = splitCategoryPath(body);
    const fullParts = bodyParts.slice();
    if (title && normalize(title) !== normalize(fullParts[fullParts.length - 1])) {
      fullParts.push(title);
    }

    return {
      title,
      body,
      fullPath: fullParts.join(" > "),
      text: cleanText(element.textContent || "")
    };
  }

  function findOpenCategorySearchInput() {
    const active = document.activeElement;
    if (active && isPickerSearchInput(active, "category")) {
      return active;
    }

    const inputs = Array.from(document.querySelectorAll('input:not([type="file"]):not([type="hidden"]), [role="textbox"], [role="combobox"]'))
      .filter(isVisible);
    return inputs.find((input) => isPickerSearchInput(input, "category")) || null;
  }

  function findOpenPickerSearchInput(label) {
    if (normalize(label) === "brand") return findBrandSearchInput();
    if (normalize(label) === "size" || normalize(label) === "condition") return null;

    const active = document.activeElement;
    if (active && isPickerSearchInput(active, label)) {
      return active;
    }

    const inputs = Array.from(document.querySelectorAll('input:not([type="file"]):not([type="hidden"]), [role="textbox"], [role="combobox"]'))
      .filter(isVisible)
      .filter((input) => isPickerSearchInput(input, label));

    return inputs[0] || null;
  }

  function isPickerSearchInput(control, label) {
    if (!control || !control.matches || !control.matches('input:not([type="file"]):not([type="hidden"]), [role="textbox"], [role="combobox"]')) return false;
    if (!isVisible(control)) return false;
    if (control.disabled || control.readOnly) return false;
    if (isMainListingTextInput(control) || isGlobalSearchInput(control)) return false;

    const normalizedLabel = normalize(label);
    const text = controlHaystack(control).toLowerCase();
    const pickerRoot = control.closest('[role="dialog"], [data-testid*="modal" i], .web_ui__List__list, [class*="web_ui__List__list"], [class*="Drawer"], [class*="Popover"]');

    if (normalizedLabel === "category") return /category|catalog|catalogue/.test(text) && Boolean(pickerRoot || document.activeElement === control);
    if (normalizedLabel === "colour" || normalizedLabel === "color") return /colo[u]?r|search|select/.test(text) && Boolean(pickerRoot);
    if (normalizedLabel === "material") return /material|search|select/.test(text) && Boolean(pickerRoot);
    if (normalizedLabel.includes("parcel") || normalizedLabel.includes("package")) return /parcel|package|search|select/.test(text) && Boolean(pickerRoot);

    return /search|select/.test(text) && Boolean(pickerRoot);
  }

  function isMainListingTextInput(control) {
    const text = [
      control.getAttribute("name"),
      control.getAttribute("id"),
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("data-testid"),
      labelTextFor(control),
      nearbyText(control)
    ].filter(Boolean).join(" ").toLowerCase();
    return /\b(title|description|describe your item|price|amount)\b/.test(text);
  }

  function isGlobalSearchInput(control) {
    const text = controlHaystack(control).toLowerCase();
    return control.id === "search_text" ||
      control.getAttribute("name") === "search_text" ||
      control.getAttribute("data-testid") === "search-text--input" ||
      /search for items|catalogue/.test(text) && control.closest('form[action="/catalog"]');
  }

  async function waitForDependentCategoryFields() {
    try {
      await waitFor(() => (
        findCustomSelectOpener("brand") ||
        findCustomSelectOpener("size") ||
        findCustomSelectOpener("condition") ||
        findCustomSelectOpener("colour") ||
        findCustomSelectOpener("color")
      ), 5000);
    } catch (_error) {
      // If Vinted is slow or a category has fewer fields, the individual field fillers will report warnings.
    }
  }

  function activateOption(element) {
    const scope = element.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], [role='option'], [role='button'], li, label") || element;
    const radioButton = (element.matches && element.matches(".web_ui__Radio__button, [class*='web_ui__Radio__button']"))
      ? element
      : scope.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button']");
    const radio = element.matches && element.matches('input[type="radio"]')
      ? element
      : scope.querySelector('input[type="radio"]');
    if (radioButton) {
      clickElement(radioButton);
      if (radio && !radio.checked) clickElement(radio);
      if (radio && !radio.checked) setCheckedState(radio, true);
      if (radio) dispatchInputEvents(radio);
      return;
    }

    if (radio) {
      clickElement(radio);
      if (!radio.checked) setCheckedState(radio, true);
      dispatchInputEvents(radio);
      return;
    }

    const checkboxButton = (element.matches && element.matches(".web_ui__Checkbox__button, [class*='web_ui__Checkbox__button']"))
      ? element
      : scope.querySelector(".web_ui__Checkbox__button, [class*='web_ui__Checkbox__button']");
    const scopedCheckbox = scope.querySelector('input[type="checkbox"]');
    if (checkboxButton) {
      clickElement(checkboxButton);
      if (scopedCheckbox) dispatchInputEvents(scopedCheckbox);
      return;
    }

    const checkbox = element.matches && element.matches('input[type="checkbox"]')
      ? element
      : element.querySelector('input[type="checkbox"]');
    if (checkbox) {
      clickElement(checkbox);
      dispatchInputEvents(checkbox);
      return;
    }

    clickElement(scope);
  }

  function clickElement(element) {
    if (!element) return;
    if (typeof element.focus === "function") element.focus();
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    }
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    if (typeof element.click === "function") {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  }

  function findVisibleOption(value, options) {
    const wanted = options.path ? normalizePath(value) : normalize(value);
    const candidates = getOptionCandidates();
    const exact = candidates.find((element) => {
      const text = optionText(element);
      return options.path ? normalizePath(text) === wanted : normalize(text) === wanted;
    });
    if (exact) return exact;

    if (options.exactOnly) return null;

    const contains = candidates.find((element) => {
      const text = optionText(element);
      if (options.path) return normalizePath(text).includes(wanted);
      return normalize(text).includes(wanted);
    });
    if (contains) return contains;

    if (!options.path && options.allowContains) {
      return candidates.find((element) => wanted.includes(normalize(optionText(element))));
    }

    return null;
  }

  function getOptionCandidates() {
    const selector = [
      '[role="option"]',
      '[role="menuitem"]',
      'button',
      'li',
      'a',
      'label',
      '[id^="catalog-suggestion-"]',
      '[data-testid*="option"]',
      '[data-testid*="select"]',
      '[class*="option"]',
      '[class*="Option"]',
      '.web_ui__Cell__cell.web_ui__Cell__clickable',
      '[class*="cell"]',
      '[class*="Cell"]'
    ].join(",");

    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .filter((element) => {
        const text = optionText(element);
        return text && text.length <= 260 && !/^(sell now|save draft|upload photos|add photos)$/i.test(text);
      })
      .sort((a, b) => optionCandidateScore(b) - optionCandidateScore(a));
  }

  function optionText(element) {
    return cleanText(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "");
  }

  function optionCandidateScore(element) {
    let score = 0;
    if (element.querySelector(".web_ui__Radio__button, [class*='web_ui__Radio__button'], input[type='radio']")) score += 100;
    if (element.querySelector(".web_ui__Checkbox__button, [class*='web_ui__Checkbox__button'], input[type='checkbox']")) score += 90;
    if (element.matches(".web_ui__Cell__cell.web_ui__Cell__clickable, [class*='web_ui__Cell__clickable']")) score += 30;
    if (element.closest('[role="dialog"], [data-testid*="modal" i], .web_ui__List__list, [class*="web_ui__List__list"]')) score += 20;
    if (element.matches('[role="option"], [role="menuitem"]')) score += 15;
    if (element.matches("button, label")) score += 8;
    if (optionText(element).length <= 80) score += 5;
    return score;
  }

  function findCustomSelectOpener(label) {
    const aliases = fieldLabelAliases(label);
    for (const alias of aliases) {
      const labelledOpener = findFieldOpenerByLabel(alias);
      if (labelledOpener) return labelledOpener;
    }

    const lowered = aliases.map((alias) => alias.toLowerCase());
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input:not([type="file"])')).filter(isVisible);
    return candidates.find((candidate) => {
      const text = controlHaystack(candidate).toLowerCase();
      return lowered.some((alias) => text.includes(alias)) && !isNonFieldControl(candidate);
    }) || null;
  }

  function fieldLabelAliases(label) {
    const normalizedLabel = normalize(label);
    const aliases = {
      category: ["Category", "Catalogue"],
      brand: ["Brand"],
      size: ["Size"],
      condition: ["Condition"],
      colour: ["Colour", "Color"],
      color: ["Color", "Colour"],
      material: ["Material", "Materials"],
      "parcel size": ["Parcel size", "Package size"],
      "package size": ["Package size", "Parcel size"]
    }[normalizedLabel] || [label];

    return Array.from(new Set(aliases.map(cleanText).filter(Boolean)));
  }

  function findFieldOpenerByLabel(label) {
    const wanted = normalize(label);
    const labelElements = Array.from(document.querySelectorAll("label, span, div, p, h2, h3"))
      .filter(isVisible)
      .filter((element) => {
        const text = normalize(element.textContent || "");
        return text === wanted || text === `${wanted}optional` || text === `${wanted}required` ||
          text.startsWith(`${wanted} `) && /optional|required|information/.test(text);
      });

    for (const labelElement of labelElements) {
      let root = labelElement.parentElement;
      for (let depth = 0; root && depth < 7; depth += 1, root = root.parentElement) {
        const rootText = cleanText(root.textContent || "");
        if (!rootText || rootText.length > 1200) continue;
        if (!normalize(rootText).includes(wanted)) continue;

        const opener = findBestOpenerInside(root, labelElement);
        if (opener) return opener;
      }
    }

    return null;
  }

  function findBestOpenerInside(root, labelElement) {
    const controls = Array.from(root.querySelectorAll([
      'button',
      '[role="button"]',
      '[role="combobox"]',
      '[aria-haspopup]',
      'input:not([type="file"]):not([type="hidden"])',
      '.web_ui__Cell__cell.web_ui__Cell__clickable',
      '[class*="web_ui__Cell__cell"][class*="web_ui__Cell__clickable"]'
    ].join(",")))
      .filter(isVisible)
      .filter((control) => control !== labelElement && !labelElement.contains(control))
      .filter((control) => !isNonFieldControl(control));

    if (!controls.length) return null;

    return controls
      .map((control) => ({
        control,
        score: openerScore(control, labelElement)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.control || null;
  }

  function openerScore(control, labelElement) {
    let score = 1;
    const position = labelElement.compareDocumentPosition(control);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) score += 20;
    if (control.matches('input:not([type="file"]):not([type="hidden"])')) score += 12;
    if (control.matches('button, [role="button"], [role="combobox"], [aria-haspopup]')) score += 10;
    if (control.matches('.web_ui__Cell__cell.web_ui__Cell__clickable, [class*="web_ui__Cell__clickable"]')) score += 10;
    if (/select|choose|add|search/i.test(controlHaystack(control))) score += 4;
    return score;
  }

  function isNonFieldControl(control) {
    const text = controlHaystack(control).toLowerCase();
    return /sell now|save draft|upload photos|add photos|photo|image search|search for items|catalogue$|messages|notifications|favourites|help|menu opened|delete|remove/i.test(text) ||
      control.matches('[type="submit"], [data-testid*="search" i], [data-testid*="photo" i], [data-testid*="image" i]');
  }

  function controlHaystack(control) {
    return [
      control.textContent,
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("data-testid"),
      control.getAttribute("name"),
      control.getAttribute("id"),
      labelTextFor(control),
      nearbyText(control)
    ].filter(Boolean).join(" ");
  }

  function splitCategoryPath(value) {
    return String(value || "")
      .split(/\s*(?:>|›|\/)\s*/g)
      .map(cleanText)
      .filter(Boolean);
  }

  function splitToggleValues(value) {
    return String(value || "")
      .split(/\s*(?:,|;|\||\/|\n)\s*/g)
      .map(cleanText)
      .filter(Boolean);
  }

  function splitColourValues(value) {
    const values = String(value || "")
      .split(/\s*(?:,|;|\||\/|\n|\s+(?:and|&)\s+)\s*/g)
      .map(cleanText)
      .filter(Boolean);
    if (values.length > 1) return values;

    const knownColours = knownColourValuesFromText(value);
    return knownColours.length > 1 ? knownColours : values;
  }

  function closeOpenPicker() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function isLikelyButtonBackedSelect(control) {
    const role = control.getAttribute("role") || "";
    return /combobox|button/i.test(role);
  }

  async function uploadImages(imageDataUrls) {
    const warnings = [];
    if (!imageDataUrls.length) {
      throw new Error("No cached images were available to upload.");
    }

    const input = Array.from(document.querySelectorAll('input[type="file"]')).find((candidate) => {
      const accept = candidate.getAttribute("accept") || "";
      return !accept || /image|\*/i.test(accept);
    });
    if (!input) {
      throw new Error("Could not find the Vinted photo upload field.");
    }

    const transfer = new DataTransfer();
    for (const image of imageDataUrls.sort((a, b) => a.index - b.index)) {
      const blob = dataUrlToBlob(image.dataUrl, image.mimeType);
      transfer.items.add(new File([blob], image.filename || `vinted-${image.index + 1}.jpg`, { type: image.mimeType || blob.type }));
    }

    input.files = transfer.files;
    dispatchInputEvents(input);

    try {
      await waitFor(() => countNearbyImagePreviews(input) >= imageDataUrls.length, 8000);
    } catch (_error) {
      warnings.push(`Could not confirm all ${imageDataUrls.length} uploaded image previews.`);
    }

    return { warnings };
  }

  function countNearbyImagePreviews(input) {
    let root = input.parentElement;
    for (let index = 0; root && index < 6; index += 1, root = root.parentElement) {
      const images = Array.from(root.querySelectorAll("img")).filter(isVisible);
      if (images.length) return images.length;
    }
    return Array.from(document.querySelectorAll("form img")).filter(isVisible).length;
  }

  function setControlValue(control, value) {
    if (control.isContentEditable) {
      control.textContent = value;
      dispatchInputEvents(control);
      return;
    }

    setNativeControlValue(control, value);
    dispatchInputEvents(control);
  }

  function setNativeControlValue(control, value) {
    const prototype = Object.getPrototypeOf(control);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(control, value);
    } else {
      control.value = value;
    }
  }

  function pasteControlValue(control, value) {
    if (typeof control.focus === "function") control.focus();
    setControlValue(control, "");
    setControlValue(control, value);
    try {
      control.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText"
      }));
    } catch (_error) {
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }
    control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: String(value).slice(-1) || " " }));
  }

  function priceTextForTyping(value) {
    const raw = String(value || "").replace(/[^\d.,]/g, "").trim();
    const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw.replace(/,/g, "");
    return normalized.replace(/\.00$/, "");
  }

  async function commitPriceValue(control, value) {
    if (typeof control.focus === "function") control.focus();
    if (typeof control.click === "function") control.click();

    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a", ctrlKey: true }));
    control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "a", ctrlKey: true }));
    setControlValue(control, "");
    await delay(50);

    for (const key of String(value || "")) {
      control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
      control.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key }));
      setNativeControlValue(control, `${control.value || ""}${key}`);
      try {
        control.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: key,
          inputType: "insertText"
        }));
      } catch (_error) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
      }
      control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key }));
      await delay(30);
    }

    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(100);
    control.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function dispatchInputEvents(control) {
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setCheckedState(control, checked) {
    const prototype = Object.getPrototypeOf(control);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "checked");
    if (descriptor && descriptor.set) {
      descriptor.set.call(control, checked);
    } else {
      control.checked = checked;
    }
  }

  function labelTextFor(control) {
    const id = control.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (label) return label.textContent || "";
    }

    const wrapped = control.closest("label");
    if (wrapped) return wrapped.textContent || "";
    return "";
  }

  function nearbyText(control) {
    let current = control.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const text = current.textContent || "";
      if (text.trim().length <= 160) return text;
    }
    return "";
  }

  function dataUrlToBlob(dataUrl, fallbackMimeType) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    if (!match) throw new Error("Cached image data was not readable.");
    const mimeType = match[1] || fallbackMimeType || "application/octet-stream";
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out waiting for the Vinted form."));
          return;
        }
        window.setTimeout(tick, 250);
      };
      tick();
    });
  }

  async function waitForOptional(predicate, timeoutMs) {
    try {
      return await waitFor(predicate, timeoutMs);
    } catch (_error) {
      return null;
    }
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function isStillVisible(element) {
    return Boolean(element && document.documentElement.contains(element) && isVisible(element));
  }

  function normalize(value) {
    return cleanText(value).toLowerCase();
  }

  function normalizePath(value) {
    return splitCategoryPath(value).map(normalize).join(" > ");
  }

  function cleanText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
