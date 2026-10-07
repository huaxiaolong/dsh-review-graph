# Contributing

Thanks for looking. A few things make a PR easy to land here.

## Before you open one

```bash
npm run verify     # build + all self-checks; must be green
```

The self-checks do not use the network and do not call a model: the AI half runs against a fake
adapter, and the client half is rendered with a fake React. That means a mistake like reading a name
that does not exist fails here instead of blanking a tab in the browser — which is exactly how
three blank-tab bugs got caught, so please keep that property.

## What is easy to get wrong

* **Never hand-place two things in a container.** Two overlays each anchored to the same corner, or
  boxes positioned by arithmetic, is how buttons and nodes ended up overlapping. Put them in one
  flex row, or in a slot on a fixed pitch, so the layout cannot collide.
* **A cache key is a promise.** If two different questions (another commit, another branch, a
  changed excerpt) can produce the same key, the answer shown will be wrong rather than stale.
* **Do not silently truncate.** Sizing input down to suit one model's habits changes every model's
  answer; send the whole thing and let the caller choose.
* **Declare the service you use.** A Cordis service is only reachable through the `ctx` that
  declared it in `inject`, and a dotted name (`remote.workspaceFiles`) must be declared verbatim.

## Commits

Explain *why*, not *what*. The diff already says what changed.
