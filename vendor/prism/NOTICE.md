# Third-party code in the shipped bundle

## Prism.js 1.29.0 — MIT

* Upstream: https://github.com/PrismJS/prism
* License: MIT (see LICENSE in this directory)
* What ships: `prism.bundle.js`, 297 languages concatenated in load order.
* Not committed: the downloaded component files themselves. `node build-vendor.mjs` fetches
  Prism 1.29.0 from jsDelivr into `vendor/prism/` before building the bundle.

### Why it is concatenated instead of depended on

The Harness client module loader resolves only platform seed words, materialized modules, and
registered package factories, so `require("prismjs")` throws inside a plugin. The components are
therefore concatenated into one file the plugin loads itself.
