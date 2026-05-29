(async function () {
  "use strict";

  const sourceUrl = window.location.href;
  const itemId = (sourceUrl.match(/\/items\/(\d+)/) || [])[1] || "";
  const warnings = [];
  const carouselImageUrlCache = [];

  await waitForPageReady();
  await waitForListingContent();

  const pageText = normalizedText(document.body.innerText || "");
  if (detectBlockedState(pageText)) {
    return fail("Vinted appears to be showing a login, captcha, or security check.");
  }

  const jsonLdProduct = extractJsonLdProduct();
  const root = document.querySelector("main") || document.body;
  const title = firstText([
    jsonLdProduct && jsonLdProduct.name,
    textFromSelector('h1[data-testid*="title" i]'),
    textFromSelector("h1")
  ]);

  await expandCollapsedDescription();
  const description = extractDescription(root, title, jsonLdProduct);

  const price = extractPrice(jsonLdProduct, root);
  const attributes = extractAttributes(root);
  if (jsonLdProduct && jsonLdProduct.brand && !attributes.brand) {
    attributes.brand = typeof jsonLdProduct.brand === "string" ? jsonLdProduct.brand : jsonLdProduct.brand.name;
  }
  if (!attributes.size) {
    attributes.size = inferSizeFromText([title, contextTitleText(root, title), contextAttributeText(root)].join(" "));
  }
  const category = extractCategory(attributes.brand);
  if (category) attributes.category = category;

  const previewImageUrls = extractNumberedPreviewImages(title);
  const embeddedImageUrls = extractEmbeddedListingImages(previewImageUrls);
  if (embeddedImageUrls.length <= previewImageUrls.length) {
    await openFullImageCarouselIfPossible(title);
  }
  const imageUrls = extractImages(jsonLdProduct, title, embeddedImageUrls);
  const images = imageUrls.map((originalUrl, index) => ({
    index,
    originalUrl
  }));

  if (!title) warnings.push("Could not confidently extract the title.");
  if (!description) warnings.push("Could not confidently extract the description.");
  if (!price.amount) warnings.push("Could not confidently extract the price.");
  if (!images.length) warnings.push("Could not extract listing images.");

  return {
    ok: true,
    data: {
      itemId,
      sourceUrl,
      title,
      description,
      price,
      attributes,
      images
    },
    warnings
  };

  function fail(message) {
    return { ok: false, error: message, data: { itemId, sourceUrl }, warnings };
  }

  function detectBlockedState(text) {
    const lower = text.toLowerCase();
    return (
      lower.includes("verify you are human") ||
      lower.includes("security check") ||
      lower.includes("captcha") ||
      (lower.includes("log in") && lower.includes("sign up") && !lower.includes("buy now"))
    );
  }

  function extractJsonLdProduct() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      const parsed = safeJson(script.textContent);
      const product = findProduct(parsed);
      if (product) return product;
    }
    return null;
  }

  function findProduct(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findProduct(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    const type = value["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return value;
    if (value["@graph"]) return findProduct(value["@graph"]);
    return null;
  }

  function extractPrice(product, rootElement) {
    const offer = product && (Array.isArray(product.offers) ? product.offers[0] : product.offers);
    const productAmount = offer && (offer.price || offer.lowPrice);
    const productCurrency = offer && offer.priceCurrency;
    if (productAmount) {
      return {
        amount: String(productAmount),
        currency: productCurrency || currencyFromText(String(productAmount))
      };
    }

    const lines = getLines(rootElement.innerText || "");
    const priceLine = lines.find((line) => /^[£$€]\s?\d+(?:[.,]\d{1,2})?$/.test(line));
    if (!priceLine) return { amount: "", currency: "" };
    return {
      amount: priceLine.replace(/[^\d.,]/g, ""),
      currency: currencyFromText(priceLine)
    };
  }

  function extractAttributes(rootElement) {
    const lines = getLines(rootElement.innerText || "");
    const attributes = extractStructuredAttributes(rootElement);
    const labels = {
      Brand: "brand",
      Size: "size",
      Condition: "condition",
      Colour: "colour",
      Color: "colour",
      Material: "material",
      Materials: "material",
      "Parcel size": "parcelSize",
      "Package size": "parcelSize"
    };

    for (let index = 0; index < lines.length; index += 1) {
      const key = labels[lines[index]];
      if (!key || attributes[key]) continue;

      const value = nextUsefulLine(lines, index + 1, Object.keys(labels));
      if (value) attributes[key] = value;
    }

    const summaryLine = lines.find((line) => /·/.test(line) && /new|good|satisfactory|tags/i.test(line));
    if (summaryLine) {
      const parts = summaryLine.split("·").map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2 && !attributes.size) attributes.size = cleanSummarySize(parts[0], attributes.brand);
      if (parts.length >= 2 && !attributes.condition) attributes.condition = parts[1];
    }

    return attributes;
  }

  function cleanSummarySize(value, brand) {
    let output = cleanText(value);
    const brandKey = compareText(brand);
    if (brandKey && compareText(output).startsWith(brandKey)) {
      output = output.slice(String(brand || "").length).trim();
    }

    const alphaSize = extractAlphaSize(output);
    if (alphaSize) return alphaSize;
    if (/one size/i.test(output)) return "One size";
    const ukMatch = output.match(/\bUK\s*(\d+(?:\.\d+)?)\b/i);
    if (ukMatch) return ukMatch[1];
    const numberMatches = Array.from(output.matchAll(/\d+(?:\.\d+)?/g)).map((match) => match[0]);
    if (numberMatches.length) return numberMatches[numberMatches.length - 1];
    return output;
  }

  function inferSizeFromText(value) {
    const text = cleanText(value);
    if (!text) return "";

    if (/one size/i.test(text)) return "One size";

    const explicitSize = text.match(/\b(?:size|labelled|label|tagged|tag)\s*[:\-]?\s*(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|3XS|2XS|2XL|3XL|4XL|\d+(?:\.\d+)?)\b/i);
    if (explicitSize) return normalizeAlphaSize(explicitSize[1]) || explicitSize[1];

    const ukSize = text.match(/\bUK\s*(\d+(?:\.\d+)?)\b/i);
    if (ukSize) return ukSize[1];

    const alphaSize = extractAlphaSize(text);
    if (alphaSize) return alphaSize;

    return "";
  }

  function extractAlphaSize(value) {
    const raw = cleanText(value);
    const direct = raw.match(/\b(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|3XS|2XS|2XL|3XL|4XL)\b/i);
    if (direct) return normalizeAlphaSize(direct[1]);

    const normalized = raw.toLowerCase().replace(/[-_]+/g, " ");
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

  function normalizeAlphaSize(value) {
    return {
      "3xs": "XXXS",
      "2xs": "XXS",
      xs: "XS",
      s: "S",
      m: "M",
      l: "L",
      xl: "XL",
      "2xl": "XXL",
      xxl: "XXL",
      "3xl": "XXXL",
      xxxl: "XXXL",
      "4xl": "XXXXL",
      xxxxl: "XXXXL"
    }[cleanText(value).toLowerCase()] || "";
  }

  function contextTitleText(rootElement, titleText) {
    const titleKey = compareText(titleText);
    const h1 = rootElement.querySelector("h1");
    if (!h1) return "";

    let current = h1.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const text = cleanTextFromElement(current);
      if (text && text.length < 500 && compareText(text).includes(titleKey)) return text;
    }
    return "";
  }

  function contextAttributeText(rootElement) {
    return Array.from(rootElement.querySelectorAll('[data-testid^="item-attributes-"], .details-list__item, .web_ui__Cell__cell.web_ui__Cell__default'))
      .map(cleanTextFromElement)
      .filter((text) => text && text.length < 180)
      .join(" ");
  }

  function extractStructuredAttributes(rootElement) {
    const attributes = {};
    const testIdMap = {
      brand: "brand",
      size: "size",
      status: "condition",
      condition: "condition",
      color: "colour",
      colour: "colour",
      material: "material",
      package_size: "parcelSize",
      package: "parcelSize"
    };
    const labelMap = {
      Brand: "brand",
      Size: "size",
      Condition: "condition",
      Colour: "colour",
      Color: "colour",
      Material: "material",
      Materials: "material",
      "Parcel size": "parcelSize",
      "Package size": "parcelSize"
    };

    const detailItems = getAttributeDetailItems(rootElement);
    for (const entry of detailItems) {
      const item = entry.item;
      const testId = entry.testId || item.getAttribute("data-testid") || "";
      const testKey = Object.keys(testIdMap).find((candidate) => testId.includes(`item-attributes-${candidate}`));
      const values = Array.from(item.querySelectorAll(".details-list__item-value"));
      const label = cleanTextFromElement(values[0] || item);
      const key = testIdMap[testKey] || labelMap[label];
      if (!key || attributes[key]) continue;

      const valueElement = values[1] ||
        attributeValueElementFor(item, entry.source) ||
        item.querySelector(".web_ui__Text__subtitle.web_ui__Text__bold, [class*='web_ui__Text__subtitle'][class*='web_ui__Text__bold']") ||
        item;
      const value = cleanAttributeValue(cleanTextFromElement(valueElement), testKey ? "" : label);
      if (value) attributes[key] = value;
    }

    const cells = Array.from(rootElement.querySelectorAll(".web_ui__Cell__cell.web_ui__Cell__default"));
    for (const cell of cells) {
      if (isVerificationText(cell.textContent || "")) continue;

      const title = cleanText((cell.querySelector(".web_ui__Cell__title, [class*='web_ui__Cell__title']") || {}).textContent || "");
      const body = cleanText((cell.querySelector(".web_ui__Cell__body, [class*='web_ui__Cell__body']") || {}).textContent || "");
      const titleKey = labelMap[title];
      if (titleKey && body && !attributes[titleKey]) {
        attributes[titleKey] = cleanAttributeValue(body, title);
        continue;
      }

      const parts = getLines(multilineTextFromElement(cell));
      if (!parts.length) continue;

      const key = labelMap[parts[0]];
      if (key && !attributes[key] && parts.length >= 2) {
        const value = cleanAttributeValue(parts.slice(1).join(" "), parts[0]);
        if (value) attributes[key] = value;
        continue;
      }

      const compactText = cleanText(parts.join(" "));
      const compactEntry = Object.entries(labelMap).find(([labelName]) => compareText(compactText).startsWith(compareText(labelName)));
      if (!compactEntry) continue;
      const [labelName, compactKey] = compactEntry;
      if (attributes[compactKey]) continue;
      const compactValue = cleanAttributeValue(compactText.slice(labelName.length), labelName);
      if (compactValue) attributes[compactKey] = compactValue;
    }

    return attributes;
  }

  function getAttributeDetailItems(rootElement) {
    const output = [];
    const seen = new Set();
    const nodes = Array.from(rootElement.querySelectorAll('[data-testid^="item-attributes-"], .details-list__item'));

    for (const node of nodes) {
      const testId = node.getAttribute("data-testid") || "";
      const item = node.matches(".details-list__item")
        ? node
        : node.closest(".web_ui__Cell__cell, [class*='web_ui__Cell__cell'], .details-list__item, li") ||
          attributeItemContainer(node) ||
          node;
      if (!item || seen.has(item)) continue;

      seen.add(item);
      output.push({ item, source: node, testId });
    }

    return output;
  }

  function attributeItemContainer(node) {
    let current = node.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const text = cleanTextFromElement(current);
      if (!text || text.length > 180) continue;
      if (/^(brand|size|condition|colour|color|material|parcel size|package size)\b/i.test(text) ||
        current.querySelector(".web_ui__Text__subtitle.web_ui__Text__bold, [class*='web_ui__Text__subtitle'][class*='web_ui__Text__bold']")) {
        return current;
      }
    }
    return null;
  }

  function attributeValueElementFor(item, source) {
    const sourceValue = source && source.closest(".web_ui__Text__subtitle.web_ui__Text__bold, [class*='web_ui__Text__subtitle'][class*='web_ui__Text__bold']");
    if (sourceValue && item.contains(sourceValue)) return sourceValue;

    return Array.from(item.querySelectorAll(".web_ui__Text__subtitle.web_ui__Text__bold, [class*='web_ui__Text__subtitle'][class*='web_ui__Text__bold']"))
      .find((element) => cleanTextFromElement(element)) || null;
  }

  function multilineTextFromElement(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, svg, title, [aria-hidden='true'], script, style").forEach((node) => node.remove());
    return cleanMultilineText(clone.innerText || clone.textContent || "");
  }

  function extractDescription(rootElement, titleText, product) {
    return firstMultilineText([
      extractFormattedDescription(rootElement, titleText),
      extractDataTestIdDescription(rootElement, titleText),
      isLikelyDescriptionText(product && product.description, compareText(titleText)) ? product.description : ""
    ]) || extractDescriptionFallback(rootElement, titleText);
  }

  function extractFormattedDescription(rootElement, titleText) {
    const titleKey = compareText(titleText);
    const candidates = Array.from(rootElement.querySelectorAll("span.web_ui__Text__format, [class*='web_ui__Text__format']"))
      .map((element) => ({
        element,
        text: cleanMultilineText(element.textContent || element.innerText || "")
      }))
      .filter((candidate) => isLikelyDescriptionElement(candidate.element, candidate.text, titleKey));

    if (!candidates.length) return "";

    candidates.sort((a, b) => descriptionScore(b.text) - descriptionScore(a.text));
    return candidates[0].text;
  }

  function extractDataTestIdDescription(rootElement, titleText) {
    const titleKey = compareText(titleText);
    const candidates = Array.from(rootElement.querySelectorAll('[data-testid*="description" i]'))
      .map((element) => ({
        element,
        text: cleanMultilineText(element.textContent || element.innerText || "")
      }))
      .filter((candidate) => isLikelyDescriptionElement(candidate.element, candidate.text, titleKey));

    if (!candidates.length) return "";

    candidates.sort((a, b) => descriptionScore(b.text) - descriptionScore(a.text));
    return candidates[0].text;
  }

  function isLikelyDescriptionElement(element, value, titleKey) {
    if (!isLikelyDescriptionText(value, titleKey)) return false;
    if (element.closest("h1, h2, h3, h4, h5, h6")) return false;

    const excluded = element.closest('[data-testid*="verification" i], [data-testid*="authenticity" i], [class*="verification" i], [class*="authenticity" i]');
    if (excluded) return false;

    const card = element.closest(".web_ui__Card__card, [class*='web_ui__Card__card']");
    if (card && isVerificationText(card.textContent || "")) return false;

    return true;
  }

  function isLikelyDescriptionText(value, titleKey) {
    const cleaned = cleanMultilineText(value);
    const key = compareText(cleaned);
    if (!cleaned) return false;
    if (isVerificationText(cleaned)) return false;
    if (titleKey && key === titleKey) return false;
    if (/^[£$€]\s?\d/.test(cleaned)) return false;
    if (/^(brand|size|condition|colour|color|material|postage|shipping)$/i.test(cleaned)) return false;
    if (/^(buy now|make an offer|ask seller|message seller)$/i.test(cleaned)) return false;
    return cleaned.length >= 4;
  }

  function isVerificationText(value) {
    return /item verification|checked for authenticity|trained team|this service is free|how does it work|verification service/i.test(String(value || ""));
  }

  function descriptionScore(value) {
    const lines = value.split("\n").filter(Boolean).length;
    return value.length + lines * 20;
  }

  async function expandCollapsedDescription() {
    const triggers = Array.from(document.querySelectorAll("button, [role='button'], a"))
      .filter(isVisibleElement)
      .filter((element) => {
        const clickableText = cleanText(Array.from(element.querySelectorAll(".web_ui__Text__clickable, [class*='web_ui__Text__clickable']"))
          .map((node) => node.textContent || "")
          .join(" "));
        const elementText = cleanText(element.textContent || "");
        return /^(?:\.\.\.|…)?\s*more$/i.test(clickableText) || /^(?:\.\.\.|…)?\s*more$/i.test(elementText);
      });

    for (const trigger of triggers.slice(0, 3)) {
      trigger.click();
      await delay(250);
    }
  }

  function extractCategory(brand) {
    const breadcrumbParts = extractBreadcrumbCategoryParts();
    if (breadcrumbParts.length) {
      const partsWithoutBrandLeaf = breadcrumbParts.length > 1 ? breadcrumbParts.slice(0, -1) : breadcrumbParts;
      return partsWithoutBrandLeaf.join(" > ");
    }

    const h1 = document.querySelector("h1");
    const links = Array.from(document.querySelectorAll('a[href*="/catalog"]'));
    const beforeTitle = [];
    for (const link of links) {
      if (h1 && link.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING) {
        beforeTitle.push(cleanText(link.textContent));
      }
    }
    const unique = dedupe(beforeTitle).filter((part) => part && part.length < 60);
    const categoryParts = removeBrandLeafCategory(unique, brand);
    return categoryParts.length ? categoryParts.join(" > ") : "";
  }

  function extractBreadcrumbCategoryParts() {
    const breadcrumbRoots = Array.from(document.querySelectorAll("ul.breadcrumbs, [class*='breadcrumbs']"))
      .filter((element) => element.querySelector('a[href*="/catalog"], span[itemprop="title"]'));

    for (const rootElement of breadcrumbRoots) {
      const parts = Array.from(rootElement.querySelectorAll('li span[itemprop="title"], li a[href*="/catalog"], span[itemprop="title"], a[href*="/catalog"]'))
        .map((element) => cleanText(element.textContent || ""))
        .filter(Boolean);
      const unique = dedupe(parts).filter((part) => part && part.length < 80);
      if (unique.length >= 2) return unique;
    }

    return [];
  }

  function removeBrandLeafCategory(parts, brand) {
    const output = parts.slice();
    if (!output.length) return output;

    const leaf = compareText(output[output.length - 1]);
    const brandKey = compareText(brand);
    if (brandKey && leaf.includes(brandKey)) {
      output.pop();
    }

    return output;
  }

  function extractDescriptionFallback(rootElement, titleText) {
    const lines = getLines(rootElement.innerText || "");
    const stopIndex = lines.findIndex((line) => /^postage$/i.test(line) || /^shipping$/i.test(line));
    const uploadedIndex = lines.findIndex((line) => /^uploaded$/i.test(line));
    const startIndex = uploadedIndex > -1 ? uploadedIndex + 2 : 0;
    const searchableLines = stopIndex > -1 ? lines.slice(startIndex, stopIndex) : lines.slice(startIndex);
    const blocked = new Set([
      "Brand",
      "Brand menu",
      "Size",
      "Condition",
      "Colour",
      "Color",
      "Uploaded",
      "Postage",
      "Buy now",
      "Make an offer",
      "Ask seller",
      "Includes Buyer Protection",
      titleText || ""
    ]);

    const candidates = searchableLines.filter((line) => {
      if (blocked.has(line)) return false;
      if (isVerificationText(line)) return false;
      if (/^[£$€]/.test(line)) return false;
      if (/^from [£$€]/i.test(line)) return false;
      if (/^[\w\s]+·/.test(line)) return false;
      return line.length >= 25;
    });

    return cleanMultilineText(candidates.join("\n"));
  }

  function extractImages(product, titleText, embeddedImageUrls) {
    const titleKey = compareText(titleText);
    if (embeddedImageUrls && embeddedImageUrls.length) {
      return dedupe(embeddedImageUrls.map(toAbsoluteUrl).filter(Boolean));
    }

    const carouselImages = extractCarouselImages();
    if (carouselImages.length) {
      return dedupe(carouselImages.map(toAbsoluteUrl).filter(Boolean));
    }

    const numberedPreviewImages = extractNumberedPreviewImages(titleText);
    if (numberedPreviewImages.length) {
      return dedupe(numberedPreviewImages.map(toAbsoluteUrl).filter(Boolean));
    }

    const vintedGalleryImages = Array.from(document.querySelectorAll('img.web_ui__Image__content, img[class*="web_ui__Image__content"], .web_ui__Image__content img, [class*="web_ui__Image__content"] img'));
    const exactListingImages = vintedGalleryImages
      .filter((image) => {
        const src = bestImageUrl(image);
        return src && titleKey && compareText(image.alt) === titleKey;
      })
      .map(bestImageUrl);

    if (exactListingImages.length) {
      return dedupe(exactListingImages.map(toAbsoluteUrl).filter(Boolean));
    }

    const h1 = document.querySelector("h1");
    const titleMatchedGalleryImages = vintedGalleryImages
      .filter((image) => {
        const src = bestImageUrl(image);
        const altKey = compareText(image.alt);
        const appearsBeforeTitle = !h1 || Boolean(image.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING);
        return src && titleKey && altKey.includes(titleKey) && appearsBeforeTitle;
      })
      .map(bestImageUrl);

    if (titleMatchedGalleryImages.length) {
      return dedupe(titleMatchedGalleryImages.map(toAbsoluteUrl).filter(Boolean));
    }

    const productImages = normalizeImageInput(product && product.image);
    const domImages = vintedGalleryImages
      .filter((image) => {
        const src = bestImageUrl(image);
        const alt = image.alt || "";
        if (!src || src.startsWith("data:")) return false;
        if (/logo|facebook|instagram|linkedin|app store|google play/i.test(alt)) return false;
        return titleKey && compareText(alt).includes(titleKey);
      })
      .map(bestImageUrl);

    return dedupe(productImages.concat(domImages).map(toAbsoluteUrl).filter(Boolean));
  }

  function extractEmbeddedListingImages(previewUrls) {
    if (!previewUrls.length) return [];

    const listingFileName = imageFileName(previewUrls[0]);
    if (!listingFileName) return [];

    const html = (document.documentElement && document.documentElement.innerHTML ? document.documentElement.innerHTML : "")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/\\\//g, "/");
    const matches = Array.from(html.matchAll(/https:\/\/images\d+\.vinted\.net\/t\/[^"'<>\\\s]+/g))
      .map((match, index) => ({
        url: normalizeEmbeddedImageUrl(match[0]),
        index
      }))
      .filter((entry) => entry.url && imageFileName(entry.url) === listingFileName);

    const byPhoto = new Map();
    for (const entry of matches) {
      const key = photoBaseKey(entry.url);
      if (!key) continue;

      const existing = byPhoto.get(key);
      if (!existing) {
        byPhoto.set(key, entry);
      } else if (isPreferredImageUrl(entry.url) && !isPreferredImageUrl(existing.url)) {
        byPhoto.set(key, { ...entry, index: existing.index });
      }
    }

    return Array.from(byPhoto.values())
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.url);
  }

  async function openFullImageCarouselIfPossible(titleText) {
    if (extractCarouselImages().length) return;

    const previews = getNumberedPreviewImageElements(titleText);
    if (!previews.length) return;

    const expectedCount = expectedImageCountFromPreviewLabels(previews);
    const target = findCarouselOpenTarget(previews);
    if (!target) return;

    const clickable = target.closest("button, a, [role='button'], [data-testid*='item-photo'], .item-photos__item") || target;
    if (typeof clickable.click === "function") {
      clickable.click();
    } else {
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }

    const startedAt = Date.now();
    let lastCount = 0;
    let stableCount = 0;
    let lastNextClickAt = 0;
    while (Date.now() - startedAt < 7000) {
      rememberCarouselImages();
      const currentCount = extractCarouselImages().length;
      const hasExpectedImages = expectedCount ? currentCount >= expectedCount : currentCount > previews.length;

      if (expectedCount && currentCount < expectedCount && Date.now() - lastNextClickAt > 350) {
        clickCarouselNextButton();
        lastNextClickAt = Date.now();
      }

      if (hasExpectedImages && currentCount === lastCount) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }

      if (hasExpectedImages && stableCount >= 2) {
        return;
      }

      lastCount = currentCount;
      await delay(100);
    }
  }

  function findCarouselOpenTarget(previews) {
    const labels = Array.from(document.querySelectorAll('[data-testid^="item-photo-"][data-testid$="--label"]'))
      .filter((label) => /\+\s*\d+/.test(label.textContent || ""));
    const visibleLabel = labels.find(isVisibleElement);
    const label = visibleLabel || labels[0];
    if (label) return label;

    const visiblePreview = previews.find((image) => {
      const testId = image.getAttribute("data-testid") || "";
      return /item-photo-5--img/.test(testId) && isVisibleElement(image);
    });
    if (visiblePreview) return visiblePreview;

    return previews[Math.min(4, previews.length - 1)];
  }

  function expectedImageCountFromPreviewLabels(previews) {
    const extraCounts = Array.from(document.querySelectorAll('[data-testid^="item-photo-"][data-testid$="--label"]'))
      .map((label) => {
        const match = (label.textContent || "").match(/\+\s*(\d+)/);
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((value) => Number.isFinite(value) && value > 0);

    if (!extraCounts.length) return 0;
    return previews.length + Math.max(...extraCounts);
  }

  function rememberCarouselImages() {
    for (const url of getCarouselImageUrlsFromDom()) {
      if (url && !carouselImageUrlCache.includes(url)) carouselImageUrlCache.push(url);
    }
  }

  function clickCarouselNextButton() {
    const button = document.querySelector('[data-testid="image-carousel-button-right"], .image-carousel__button--right');
    if (button && isVisibleElement(button)) button.click();
  }

  function extractCarouselImages() {
    rememberCarouselImages();
    return dedupe(carouselImageUrlCache.concat(getCarouselImageUrlsFromDom()));
  }

  function getCarouselImageUrlsFromDom() {
    return Array.from(document.querySelectorAll('[data-testid="image-carousel"] img[data-testid^="image-carousel-image"], .image-carousel img.image-carousel__image, img[data-testid^="image-carousel-image"]'))
      .map(bestImageUrl)
      .filter(Boolean);
  }

  function extractNumberedPreviewImages(titleText) {
    return getNumberedPreviewImageElements(titleText)
      .map(bestImageUrl)
      .filter(Boolean);
  }

  function getNumberedPreviewImageElements(titleText) {
    const titleKey = compareText(titleText);
    const images = Array.from(document.querySelectorAll('img[data-testid^="item-photo-"][data-testid$="--img"], img.web_ui__Image__content, img[class*="web_ui__Image__content"]'));
    const seen = new Map();

    for (const image of images) {
      const src = bestImageUrl(image);
      const testId = image.getAttribute("data-testid") || "";
      const orderMatch = testId.match(/item-photo-(\d+)--img/);
      const altKey = compareText(image.alt);
      const matchesTitle = titleKey && (altKey === titleKey || altKey.startsWith(`${titleKey} `));
      if (!src || !orderMatch || !matchesTitle) continue;

      const index = Number.parseInt(orderMatch[1], 10);
      if (!seen.has(index) || (!isVisibleElement(seen.get(index)) && isVisibleElement(image))) {
        seen.set(index, image);
      }
    }

    return Array.from(seen.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function normalizeImageInput(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.filter(Boolean);
    return [input];
  }

  function firstText(values) {
    for (const value of values) {
      const cleaned = cleanText(value);
      if (cleaned) return cleaned;
    }
    return "";
  }

  function firstMultilineText(values) {
    for (const value of values) {
      const cleaned = cleanMultilineText(value);
      if (cleaned) return cleaned;
    }
    return "";
  }

  function textFromSelector(selector) {
    const element = document.querySelector(selector);
    return element ? cleanText(element.innerText || element.textContent) : "";
  }

  function multilineTextFromSelector(selector) {
    const element = document.querySelector(selector);
    return element ? cleanMultilineText(element.innerText || element.textContent) : "";
  }

  function nextUsefulLine(lines, startIndex, labels) {
    for (let index = startIndex; index < Math.min(lines.length, startIndex + 4); index += 1) {
      const line = lines[index];
      if (!line || labels.includes(line) || /menu$/i.test(line)) continue;
      return line;
    }
    return "";
  }

  function cleanTextFromElement(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, svg, title, [aria-hidden='true'], script, style").forEach((node) => node.remove());
    return cleanText(clone.innerText || clone.textContent || "");
  }

  function cleanAttributeValue(value, label) {
    const cleaned = cleanText(value);
    if (!cleaned) return "";
    const labelKey = compareText(label);
    let output = cleaned;
    if (labelKey && compareText(output).startsWith(labelKey)) {
      output = output.slice(label.length).trim();
    }
    return output
      .replace(/\b(?:Brand menu|Size information|Condition information)\b/gi, "")
      .trim();
  }

  function cleanText(value) {
    return normalizedText(value || "").replace(/\n+/g, " ").trim();
  }

  function cleanMultilineText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizedText(value) {
    return String(value)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n");
  }

  function getLines(value) {
    return normalizedText(value)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function safeJson(value) {
    try {
      return JSON.parse(value || "null");
    } catch (_error) {
      return null;
    }
  }

  function currencyFromText(value) {
    if (value.includes("£")) return "GBP";
    if (value.includes("$")) return "USD";
    if (value.includes("€")) return "EUR";
    return "";
  }

  function toAbsoluteUrl(value) {
    try {
      return new URL(String(value), window.location.href).toString();
    } catch (_error) {
      return "";
    }
  }

  function dedupe(values) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
      const key = imageDedupeKey(value);
      if (!value || seen.has(key)) continue;
      seen.add(key);
      output.push(value);
    }
    return output;
  }

  function imageDedupeKey(value) {
    const raw = String(value || "").split("#")[0].replace(/([?&])(width|height|size|format|quality)=[^&]+/gi, "$1");
    try {
      const url = new URL(raw, window.location.href);
      const normalizedPath = url.pathname
        .replace(/\/(?:\d+x\d+|[a-z]+_[a-z]+)(?=\/|$)/gi, "")
        .replace(/\/+/g, "/");
      return `${url.hostname}${normalizedPath}`;
    } catch (_error) {
      return raw;
    }
  }

  function normalizeEmbeddedImageUrl(value) {
    const cleaned = String(value || "")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\+$/g, "");
    return toAbsoluteUrl(cleaned);
  }

  function imageFileName(value) {
    try {
      const url = new URL(String(value), window.location.href);
      const match = url.pathname.match(/\/([^/]+\.(?:webp|jpe?g|png|avif))(?:$|\/)/i);
      return match ? match[1].toLowerCase() : "";
    } catch (_error) {
      return "";
    }
  }

  function photoBaseKey(value) {
    try {
      const url = new URL(String(value), window.location.href);
      const normalizedPath = url.pathname
        .replace(/\/(?:f800|\d+x\d+|[a-z]+_[a-z]+)(?=\/|$)/gi, "")
        .replace(/\/+/g, "/");
      return `${url.hostname}${normalizedPath}`;
    } catch (_error) {
      return "";
    }
  }

  function isPreferredImageUrl(value) {
    try {
      return /\/f800\//i.test(new URL(String(value), window.location.href).pathname);
    } catch (_error) {
      return false;
    }
  }

  function bestImageUrl(image) {
    const srcset = image.getAttribute("srcset") || "";
    if (srcset) {
      const candidates = srcset.split(",").map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const url = parts[0] || "";
        const width = parts[1] && parts[1].endsWith("w") ? Number.parseInt(parts[1], 10) : 0;
        return { url, width };
      }).filter((entry) => entry.url);
      if (candidates.length) {
        return candidates.sort((a, b) => b.width - a.width)[0].url;
      }
    }
    return image.currentSrc || image.src || "";
  }

  function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function compareText(value) {
    return cleanText(value).toLowerCase();
  }

  async function waitForPageReady() {
    if (document.readyState === "complete") return;
    await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
  }

  async function waitForListingContent() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 6000) {
      if (document.querySelector("h1") && document.querySelector('img.web_ui__Image__content, img[class*="web_ui__Image__content"], .web_ui__Image__content img, [class*="web_ui__Image__content"] img, script[type="application/ld+json"]')) {
        return;
      }
      await delay(100);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
