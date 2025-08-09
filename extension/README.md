# Quick Search – Chrome Extension

## 📖 Overview
Quick Search is a Chrome extension to search content faster inside websites.  
It started as a small experiment after watching beginner tutorials and evolved into a tool that can:
- Search from a popup input.
- Search in a small local JSON database.
- Search directly in the page DOM.
- Jump to the section containing the result.

---

## 🛠 Features
- **Popup Search Bar** – Triggered from the extension icon.
- **Local Search** – Works with a small database (`search.json` or similar).
- **Website Search** – Uses DOM queries (`document.querySelectorAll`) to scan the page.
- **Auto-scroll** – Clicking a result scrolls to the matching section.
- **Planned Web Crawling** – Follow internal links and search multiple pages.

---

## 📂 Folder Structure
```plaintext
EXTENSION/
│
├── content/               # Scripts & styles injected into the web page
│   ├── content.css         # Styling for injected elements
│   └── content.js          # DOM interaction and search logic
│
├── background.js           # Background service worker
├── manifest.json           # Extension config & permissions
│
├── popup.css               # Popup UI styling
├── popup.html              # Search bar UI
├── popup.js                # Popup logic & bridge to content/background
│
└── README.md               # Project documentation

## 📚 Lessons Learned
- **Inspect the Right Context** – The popup has its own dedicated developer tools panel.  
  It’s important to inspect the popup itself rather than the main page when debugging popup behavior.

- **Start Small** – Begin with a simple local JSON search before moving on to live DOM search.  
  This made debugging easier and kept progress steady.

- **Root Structure Simplicity** – Keep files in the root folder instead of using a `public/` folder when not required.  
  This avoids confusion from build systems like Vite.

- **Permissions vs. Capabilities** – `all_frames` permission allows scripts to run in iframes,  
  but it doesn’t guarantee access to their DOM if cross-origin restrictions apply.

- **Cross-Origin Challenges** – PDFs or iframes loaded from other domains require special handling due to CORS limitations.  
  A different approach (e.g., server-side processing) might be needed for these cases.


---

## 📺 References
- [Build a Chrome Extension – Course for Beginners](https://youtu.be/0n809nd4Zu4)
- [Basics of Chrome Extension - Debugging](https://youtu.be/N4BE7cwhnRE)
- [Content Scripts – Chrome Docs](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [CORS – MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
- [Apollo GraphQL Dev Tooling](https://www.apollographql.com/docs/react/development-testing/developer-tooling)

---

## 📌 Next Steps
- **Internal Link Crawling** – Follow `<a>` tags to search multiple pages.
- **Next-Page Prediction** – Use link text and URL patterns to guess relevant pages.
- **Cross-Origin PDF Search** – Implement text extraction from embedded or remote PDFs.
- **Ranking Improvements** – Prioritize search results based on relevance and keyword density.
