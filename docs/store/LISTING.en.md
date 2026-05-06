# Chrome Web Store Listing (English)

> Paste each field into the submission form. Char limits noted.

---

## Name (45 chars max)

```
Judge — Page Performance Inspector
```

## Short Description (132 chars max)

```
One-click diagnose page slowness: slow APIs, network score, JS errors, user trace. Local-only PDF report. No data uploaded.
```

## Category

`Developer Tools`

---

## Detailed Description (16384 chars max)

```
Judge is a one-click page performance inspector. When a colleague says
"the system is slow", they install Judge, click the magnifier in the toolbar,
and get a structured PDF report telling exactly where the slowness comes from
— backend, network congestion, browser queueing, or the user's own connection.

═══════ Features ═══════

✓ Top slow API ranking, sorted by duration
✓ 5-class root-cause labels: backend-slow / network-congestion /
  cold-connection / browser-queue / large-response
✓ Network score 0–100 — objectively tells the user if it's their network
✓ Captures HTTP errors + business-layer failures
  (HTTP 200 but response status ≠ 0 — easily missed by HTTP-level monitoring)
✓ Monitors JS runtime exceptions and unhandled promise rejections
✓ Records last 30 user actions (clicks / inputs / SPA navigation)
  — answers "what did I just click?"
✓ Multi-iframe support — admin-shell architectures work out of the box
✓ One-click PDF export with IP watermark

═══════ Who It's For ═══════

• Non-technical users of internal admin systems (ops / product / support)
• Frontend / backend engineers who need actionable bug reports
• Anyone tired of "it's slow but I can't explain why" tickets

═══════ Privacy ═══════

• All analysis runs locally in your browser
• Zero data uploaded to external servers
• Only outbound request: optional public-IP fetch (for PDF watermark, opt-in)
• Never reads cookies / form inputs / password fields
• Source-readable: extract the .crx, all .js files are plaintext

═══════ Usage ═══════

1. Install
2. Open the slow page, press F5 to refresh
3. Reproduce the slowness
4. Click the magnifier icon in the toolbar
5. View the popup diagnosis, or download the full PDF report
```

---

## Keywords

`performance monitoring` `developer tools` `web vitals` `slow api` `network diagnosis`
`page inspector` `chrome devtools` `bug report` `ticket` `RUM`
