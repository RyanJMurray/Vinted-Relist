# Vinted Relist Assistant

Plain Manifest V3 Chrome/Edge extension for cloning your own Vinted UK listings into a new listing form for manual review.

## Load unpacked

1. Open Chrome or Edge extensions settings.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select this folder: `C:\Users\Owner\Desktop\Windows Extension Project`.

## V1 behavior

- Runs only on `https://www.vinted.co.uk/*`.
- Adds a `Relist` button near `Bump` on visible own-listing cards.
- Opens the source listing in an inactive temporary tab.
- Saves listing metadata in `chrome.storage.local`.
- Saves image blobs in extension IndexedDB for 24 hours.
- Opens `https://www.vinted.co.uk/items/new`, fills what it can, uploads cached images, and stops for manual review.
- Supports multiple manually started relists running in parallel.

## Intentional limits

- Does not delete the old listing.
- Does not submit the new listing.
- Does not bypass login, captcha, security checks, or rate limits.
- Stops if any extracted image cannot be cached.
