/**
 * Build `prism.bundle.js` from the Prism components Prism publishes.
 *
 * The components are a **dependency fetched at build time**, not committed: 297
 * files and 1.4MB of third-party source in this repository would be a mirror to
 * maintain, and npm already hosts it. What *is* committed is the built bundle
 * (so `dsh plugin add <git url>` works with no build step) together with the
 * attribution files under `vendor/prism/`, which MIT requires to travel with it.
 *
 *   node build-vendor.mjs            # fetch if missing, then build
 *   node build-vendor.mjs --fetch    # refresh the downloaded files first
 *   node build-vendor.mjs --offline  # never touch the network; fail if missing
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.29.0';
const here = fileURLToPath(new URL('.', import.meta.url));
const base = `https://cdn.jsdelivr.net/npm/prismjs@${VERSION}`;
const vendor = join(here, 'vendor', 'prism');
const components = join(vendor, 'components');
const core = join(vendor, 'prism-core.min.js');

const args = new Set(process.argv.slice(2));
const offline = args.has('--offline');
const haveVendor = existsSync(core) && existsSync(components);

if (args.has('--offline') && !haveVendor) {
  console.error(
    `vendor/prism/ is not present and --offline was given.\n` +
      `Run \`node build-vendor.mjs\` (needs the network once) to fetch Prism ${VERSION}.`
  );
  process.exit(1);
}

async function fetchVendor() {
  const get = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const meta = JSON.parse((await get(`${base}/components.json`)).toString('utf8'));
  const names = Object.keys(meta.languages).filter((name) => name !== 'meta');
  mkdirSync(components, { recursive: true });
  writeFileSync(core, await get(`${base}/components/prism-core.min.js`));
  writeFileSync(join(vendor, 'LICENSE'), await get(`${base}/LICENSE`));
  writeFileSync(join(vendor, 'components.json'), JSON.stringify(meta, null, 2) + '\n');
  let done = 0;
  const queue = [...names];
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (queue.length > 0) {
        const name = queue.shift();
        writeFileSync(
          join(components, `prism-${name}.min.js`),
          await get(`${base}/components/prism-${name}.min.js`)
        );
        done += 1;
      }
    })
  );
  console.log(`fetched ${done}/${names.length} Prism ${VERSION} components into vendor/prism/`);
}

if (args.has('--fetch')) {
  rmSync(components, { recursive: true, force: true });
  await fetchVendor();
} else if (!haveVendor) {
  console.log('vendor/prism/ is absent: fetching it (a dependency, not committed)');
  await fetchVendor();
}

const coreSource = readFileSync(core, 'utf8');
const names = readdirSync(components)
  .filter((name) => name.endsWith('.js'))
  .sort();
const header = `/*! review-graph vendor bundle — Prism.js ${VERSION} (MIT), ${names.length} languages.
 *  Source: https://github.com/PrismJS/prism  ·  Fetched at build time rather than vendored:
 *  a profile-installed client plugin cannot require() an npm package (the module table only
 *  carries platform seeds, materialized modules, and registered package factories), so the
 *  components are concatenated into this file and shipped with it.
 */
`;
const body = names
  .map((name) => `/*! ${name} (Prism.js ${VERSION}, MIT) */\n${readFileSync(join(components, name), 'utf8')}`)
  .join('\n');
const tail = '\ntry { if (!window.Prism && typeof Prism !== "undefined") window.Prism = Prism; } catch (error) {}\n';
writeFileSync(join(here, 'prism.bundle.js'), header + coreSource + '\n' + body + tail);

// Attribution must exist on a fresh clone, where vendor/ starts empty.
const manifest = {
  name: 'Prism.js',
  version: VERSION,
  license: 'MIT',
  source: 'https://github.com/PrismJS/prism',
  fetched: 'vendor/prism/ is fetched by `node build-vendor.mjs`; only the attribution files are committed',
  bundle: 'prism.bundle.js (generated; do not edit)',
  languages: names.length,
  regeneratedBy: 'node build-vendor.mjs',
  why: 'A profile-installed client plugin cannot require() an npm package: the client module table only resolves platform seeds, materialized modules, and registered package factories.',
};
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(
  join(vendor, 'NOTICE.md'),
  [
    '# Third-party code in the shipped bundle',
    '',
    `## Prism.js ${VERSION} — MIT`,
    '',
    `* Upstream: ${manifest.source}`,
    '* License: MIT (see LICENSE in this directory)',
    `* What ships: \`prism.bundle.js\`, ${names.length} languages concatenated in load order.`,
    '* Not committed: the downloaded component files themselves. `node build-vendor.mjs` fetches',
    `  Prism ${VERSION} from jsDelivr into \`vendor/prism/\` before building the bundle.`,
    '',
    '### Why it is concatenated instead of depended on',
    '',
    'The Harness client module loader resolves only platform seed words, materialized modules, and',
    'registered package factories, so `require("prismjs")` throws inside a plugin. The components are',
    'therefore concatenated into one file the plugin loads itself.',
    '',
  ].join('\n')
);
console.log(
  `prism.bundle.js: ${(statSync(join(here, 'prism.bundle.js')).size / 1024).toFixed(0)}KB from ${names.length} languages`
);
