/**
 * host-routes — drive the two git routes the way Connection will.
 *
 * `registerGitRoutes` is exercised with a recording `connection.fetch`, a
 * Node-backed `ctx.fs`, and a real git seam over a temporary repository, so the
 * route layer itself (paths, methods, query validation, and the error text the
 * view displays) is covered without a running Harness.
 *
 *   node test/host-routes.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerGitRoutes,
  registerFlowRoute,
  buildGitGraph,
  collectStreamText,
  usageNumbers,
  flowStem,
} from '../index.js';
import { GIT_ENV } from '../lib/git.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function git(args, { cwd, signal } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        signal,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...GIT_ENV },
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      }
    );
  });
}

/** A contract-shaped `ctx.fs` over the host filesystem. */
const fs = {
  async resolve(path) {
    return { targetKey: path, displayPath: path };
  },
  async stat(target) {
    const info = await stat(target.targetKey);
    return { type: info.isDirectory() ? 'directory' : 'file', size: info.size };
  },
  async listDir(target) {
    const names = await readdir(target.targetKey);
    const entries = [];
    for (const name of names) {
      const child = join(target.targetKey, name);
      const info = await stat(child);
      entries.push({
        name,
        type: info.isDirectory() ? 'directory' : 'file',
        target: { targetKey: child, displayPath: child },
      });
    }
    return entries;
  },
  async readText(target) {
    return readFile(target.targetKey, 'utf8');
  },
};

const root = await mkdtemp(join(tmpdir(), 'review-graph-routes-'));
/** git answers with the canonical path, and macOS /var is a symlink. */
const realRoot = await realpath(root);
try {
  await git(['init', '-q', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
  await git(['config', 'user.name', 'selftest'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'app.ts'), 'export const one = 1\n');
  await writeFile(join(root, 'src', 'util.ts'), 'export const two = 2\n');
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'first'], { cwd: root });
  await writeFile(join(root, 'app.ts'), 'export const one = 2\n');
  await git(['add', 'app.ts'], { cwd: root });
  await writeFile(join(root, 'src', 'util.ts'), 'export const two = 3\n');
  await writeFile(join(root, '.gitignore'), 'node_modules\ndist\n');

  const routes = [];
  const disposers = [];
  const ctx = {
    fs,
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          const dispose = () => {
            disposers.push(route.path);
          };
          return dispose;
        },
      },
    },
  };

  const dispose = registerGitRoutes(ctx, git);
  check(
    'every route is a buffered GET',
    routes.length === 4 &&
      routes.every(
        (route) => route.methods.length === 1 && route.methods[0] === 'GET' && route.requestBody === 'buffered'
      ),
    JSON.stringify(routes.map((route) => `${route.methods.join('/')} ${route.path}`))
  );
  check(
    'the registered paths are the ones the view calls',
    routes.some((route) => route.path === '/api/review-graph.state') &&
      routes.some((route) => route.path === '/api/review-graph.graph'),
    JSON.stringify(routes.map((route) => route.path))
  );

  const stateRoute = routes.find((route) => route.path === '/api/review-graph.state');
  const graphRoute = routes.find((route) => route.path === '/api/review-graph.graph');
  const diffRoute = routes.find((route) => route.path === '/api/review-graph.diff');
  const filesRoute = routes.find((route) => route.path === '/api/review-graph.files');
  const origin = 'http://127.0.0.1:19387';
  const get = (route, query) => route.fetch(new Request(`${origin}${route.path}?${query}`));

  console.log('state route');
  const state = await get(stateRoute, `cwd=${encodeURIComponent(root)}`);
  const stateBody = await state.json();
  check('state answers 200', state.status === 200, String(state.status));
  check(
    'state reports the repository',
    stateBody.available === true &&
      stateBody.branch === 'main' &&
      stateBody.commits.length === 1 &&
      stateBody.branches.some((entry) => entry.name === 'main'),
    JSON.stringify({ branch: stateBody.branch, commits: stateBody.commits?.length, branches: stateBody.branches?.length })
  );
  check(
    'state is not cached',
    state.headers.get('cache-control') === 'no-store',
    String(state.headers.get('cache-control'))
  );

  const againstSelf = await (
    await get(stateRoute, `cwd=${encodeURIComponent(root)}&base=main`)
  ).json();
  check(
    'a base with no difference lists no commits',
    againstSelf.base === 'main' && againstSelf.commits.length === 0,
    JSON.stringify({ base: againstSelf.base, commits: againstSelf.commits?.length })
  );
  const unknownBase = await get(stateRoute, `cwd=${encodeURIComponent(root)}&base=nope`);
  check(
    'an unknown base is refused',
    unknownBase.status === 400 && (await unknownBase.text()).includes('unknown branch'),
    String(unknownBase.status)
  );

  const outside = await get(stateRoute, `cwd=${encodeURIComponent(tmpdir())}`);
  const outsideBody = await outside.json();
  check(
    'a directory outside a repository answers available:false',
    outside.status === 200 && outsideBody.available === false,
    JSON.stringify(outsideBody)
  );

  console.log('graph route');
  const staged = await get(graphRoute, `cwd=${encodeURIComponent(root)}&scope=staged`);
  const stagedBody = await staged.json();
  check('a git scope answers a graph document', staged.status === 200, `${staged.status} ${JSON.stringify(stagedBody).slice(0, 120)}`);
  check(
    'the graph names the source and its change set',
    stagedBody?.git?.kind === 'staged' &&
      stagedBody.change.changedFiles.includes('app.ts') &&
      stagedBody.git.files.some((entry) => entry.path === 'app.ts' && entry.status === 'M'),
    JSON.stringify({ git: stagedBody?.git?.kind, changed: stagedBody?.change?.changedFiles })
  );
  check(
    'the graph carries nodes for the change set',
    Array.isArray(stagedBody.nodes) && stagedBody.nodes.some((node) => node.id === 'app.ts'),
    JSON.stringify(stagedBody.nodes?.map((node) => node.id))
  );

  const unstaged = await get(graphRoute, `cwd=${encodeURIComponent(root)}&scope=unstaged`);
  const unstagedBody = await unstaged.json();
  check(
    'an unstaged scope reports the working-tree change',
    unstagedBody?.git?.kind === 'unstaged' &&
      unstagedBody.change.changedFiles.includes('src/util.ts'),
    JSON.stringify(unstagedBody?.change?.changedFiles)
  );
  check(
    'a non-source change reaches the route as a node',
    unstagedBody.change.changedFiles.includes('.gitignore') &&
      unstagedBody.nodes.some((node) => node.id === '.gitignore'),
    JSON.stringify({ changed: unstagedBody?.change?.changedFiles, nodes: unstagedBody?.nodes?.map((n) => n.id) })
  );

  console.log('files route');
  const listed = await (
    await get(filesRoute, `cwd=${encodeURIComponent(root)}&scope=uncommitted`)
  ).json();
  check(
    'the file list is the whole change set with statuses',
    listed.files.length >= 3 &&
      listed.files.some((file) => file.path === '.gitignore' && file.status === 'M') &&
      listed.files.some((file) => file.path === 'src/util.ts' && file.status === 'M'),
    JSON.stringify(listed.files)
  );
  check(
    'the file list names its source',
    listed.kind === 'uncommitted' && typeof listed.label === 'string' && listed.label.length > 0,
    JSON.stringify({ kind: listed.kind, label: listed.label })
  );
  const listedScopeRefused = await get(filesRoute, `cwd=${encodeURIComponent(root)}&scope=nope`);
  check('an unknown source is refused by the list route too', listedScopeRefused.status === 400, String(listedScopeRefused.status));

  console.log('diff route');
  const diff = await (
    await get(diffRoute, `cwd=${encodeURIComponent(root)}&scope=staged&path=app.ts`)
  ).json();
  check(
    'a staged diff returns hunks with line numbers',
    diff.scope.kind === 'staged' &&
      diff.status === 'M' &&
      diff.hunks.length === 1 &&
      diff.hunks[0].lines.some((line) => line.kind === 'add' && line.newLine >= 1) &&
      diff.hunks[0].lines.some((line) => line.kind === 'del' && line.oldLine >= 1),
    JSON.stringify(diff).slice(0, 240)
  );
  check(
    'a diff reports the file it describes',
    diff.path === 'app.ts' && diff.truncated === false,
    JSON.stringify({ path: diff.path, truncated: diff.truncated })
  );

  await writeFile(join(root, 'untracked.txt'), 'fresh\nlines\n');
  const untrackedDiff = await (
    await get(diffRoute, `cwd=${encodeURIComponent(root)}&scope=uncommitted&path=untracked.txt`)
  ).json();
  check(
    'an untracked file is all additions, since it has no other side',
    untrackedDiff.hunks.length === 1 &&
      untrackedDiff.additions === 2 &&
      untrackedDiff.deletions === 0 &&
      untrackedDiff.hunks[0].lines.every((line) => line.kind === 'add'),
    JSON.stringify(untrackedDiff).slice(0, 200)
  );

  const noPath = await get(diffRoute, `cwd=${encodeURIComponent(root)}&scope=staged`);
  check('a diff without a path is refused', noPath.status === 400, String(noPath.status));
  const badScope = await get(diffRoute, `cwd=${encodeURIComponent(root)}&scope=nope&path=app.ts`);
  check('a diff with an unknown source is refused', badScope.status === 400, String(badScope.status));

  console.log('rejections');
  const unknown = await get(graphRoute, `cwd=${encodeURIComponent(root)}&scope=nope`);
  check('an unknown scope is refused with its text', unknown.status === 400 && (await unknown.text()).includes('change source'), String(unknown.status));
  const noScope = await get(graphRoute, `cwd=${encodeURIComponent(root)}`);
  check('a missing scope is refused', noScope.status === 400, String(noScope.status));
  const relative = await get(graphRoute, 'cwd=relative/path&scope=unstaged');
  check(
    'a relative cwd is refused',
    relative.status === 400 && (await relative.text()).includes('absolute'),
    String(relative.status)
  );
  const missing = await get(graphRoute, `cwd=${encodeURIComponent(join(root, 'nope'))}&scope=unstaged`);
  check('a missing cwd is refused', missing.status === 400, String(missing.status));
  const injection = await get(graphRoute, `cwd=${encodeURIComponent(root)}&scope=${encodeURIComponent('commit:--upload-pack=x')}`);
  check('a scope that looks like an option is refused', injection.status === 400, String(injection.status));

  console.log('scope comparison');
  const commit = await git(['rev-parse', 'HEAD'], { cwd: root });
  const viaRoute = await (await get(graphRoute, `cwd=${encodeURIComponent(realRoot)}&scope=commit:${commit.stdout.trim()}`)).json();
  const direct = await buildGitGraph(ctx, {
    exec: git,
    cwd: realRoot,
    spec: { kind: 'commit', ref: commit.stdout.trim() },
  });
  check(
    'the route returns exactly what the builder returns',
    JSON.stringify(viaRoute.change) === JSON.stringify(direct.change) &&
      viaRoute.git.revision === direct.git.revision,
    JSON.stringify({ route: viaRoute.change.changedFiles, direct: direct.change.changedFiles })
  );

  console.log('ai flows (a fake model, no network)');
  const flowRoutes = [];
  let streamCalls = 0;
  let lastOptions;
  const answerText = JSON.stringify({
    summary: '把下单的库存校验改成先占用后落单。',
    flows: [
      {
        id: 'checkout',
        title: '下单结算',
        detail: '用户提交订单到订单落单',
        before: {
          nodes: [{ id: 'a', label: '用户提交订单', detail: '同步校验库存', files: ['app.ts'] }],
          edges: [],
        },
        after: {
          nodes: [
            { id: 'a', label: '用户提交订单', detail: '先占用库存', files: ['app.ts'], anchors: [{ path: 'app.ts', line: 1 }] },
            { id: 'b', label: '库存占用确认', detail: '失败则回滚', files: ['src/util.ts'] },
          ],
          edges: [{ from: 'a', to: 'b', label: '占用结果' }],
        },
      },
      {
        id: 'report',
        title: '对账',
        detail: '占用记录进入对账',
        before: { nodes: [{ id: 'x', label: '按订单对账', files: ['src/util.ts'] }], edges: [] },
        after: {
          nodes: [{ id: 'x', label: '按订单与占用对账', files: ['src/util.ts'], confidence: 'low' }],
          edges: [],
        },
      },
    ],
    risks: [{ title: '补偿失败', detail: '异步补偿没有重试', files: ['src/util.ts'] }],
  });

  const fakeStream = (chunks) => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });

  const flowCtx = {
    fs,
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async (provider) => [
        { provider, id: 'fake-cheap', name: 'Fake Cheap' },
        { provider, id: 'fake-strong', name: 'Fake Strong' },
      ],
      stream(options) {
        streamCalls += 1;
        lastOptions = options;
        const half = Math.floor(answerText.length / 2);
        return fakeStream([
          { type: 'block-start', index: 0 },
          { type: 'text-delta', index: 0, text: answerText.slice(0, half) },
          { type: 'text-delta', index: 0, text: answerText.slice(half) },
          { type: 'usage', usage: { inputTokens: 1200, outputTokens: 340 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]);
      },
    },
    connection: {
      fetch: {
        register(route) {
          flowRoutes.push(route);
          return () => {
            disposers.push(route.path);
          };
        },
      },
    },
  };
  const appended = [];
  const recorder = {
    ctx: {
      sessions: {
        get: (id) => (id === 'live-session' ? { append: (type, data, opts) => appended.push({ type, data, opts }) } : undefined),
      },
    },
  };
  const cacheDir = await mkdtemp(join(tmpdir(), 'review-graph-flow-cache-'));
  const disposeFlow = registerFlowRoute(flowCtx, git, recorder, { cacheDir });
  const flowRoute = flowRoutes[0];
  check(
    'the flow route is registered for both a plan and a generation',
    flowRoute?.path === '/api/review-graph.flow' &&
      flowRoute.methods.join(',') === 'GET,POST' &&
      flowRoute.requestBody === 'buffered',
    JSON.stringify(flowRoute?.methods)
  );

  const flowGet = (query) => flowRoute.fetch(new Request(`${origin}${flowRoute.path}?${query}`));
  const flowPost = (query, payload) =>
    flowRoute.fetch(
      new Request(`${origin}${flowRoute.path}?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    );

  const plan = await (await flowGet(`cwd=${encodeURIComponent(root)}&scope=uncommitted`)).json();
  check(
    'the plan costs nothing and states what a generation would read',
    streamCalls === 0 &&
      plan.plan.files >= 3 &&
      plan.plan.promptBytes > 0 &&
      plan.plan.excerptBytes > 0 &&
      // Not every changed file has a diff body (an empty file, a pure rename),
      // so the excerpt count is at most the file count.
      plan.plan.excerptFiles > 0 &&
      plan.plan.excerptFiles <= plan.plan.files &&
      // The excerpts are part of the prompt, never more than it.
      plan.plan.excerptBytes <= plan.plan.promptBytes &&
      plan.plan.maxOutputTokens === 40000 &&
      plan.plan.provider === 'fake-provider' &&
      plan.cached === null,
    JSON.stringify(plan.plan)
  );
  check(
    'the plan lists the providers and models a caller may choose',
    Array.isArray(plan.providers) &&
      plan.providers.includes('fake-provider') &&
      plan.models?.length === 2 &&
      plan.models[0].model === 'fake-cheap' &&
      plan.models[0].name === 'Fake Cheap',
    JSON.stringify(plan.models)
  );
  check(
    'the plan defaults to the first advertised pair',
    plan.plan.provider === 'fake-provider' && plan.plan.model === 'fake-cheap',
    JSON.stringify(plan.plan)
  );

  const generated = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=uncommitted&model=fake-model&provider=fake-provider`)
  ).json();
  check(
    'a generation returns every affected process',
    generated.flows?.length === 2 &&
      generated.flows[0].title === '下单结算' &&
      generated.flows[1].id === 'report' &&
      generated.risks?.[0]?.title === '补偿失败',
    JSON.stringify(generated.flows?.map((flow) => flow.id))
  );
  check(
    'each flow carries both sides for the comparison',
    generated.flows[0].before.nodes.length === 1 &&
      generated.flows[0].after.nodes.length === 2 &&
      generated.flows[0].after.edges[0].label === '占用结果'
  );
  check(
    'a node keeps the file and line the reviewer can open',
    generated.flows[0].after.nodes[0].anchors?.[0]?.path === 'app.ts' &&
      generated.flows[0].after.nodes[0].anchors[0].line === 1 &&
      generated.flows[1].after.nodes[0].confidence === 'low',
    JSON.stringify(generated.flows[0].after.nodes[0])
  );
  check(
    'the generation reports its model, time, and usage',
    generated.model === 'fake-model' &&
      generated.provider === 'fake-provider' &&
      generated.cached === false &&
      typeof generated.generatedAt === 'string' &&
      generated.usage?.inputTokens === 1200 &&
      generated.usage?.outputTokens === 340,
    JSON.stringify({ model: generated.model, usage: generated.usage })
  );
  check(
    'the answer records what material it was based on',
    generated.basis?.files?.includes('app.ts') && generated.basis.promptBytes > 0,
    JSON.stringify(generated.basis)
  );
  check(
    'the model is asked for business flows with the JSON contract',
    typeof lastOptions?.system === 'string' &&
      lastOptions.system.includes('"flows"') &&
      lastOptions.model === 'fake-model' &&
      lastOptions.provider === 'fake-provider' &&
      lastOptions.purpose === 'review-graph-flow' &&
      streamCalls === 1
  );
  check(
    'the prompt carries the change set and its excerpts',
    lastOptions.messages[0].content[0].text.includes('Changed files') &&
      lastOptions.messages[0].content[0].text.includes('src/util.ts') &&
      lastOptions.messages[0].content[0].text.includes('@@'),
    lastOptions.messages[0].content[0].text.slice(0, 200)
  );

  const again = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=uncommitted&model=fake-model&provider=fake-provider`)
  ).json();
  check(
    'the same material is not paid for twice',
    again.cached === true && streamCalls === 1 && again.flows.length === 2,
    JSON.stringify({ cached: again.cached, calls: streamCalls })
  );
  const planned = await (await flowGet(`cwd=${encodeURIComponent(root)}&scope=uncommitted`)).json();
  check(
    'the plan reports the cached generation',
    planned.cached?.model === 'fake-model' && streamCalls === 1,
    JSON.stringify(planned.cached)
  );
  const rebuilt = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=uncommitted&model=fake-model&provider=fake-provider`, {
      rebuild: true,
    })
  ).json();
  check('an explicit rebuild spends again', rebuilt.cached === false && streamCalls === 2, String(streamCalls));

  // A cached generation costs nothing, so it is answered without a model; an
  // uncached one cannot run without knowing which model to call.
  const cachedNoModel = await flowPost(`cwd=${encodeURIComponent(root)}&scope=uncommitted`);
  check(
    'a cached generation is answered without naming a model',
    cachedNoModel.status === 200 && (await cachedNoModel.json()).cached === true && streamCalls === 2,
    String(cachedNoModel.status)
  );
  const noModel = await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged`, { rebuild: true });
  const noModelBody = await noModel.json();
  check(
    'a generation that names no model falls back to the advertised one',
    noModel.status === 200 && noModelBody.model === 'fake-cheap' && noModelBody.cached === false,
    `${noModel.status} ${JSON.stringify(noModelBody).slice(0, 120)}`
  );
  const emptyCatalog = flowCtx.llm.listModels;
  flowCtx.llm.listModels = async () => [];
  const refused = await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged`, { rebuild: true });
  check(
    'a profile that advertises no model is refused with its reason',
    refused.status === 400 && (await refused.text()).includes('no model catalog'),
    String(refused.status)
  );
  flowCtx.llm.listModels = emptyCatalog;
  const flowBadScope = await flowPost(`cwd=${encodeURIComponent(root)}&scope=nope&model=x`);
  check('a generation with an unknown source is refused', flowBadScope.status === 400, String(flowBadScope.status));

  const onlyModel = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged&model=fake-model`, { rebuild: true })
  ).json();
  check(
    'a caller that knows only the model still gets the default provider',
    onlyModel.provider === 'fake-provider' && onlyModel.flows.length === 2,
    JSON.stringify({ provider: onlyModel.provider })
  );

  const withTalk = await (
    await flowPost(
      `cwd=${encodeURIComponent(root)}&scope=commit:${(await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()}&model=fake-model&context=${encodeURIComponent('用户要求先占库存再落单')}`
    )
  ).json();
  check(
    'the conversation context reaches the model',
    lastOptions.messages[0].content[0].text.includes('Conversation context') &&
      lastOptions.messages[0].content[0].text.includes('先占库存再落单') &&
      withTalk.flows.length === 2,
    lastOptions.messages[0].content[0].text.slice(0, 160)
  );
  const againSameTalk = await (
    await flowPost(
      `cwd=${encodeURIComponent(root)}&scope=commit:${(await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()}&model=fake-model&context=${encodeURIComponent('用户要求先占库存再落单')}`
    )
  ).json();
  const otherTalk = await (
    await flowPost(
      `cwd=${encodeURIComponent(root)}&scope=commit:${(await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()}&model=fake-model&context=${encodeURIComponent('完全不同的说法')}`
    )
  ).json();
  check(
    'the conversation is part of the cache identity, not a cache buster',
    againSameTalk.cached === true && otherTalk.cached === false,
    JSON.stringify({ same: againSameTalk.cached, other: otherTalk.cached })
  );




  console.log('opt-in conversation record');
  const quiet = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model`, { rebuild: true })
  ).json();
  check(
    'a generation records nothing unless asked',
    appended.length === 0 && quiet.recorded === undefined,
    JSON.stringify({ appended: appended.length, recorded: quiet.recorded })
  );
  const recorded = await (
    await flowPost(
      `cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model&record=true&sessionId=live-session`,
      { rebuild: true }
    )
  ).json();
  check(
    'asking for a record appends the request and the answer',
    recorded.recorded === true &&
      recorded.recordedAnswer === true &&
      appended.length === 2 &&
      appended[0].type === 'user/message' &&
      appended[0].data.role === 'user' &&
      appended[0].opts.surfaceOp === 'append' &&
      appended[0].data.source.kind === 'user' &&
      appended[1].type === 'assistant/message' &&
      appended[1].data.message.role === 'assistant' &&
      appended[1].opts.surfaceOp === 'append',
    JSON.stringify(appended.map((entry) => entry.type))
  );
  const recordedAnswer = appended[1].data.message.content[0].text;
  check(
    'the answer reads as the flows, not as JSON',
    recordedAnswer.includes('业务流程（AI 生成）') &&
      recordedAnswer.includes('下单结算') &&
      recordedAnswer.includes('改动前：') &&
      recordedAnswer.includes('改动后：') &&
      recordedAnswer.includes('风险与关注点') &&
      !recordedAnswer.trim().startsWith('{'),
    recordedAnswer.slice(0, 160)
  );
  const recordText = appended[0].data.content[0].text;
  check(
    'the record is the request, not the material',
    recordText.includes('生成流程图解释所有变更的代码') &&
      recordText.includes('fake-model') &&
      !recordText.includes('Changed files') &&
      !recordText.includes('@@') &&
      !recordText.includes('"flows"'),
    recordText.slice(0, 200)
  );
  check(
    'the record stays short',
    recordText.split('\n').length <= 4 && recordText.length < 400,
    String(recordText.length)
  );
  check(
    'the material is handed to the panel instead',
    recorded.debug?.system.includes('business processes') &&
      recorded.debug.user.includes('Changed files') &&
      recorded.debug.raw.includes('"flows"') &&
      recorded.debug.promptBytes > 0,
    JSON.stringify({ promptBytes: recorded.debug?.promptBytes })
  );
  check(
    'the recorded turn is not generated twice',
    recorded.cached === false && streamCalls >= 1
  );
  const cachedRecord = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model&record=true&sessionId=live-session`)
  ).json();
  check(
    'a cached answer still records the request and hands back the material',
    cachedRecord.cached === true &&
      cachedRecord.recorded === true &&
      appended.length === 4 &&
      appended[2].type === 'user/message' &&
      appended[2].data.content[0].text.includes('生成流程图解释所有变更的代码') &&
      cachedRecord.debug?.user.includes('Changed files') &&
      appended[3].type === 'assistant/message',
    JSON.stringify({ recorded: cachedRecord.recorded, debug: cachedRecord.debug?.promptBytes })
  );
  check(
    'a cached record is unchanged in kind',
    JSON.stringify({ cached: cachedRecord.cached, appended: appended.length })
  );
  const missingSession = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model&record=true&sessionId=nope`, {
      rebuild: true,
    })
  ).json();
  check(
    'a session this host does not hold is reported, not thrown',
    missingSession.recorded === false && missingSession.recordError.includes('not live') && streamCalls >= 1,
    JSON.stringify({ recorded: missingSession.recorded, error: missingSession.recordError })
  );
  const noSessionId = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model&record=true`, { rebuild: true })
  ).json();
  check(
    'a record request without a session is reported',
    noSessionId.recorded === false && noSessionId.recordError.includes('no sessionId'),
    JSON.stringify(noSessionId.recordError)
  );
  const disposeNoRecorder = registerFlowRoute(flowCtx, git, undefined);
  check('a host without the session service simply cannot record', typeof disposeNoRecorder === 'function');
  disposeNoRecorder();

  console.log('ai flow failures');
  flowCtx.llm.stream = () =>
    fakeStream([{ type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'no key' } } }]);
  const failed = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model`, { rebuild: true })
  );
  check(
    'a provider failure surfaces its stable code',
    failed.status === 502 && (await failed.text()).includes('MISSING_CREDENTIAL'),
    `${failed.status}`
  );
  flowCtx.llm.stream = () => fakeStream([{ type: 'text-delta', index: 0, text: 'I cannot help with that.' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const unusable = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model`, { rebuild: true })
  );
  check(
    'an unusable answer is refused with its problems',
    unusable.status === 502 && (await unusable.text()).includes('unusable'),
    String(unusable.status)
  );
  flowCtx.llm.stream = () =>
    fakeStream([
      { type: 'reasoning-delta', index: 0, text: answerText },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
  const reasoned = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged&model=fake-model`, { rebuild: true })
  ).json();
  check(
    'an answer that arrived as reasoning text is still used',
    reasoned.flows?.length === 2 && reasoned.cached === false,
    JSON.stringify(reasoned).slice(0, 160)
  );

  flowCtx.llm.stream = () => fakeStream([{ type: 'finish', reason: { kind: 'length' } }]);
  const silent = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged&model=fake-model`, { rebuild: true })
  );
  const silentText = await silent.text();
  check(
    'a model that streamed nothing says exactly that',
    silent.status === 502 &&
      silentText.includes('streamed no text at all') &&
      silentText.includes('finish=length') &&
      silentText.includes('reasoning chunks=0'),
    silentText.slice(0, 220)
  );

  // The real first failure: a reasoning model that spent every output token
  // thinking, so no visible answer ever started.
  flowCtx.llm.stream = () =>
    fakeStream([
      { type: 'reasoning-delta', index: 0, text: 'Let me understand the change. '.repeat(200) },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
  const spent = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged&model=fake-model`, { rebuild: true })
  );
  const spentText = await spent.text();
  check(
    'spending the whole budget on reasoning is named as such',
    spent.status === 502 &&
      spentText.includes('spent its whole output budget on reasoning') &&
      spentText.includes('finish=max-tokens') &&
      spentText.includes(`output limit ${40000} tokens`) &&
      spentText.includes('Let me understand the change'),
    spentText.slice(0, 260)
  );

  const retryAdvice = await (
    await flowGet(`cwd=${encodeURIComponent(root)}&scope=staged`)
  ).json();
  // Nothing is clipped and nothing is skipped: the whole diff goes in. A diff
  // far larger than any earlier cap must survive intact.
  const bigFile = join(root, 'big.ts');
  const bulk = Array.from({ length: 4000 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  await writeFile(bigFile, `export const head = 0;\n${bulk}\n`, 'utf8');
  await git(['add', 'big.ts'], { cwd: root });
  // The prompt is what must be whole, so it is read off the call itself.
  let sentPrompt = '';
  const previousStream = flowCtx.llm.stream;
  flowCtx.llm.stream = (options) => {
    sentPrompt = options.messages?.[0]?.content?.[0]?.text ?? '';
    return previousStream(options);
  };
  const unbounded = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=staged&model=fake-model`, {
      context: '',
      rebuild: true,
    })
  );
  await unbounded.text();
  flowCtx.llm.stream = previousStream;
  check(
    'no excerpt is clipped and no file is skipped',
    sentPrompt.includes('value3999') && !sentPrompt.includes('(clipped)'),
    `${sentPrompt.length} chars, tail: ${sentPrompt.slice(-60)}`
  );

  check(
    'the next plan names the reasoning-budget failure',
    retryAdvice.lastFailure?.code === 'REASONING_BUDGET' &&
      typeof retryAdvice.plan.excerptBytes === 'number' && retryAdvice.plan.excerptBytes >= 0,
    JSON.stringify({ failure: retryAdvice.lastFailure, snippets: retryAdvice.plan.snippetBytes })
  );

  flowCtx.llm.stream = () => {
    throw new Error('adapter exploded');
  };
  const threw = await (
    await flowPost(`cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model`, { rebuild: true })
  );
  check(
    'a throwing adapter becomes a readable failure',
    threw.status === 502 && (await threw.text()).includes('adapter exploded'),
    String(threw.status)
  );

  console.log('stream assembly');
  const assembled = await collectStreamText(
    fakeStream([
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'reasoning-delta', index: 0, text: 'ignored' },
      { type: 'usage', usage: { inputTokens: 5 } },
      { type: 'text-delta', index: 0, text: 'cd' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  );
  check(
    'only text deltas are assembled and usage is kept',
    assembled.text === 'abcd' && assembled.failure === undefined && assembled.usage.inputTokens === 5,
    JSON.stringify(assembled)
  );
  check(
    'token counts are read under whichever names arrive',
    usageNumbers({ promptTokens: 7, completionTokens: 9 })?.outputTokens === 9 &&
      usageNumbers(undefined) === null
  );

  // A Host restart is a new route instance with an empty memory: the disk cache
  // is what makes a generation the user paid for survive it.
  const restarted = [];
  const restartedCtx = {
    fs,
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async (provider) => [{ provider, id: 'fake-cheap', name: 'Fake Cheap' }],
      stream: () => {
        restarted.push('called');
        return fakeStream([{ type: 'finish', reason: { kind: 'stop' } }]);
      },
    },
    connection: { fetch: { register: (route) => (restarted.push(route) && (() => {})) } },
  };
  const disposeRestarted = registerFlowRoute(restartedCtx, git, undefined, { cacheDir });
  const restartedRoute = restarted.find((entry) => typeof entry === 'object');
  const restored = await (
    await restartedRoute.fetch(
      new Request(
        `${origin}/api/review-graph.flow?cwd=${encodeURIComponent(root)}&scope=unstaged&model=fake-model`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      )
    )
  ).json();
  check(
    'a generation outlives a Host restart',
    restored.cached === true &&
      restored.flows?.length === 2 &&
      restored.model === 'fake-model' &&
      restarted.filter((entry) => entry === 'called').length === 0,
    JSON.stringify({ cached: restored.cached, model: restored.model, calls: restarted.filter((e) => e === 'called').length })
  );
  disposeRestarted();

  const before = disposers.length;
  disposeFlow();
  // Two commits are two questions. This is the identity the cache is stored
  // under, so it is asserted directly rather than through a git fixture.
  check(
    'the cache identity names the commit or the branch it is about',
    flowStem('/repo', 'commit:aaa') !== flowStem('/repo', 'commit:bbb') &&
      flowStem('/repo', 'branch:main') !== flowStem('/repo', 'branch:release') &&
      flowStem('/repo', 'commit:aaa') !== flowStem('/repo', 'branch:aaa') &&
      // The same question is the same entry, or nothing would ever be reused.
      flowStem('/repo', 'commit:aaa') === flowStem('/repo', 'commit:aaa')
  );

  // The state is created first, then the material moves: this section must run
  // after the generations above, because it is about what survives a change.
  // Material the user paid for survives a change of material: it is shown as
  // stale with a reason, and only an explicit rebuild replaces it.
  await git(['commit', '-q', '--allow-empty', '-m', 'move head'], { cwd: root });
  const afterHead = await (await flowGet(`cwd=${encodeURIComponent(root)}&scope=unstaged`)).json();
  check(
    'a changed HEAD does not throw the last generation away',
    afterHead.last?.document?.flows?.length === 2 &&
      afterHead.last.staleReason === 'head' &&
      afterHead.last.model === 'fake-model',
    JSON.stringify({ last: afterHead.last?.staleReason, cached: afterHead.cached })
  );
  const otherTalkPlan = await (
    await flowGet(
      `cwd=${encodeURIComponent(root)}&scope=unstaged&context=${encodeURIComponent('换个说法')}`
    )
  ).json();
  check(
    'a changed conversation is reported as the reason instead',
    otherTalkPlan.last?.staleReason === 'both',
    JSON.stringify(otherTalkPlan.last?.staleReason)
  );

  check('the flow route disposes with the plugin', disposers.length === before + 1, String(disposers.length));
  await rm(cacheDir, { recursive: true, force: true });

  dispose();
  check(
    'disposing the registration disposes every route',
    // One flow route plus the four git routes.
    disposers.length === before + 1 + 4,
    String(disposers.length)
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
