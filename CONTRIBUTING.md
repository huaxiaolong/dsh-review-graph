# Contributing

User-facing docs live in [README.md](README.md); implementation notes live in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

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

## Releasing

The first version goes out by hand, because npm's trusted-publishing settings page only exists once the
package does:

```bash
npm publish --otp=<code from the authenticator>
```

After that, configure **Trusted publishing** on the package's settings page (repository
`huaxiaolong/dsh-review-graph`, workflow `publish.yml`) and let `.github/workflows/publish.yml` do the
rest — it needs no stored secret, and it publishes with provenance:

```bash
# bump version in package.json, commit, push
git tag v<version> && git push origin v<version>
```

### Release artifacts and their hashes

Publish the artifact `npm pack` produced — not a tarball assembled by hand. `npm pack` normalises file
mtimes and entry order, so the same sources produce the same bytes; a `tar -czf` of the same files does
not, and the registry's `shasum` will not match anything you can reproduce. If a GitHub release carries a
tarball, attach the one `npm pack` wrote, so the two channels share one hash.

Check the published one with:

```bash
npm view dsh-review-graph dist.shasum dist.tarball
```

Why OIDC rather than an `NPM_TOKEN`: npm is removing direct publish from tokens that bypass 2FA
(targeted for January 2027), so a stored token would stop working. Trusted publishing replaces it with a
short-lived credential minted per run.
