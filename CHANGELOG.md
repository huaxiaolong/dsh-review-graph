# Changelog

## 1.0.2

Fixes reported from real sessions.

* **Generate no longer crashes** when no model is known yet. It failed with
  `Cannot read properties of null (reading 'provider')` in a session whose selection had never been
  announced and whose plan had not loaded; the choice is a pure function now and the request says
  what is missing instead.
* **"Out of date" means the code moved.** The conversation digest used to count as well, and it moves
  whenever a session grows — switching pages, loading more history, or a generation recording itself
  into the conversation — so answers were labelled expired although no code had changed. A moved
  digest is a note now.
* **The review pane scrolls to the line it jumped to**, and to the nearest change block when that
  line survived unchanged and sits outside every hunk.
* **A step prefers the code that implements it.** A flow diagram used to send the reader to a
  documentation file whenever the model anchored a behaviour step there.
* **The model is never printed as `undefined`.** An absent model was dropped by `JSON.stringify` and
  the card interpolated it anyway; absent values are normalised now, and the label falls back to the
  model that would answer.

## 1.0.1

Documentation and CI only. Published to validate the package's trusted publishing configuration,
which npm expires if it is never used.

## 1.0.0

First release: the relationship graph, the review pane, and the optional AI flow diagram.
