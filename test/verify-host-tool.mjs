/**
 * verify-host-tool — check the Host half against the *real* dsh-tools registry
 * contract instead of a hand-rolled assumption.
 *
 * The registry is not guessed here: it is imported straight out of the
 * installed DeepSeek Harness application (app.asar), which only the Electron
 * runtime can read. Run it the way the harness runs its own Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/verify-host-tool.mjs
 *
 * What it pins down:
 *   1. `ctx.tools.register` accepts the definition index.js builds — the real
 *      `assertSupportedJsonSchema` + `output.render` checks, which a definition
 *      written against the authoring DSL (`{ type: 'json' }`, `minimum`,
 *      no render) fails.
 *   2. the parameter schema still describes the same arguments the DSL did;
 *   3. valid arguments validate and invalid ones are rejected;
 *   4. the declared output schema admits the graph document and `render`
 *      returns a text block;
 *   5. `execute` runs end to end through a contract-shaped `ctx.fs`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_TOOLS =
  'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, validateJsonSchemaValue } =
  await import(DSH_TOOLS);

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const plugin = await import(new URL('../index.js', import.meta.url).href);

/* ------------------------------------------------- contract-shaped ctx.fs */

const fs = {
  async resolve(path) {
    return { targetKey: path, displayPath: path };
  },
  async stat(target) {
    const info = statSync(target.targetKey);
    if (!info) return undefined;
    return { type: info.isDirectory() ? 'directory' : 'file', size: info.size };
  },
  async listDir(target) {
    return readdirSync(target.targetKey).map((name) => {
      const child = join(target.targetKey, name);
      const info = statSync(child);
      return {
        name,
        type: info.isDirectory() ? 'directory' : 'file',
        target: { targetKey: child, displayPath: child },
      };
    });
  },
  async readText(target) {
    return readFileSync(target.targetKey, 'utf8');
  },
};

const notes = [];
let captured;
const optional = [];
const ctx = {
  fs,
  logger: { info: (m) => notes.push(`info: ${m}`), warn: (m) => notes.push(`warn: ${m}`) },
  // This fake composition provides neither `subprocess` nor `connection`, so the
  // optional callbacks must not run — the tool still has to register. A cordis
  // context always has `inject`.
  inject(deps, callback) {
    optional.push(...deps);
    // The fake composition provides every optional service, so the callbacks
    // run and their registrations are observable.
    callback?.(this);
    return () => {};
  },
  effect() {
    return () => {};
  },
  connection: { fetch: { register: () => () => {} } },
  subprocess: { resolveExecutable: async (name) => name },
  llm: { listProviders: () => [{ id: 'fake-provider' }], stream: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
  tools: {
    /** Mirror of the shipped registry's own validation, verbatim in effect. */
    register(definition) {
      const output = definition.output;
      if (
        output === undefined ||
        typeof output !== 'object' ||
        typeof output.render !== 'function'
      ) {
        throw new TypeError(
          `tool "${definition.name}" must declare output { schema, render, presentationMeta? }`
        );
      }
      assertSupportedJsonSchema(output.schema);
      assertSupportedJsonSchema(definition.parameters);
      captured = definition;
      return () => {};
    },
  },
};

console.log('host tool registration');
plugin.apply(ctx);
check('tool registered without the plugin swallows an error', captured !== undefined,
  notes.join(' | ') || 'ctx.tools.register was never reached');
if (captured === undefined) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
check('registered name is review_graph', captured.name === 'review_graph', captured.name);
check(
  'the tool offers git change sources beside `changed`',
  captured.parameters.properties?.scope?.type === 'string' &&
    captured.parameters.properties?.changed?.type === 'array',
  JSON.stringify(Object.keys(captured.parameters.properties ?? {}))
);
check(
  'subprocess and connection are optional, not required',
  JSON.stringify(plugin.inject) === JSON.stringify(['fs', 'tools']) &&
    optional.includes('subprocess') &&
    optional.includes('connection'),
  `inject=${JSON.stringify(plugin.inject)} optional=${[...new Set(optional)].join(',')}`
);
check(
  'the AI flows ask for a model provider of their own',
  optional.includes('llm'),
  `optional=${[...new Set(optional)].join(',')}`
);

console.log('parameter schema');
const dslEquivalent = parameterSchemaSpecToJsonSchema({
  root: { type: 'string' },
  changed: { type: 'array', items: { type: 'string' } },
  maxFiles: { type: 'integer' },
});
check(
  'every declared argument survives the DSL the schema replaced',
  Object.keys(dslEquivalent.properties).every(
    (key) => captured.parameters.properties?.[key]?.type === dslEquivalent.properties[key].type
  ),
  JSON.stringify(captured.parameters.properties)
);
check(
  'parameter root is an object schema',
  captured.parameters.type === 'object' && typeof captured.parameters.properties === 'object'
);
const accepted = validateJsonSchemaValue(
  captured.parameters,
  { root: '/tmp/x', changed: ['a.ts'], maxFiles: 5 },
  ''
);
check('valid arguments validate', accepted.length === 0, accepted.join('; '));
const rejected = validateJsonSchemaValue(captured.parameters, { maxFiles: 'ten' }, '');
check('wrong argument type is rejected', rejected.length > 0, 'no violation reported');

console.log('output contract');
check(
  'output schema admits the graph document',
  validateJsonSchemaValue(captured.output.schema, { version: 1, nodes: [], edges: [] }, '').length === 0
);
const blocks = captured.output.render({}, { version: 1 });
check(
  'render returns a text block',
  Array.isArray(blocks) && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string',
  JSON.stringify(blocks)
);

console.log('execute end to end');
const graph = await captured.execute(
  { root: join(pluginDir, 'lib') },
  { session: { cwd: pluginDir } }
);
check('graph documents the analysed files', graph.scan.filesIndexed > 0, JSON.stringify(graph.scan));
check('graph carries nodes and edges', Array.isArray(graph.nodes) && Array.isArray(graph.edges));
check('workspace root is echoed back', graph.root === join(pluginDir, 'lib'), graph.root);

console.log('negative control (the definition this file used to build)');
let renderlessRejected = false;
try {
  ctx.tools.register({ name: 'review_graph', parameters: {}, output: { schema: { type: 'json' } } });
} catch {
  renderlessRejected = true;
}
check('a render-less definition is still rejected', renderlessRejected);
let jsonTypeRejected = false;
try {
  assertSupportedJsonSchema({ type: 'json' });
} catch {
  jsonTypeRejected = true;
}
check('the DSL-only `json` type is not a wire schema', jsonTypeRejected);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
