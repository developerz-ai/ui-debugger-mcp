# Nimbus Store — Planted Bug Answer Key

This app is a deliberately-buggy QA fixture. It runs and renders fine (~90% done)
but contains the real, intentional bugs below. **Do not "fix" these** — they are
the test fixtures a UI-debugging agent is expected to detect via
DOM / CSS / console / network.

Dev server: `cd dummy/web && bun run dev` → http://127.0.0.1:5179
(host `127.0.0.1`, fixed port `5179`, `strictPort: true`).

Note on duplicates: React 18 `StrictMode` double-invokes effects/handlers in dev,
so some console errors appear twice. That is expected dev behavior, not a separate
bug.

---

## 1. Invisible text (white on near-white)
- **Where:** `src/components/Hero.module.scss:25` (`.subtitle { color: #ffffff }`)
  on `.hero { background: #fdfdfd }` (`Hero.module.scss:5`). Text lives in
  `src/components/Hero.tsx:10-13`.
- **Manifests (DOM/visual):** The hero subtitle paragraph ("Hand-picked tech and
  lifestyle essentials...") is present in the DOM but invisible to the eye.
  `getComputedStyle(p).color` = `rgb(255, 255, 255)` over a `#fdfdfd` background
  → effectively 0 contrast.

## 2. Missing / broken images (real 404s + a11y)
- **Broken logo:** `src/components/Header.tsx:13` — `src="/images/logo.png"`
  (file does not exist). `alt="logo"` is non-descriptive.
- **Broken product image:** `src/products.ts:32` — product 3
  (`/images/product-3.png`, file does not exist) with **empty `alt`**
  (`src/products.ts:33`), rendered by `src/components/ProductCard.tsx:14`.
- **Manifests (network/console/a11y):** Two real `404 (Not Found)` requests on
  load: `GET /images/logo.png` and `GET /images/product-3.png`. Both show as
  broken-image icons. Empty/poor `alt` is also an accessibility defect.
- **Working images (control):** `/images/product-1.png`, `/images/product-2.png`,
  `/images/product-4.png` exist in `public/images/` and load with `200`.

## 3. Buttons that don't work
- **3a. Add-to-cart with no handler:** product 3 ("Nimbus Mechanical Keyboard")
  is rendered in `src/components/ProductGrid.tsx:19-21` **without** an `onAdd`
  prop, so `ProductCard.tsx:22` renders `onClick={undefined}`.
  - *Manifests (DOM/behavior):* the button's `onclick` is `null`; clicking it
    never changes the cart counter (`[data-testid="cart-count"]` stays put).
- **3b. Add-to-cart that throws:** product 4 ("Altocumulus Travel Mug") wires
  `onAddBroken` → `addToCartBroken` in `src/App.tsx:32-39`. Line `App.tsx:37`
  reads an **undeclared variable** `quantityToAdd`.
  - *Manifests (console/behavior):* clicking logs an uncaught
    `ReferenceError: quantityToAdd is not defined at addToCartBroken (App.tsx)`.
    `setCartCount` never runs, so the cart does not change. (App stays mounted;
    other buttons keep working.)
- **3c. Newsletter form no-ops / reloads:** `src/components/Newsletter.tsx:11`
  — `<form>` has **no `onSubmit`** and a `type="submit"` button with no
  `preventDefault`.
  - *Manifests (behavior/network):* submitting reloads the page (full document
    navigation), nothing is saved, no request is sent anywhere useful.

## 4. Visual polish / CSS smells (renders, but ugly)
- **4a. Low-contrast price:** `src/components/ProductCard.module.scss:52`
  — `.price { color: #cfcfcf }` on a white card. `getComputedStyle` =
  `rgb(207,207,207)` → ~2:1 contrast, hard to read.
- **4b. Tiny touch target + no hover:** `ProductCard.module.scss:63`
  — `.add` button `padding: 3px 8px`, `font-size: 0.78rem`, and **no `:hover`
  rule**. Add-to-cart buttons are cramped and give no hover feedback.
- **4c. Heading overflow:** `src/components/ProductGrid.module.scss:11-15`
  — `.heading { width: 320px; white-space: nowrap }` forces the long "Featured
  products from the spring collection" heading to overflow its container.
- **4d. Inconsistent spacing + overlap:** `ProductGrid.module.scss:25-29`
  — grid has `column-gap: 2.5rem` but `row-gap: 2px` (lopsided spacing), and
  `:nth-child(3) { margin-top: -14px }` pulls the third card up so it overlaps
  its row.

## 5. Console error on load
- **Where:** `src/App.tsx:14-26` — `useEffect` fires
  `fetch('/api/featured')` (no such route → `404`), then `.json()` on the empty
  404 body rejects, and the code also assumes `data.featured.length`
  (`App.tsx:21`).
- **Manifests (network/console):** on every load there is a real
  `GET /api/featured → 404`, plus a logged
  `console.error('Failed to load featured products', ...)` with
  `SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON
  input`.

---

## Quick expected-signal summary for graders

| Signal source | What to expect |
|---|---|
| Network | `404` on `/images/logo.png`, `/images/product-3.png`, `/api/featured`; `200` on product-1/2/4 |
| Console (load) | `Failed to load featured products` + JSON `SyntaxError`; three 404 resource errors |
| Console (click product 4) | `ReferenceError: quantityToAdd is not defined` |
| DOM | hero subtitle text present but `color: rgb(255,255,255)`; product-3 button `onclick == null`; product-3 `alt == ""` |
| Behavior | cart counter never moves for product 3 (no handler) or product 4 (throws); newsletter submit reloads page |
| Visual | invisible hero subtitle, `#cfcfcf` price, tiny no-hover add buttons, overflowing grid heading, overlapping 3rd card |
