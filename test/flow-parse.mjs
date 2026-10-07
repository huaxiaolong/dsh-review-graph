/**
 * flow-parse — the AI flow document without a model: prompt budget, strict
 * validation of untrusted answers, and the cache key.
 *
 *   node test/flow-parse.mjs
 */

import {
  FLOW_LIMITS,
  flowAnswerText,
  flowRecordText,
  flowCacheKey,
  flowPrompt,
  parseFlowDocument,
  stableHash,
  validateFlowDocument,
} from '../lib/flow.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const goodFlow = (over = {}) => ({
  id: 'checkout',
  title: '结算',
  detail: '下单到支付',
  before: {
    nodes: [{ id: 'a', label: '用户提交订单', detail: '同步校验库存', files: ['src/order.ts'] }],
    edges: [],
  },
  after: {
    nodes: [
      { id: 'a', label: '用户提交订单', detail: '先占用库存再落单', files: ['src/order.ts'], anchors: [{ path: 'src/order.ts', line: 42 }] },
      { id: 'b', label: '库存服务确认', detail: '异步补偿', files: ['src/stock.ts'] },
    ],
    edges: [{ from: 'a', to: 'b', label: '占用结果' }],
  },
  ...over,
});

console.log('prompt budget');
const snippets = Array.from({ length: 40 }, (_, index) => ({
  path: `src/f${index}.ts`,
  diff: `@@ -1 +1 @@\n${'x'.repeat(4000)}`,
}));
const prompt = flowPrompt({
  language: 'zh',
  scopeLabel: 'branch: main...HEAD',
  branch: 'feature/checkout',
  files: [{ path: 'src/f0.ts', status: 'M', added: 3, deleted: 1 }],
  symbols: { 'src/f0.ts': ['placeOrder'] },
  edges: [{ from: 'src/f0.ts', to: 'src/f1.ts', kinds: ['import'] }],
  snippets,
});
check('the prompt names the change source', prompt.user.includes('branch: main...HEAD'));
check('the prompt lists changed files with counts', prompt.user.includes('src/f0.ts [M] +3 −1'));
check('the prompt lists exports and references', prompt.user.includes('placeOrder') && prompt.user.includes('→'));
check(
  'every excerpt goes in whole, however large',
  // 40 files x 4000 bytes of diff: nothing is clipped, nothing is skipped, and
  // the last character of the last file is in the prompt.
  prompt.bytes > 160 * 1024 &&
    !prompt.user.includes('(clipped)') &&
    prompt.user.includes('src/f39.ts') &&
    prompt.user.includes('x'.repeat(4000)),
  String(prompt.bytes)
);
check(
  'the system prompt fixes the JSON contract and forbids invention',
  prompt.system.includes('"flows"') && prompt.system.includes('never invent behaviour')
);
const withContext = flowPrompt({
  scopeLabel: 'unstaged',
  files: [],
  snippets: [],
  context: '用户要求把下单改成先占库存，并补一个对账视图。',
});
check(
  'the conversation context reaches the prompt',
  withContext.user.includes('Conversation context') && withContext.user.includes('先占库存'),
  withContext.user.slice(0, 160)
);
check(
  'the model is told the code outranks the conversation',
  withContext.system.includes('the code is the authority')
);
check(
  'context is capped like every other input',
  flowPrompt({ scopeLabel: 'x', context: 'y'.repeat(20_000) }).user.length <= FLOW_LIMITS.contextChars + 400,
  String(flowPrompt({ scopeLabel: 'x', context: 'y'.repeat(20_000) }).user.length)
);
check(
  'a prompt without context says nothing about it',
  !flowPrompt({ scopeLabel: 'x' }).user.includes('Conversation context')
);
const small = flowPrompt({ scopeLabel: 'unstaged', snippets: [], files: [], limits: { snippetBytes: 100 } });
check('an empty change set still produces a prompt', small.user.includes('Changed files (0)'));

console.log('validating an untrusted answer');
const valid = validateFlowDocument({
  summary: '这次改动把下单的库存校验改成先占用后落单。',
  flows: [goodFlow()],
  risks: [{ title: '补偿失败', detail: '异步补偿没有重试', files: ['src/stock.ts'] }],
});
check('a well-formed answer validates', valid.ok === true, JSON.stringify(valid.problems));
check(
  'the validator keeps both sides and the anchors',
  valid.value.flows[0].after.nodes[1].id === 'b' &&
    valid.value.flows[0].after.edges[0].label === '占用结果' &&
    valid.value.flows[0].after.nodes[0].anchors[0].line === 42 &&
    valid.value.flows[0].before.nodes.length === 1
);
check('risks survive validation', valid.value.risks[0].files[0] === 'src/stock.ts');

check('a fenced JSON answer parses', parseFlowDocument('```json\n' + JSON.stringify({ summary: 's', flows: [goodFlow()] }) + '\n```').ok === true);
check('prose around the JSON is tolerated', parseFlowDocument('好的：\n{"summary":"s","flows":[' + JSON.stringify(goodFlow()) + ']}').ok === true);
check('a non-JSON answer is refused with a reason', parseFlowDocument('I cannot help with that.').ok === false);
check('an empty answer is refused', parseFlowDocument('').ok === false);

const noFlows = validateFlowDocument({ summary: 's', flows: [] });
check('an answer without flows is refused', noFlows.ok === false && noFlows.problems.join().includes('flows'));
const danglingEdge = validateFlowDocument({
  summary: 's',
  flows: [goodFlow({ after: { nodes: [{ id: 'a', label: 'A', files: [] }], edges: [{ from: 'a', to: 'ghost' }] } })],
});
check(
  'an edge to a node that does not exist is dropped and reported',
  danglingEdge.ok === true && danglingEdge.value.flows[0].after.edges.length === 0
);
const noLabels = validateFlowDocument({ summary: 's', flows: [goodFlow({ after: { nodes: [{ id: 'a' }], edges: [] } })] });
check('a flow whose nodes have no labels is unusable', noLabels.ok === false && noLabels.problems.join().includes('label'));
const duplicate = validateFlowDocument({
  summary: 's',
  flows: [goodFlow({ after: { nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] } })],
});
check('duplicate node ids are dropped', duplicate.value.flows[0].after.nodes.length === 1);
const lowConfidence = validateFlowDocument({
  summary: 's',
  flows: [goodFlow({ after: { nodes: [{ id: 'a', label: 'A', confidence: 'low' }], edges: [] } })],
});
check('low confidence is preserved, anything else is treated as high', lowConfidence.value.flows[0].after.nodes[0].confidence === 'low');
const twoFlows = validateFlowDocument({ summary: 's', flows: [goodFlow(), goodFlow({ id: 'refund', title: '退款' })] });
check('several affected processes stay separate', twoFlows.value.flows.length === 2 && twoFlows.value.flows[1].id === 'refund');

console.log('debug record');
const recordText = flowRecordText({
  provider: 'p',
  model: 'm',
  scope: 'unstaged',
  generatedAt: '2026-01-01T00:00:00.000Z',
  cached: false,
  usage: { inputTokens: 10, outputTokens: 20 },
  prompt: 'CHANGED FILES',
  raw: '{"flows":[]}',
});
check(
  'the record names the model, the source, and the usage',
  recordText.includes('p m') && recordText.includes('unstaged') && recordText.includes('10+20 tok'),
  recordText.slice(0, 120)
);
check(
  'the record carries no material at all',
  !recordText.includes('CHANGED FILES') &&
    !recordText.includes('"flows"') &&
    !recordText.includes('@@') &&
    recordText.split('\n').length <= 4,
  recordText
);
check(
  'the record names the provenance after the request',
  recordText.startsWith('生成流程图解释所有变更的代码') && recordText.includes('[review-graph]')
);
check(
  'a cached answer says so',
  flowRecordText({ instruction: 'x', cached: true }).includes('复用缓存')
);
check(
  'material handed to the record by mistake is ignored, not appended',
  (() => {
    const text = flowRecordText({ instruction: 'x', prompt: 'a'.repeat(30_000), raw: 'b'.repeat(30_000) });
    return text.length < 300 && !text.includes('aaa');
  })()
);

console.log('anchor ranges');
const ranged = validateFlowDocument({
  summary: 's',
  flows: [
    {
      id: 'f',
      title: 'f',
      before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      after: {
        nodes: [
          { id: 'a', label: 'A', anchors: [{ path: 'a.ts', line: 10, endLine: 14 }] },
          { id: 'b', label: 'B', anchors: [{ path: 'a.ts', line: 20 }] },
          { id: 'c', label: 'C', anchors: [{ path: 'a.ts', line: 30, endLine: 5 }] },
        ],
        edges: [],
      },
    },
  ],
});
const anchors = ranged.value.flows[0].after.nodes;
check(
  'an anchor keeps an inclusive range',
  anchors[0].anchors[0].line === 10 && anchors[0].anchors[0].endLine === 14,
  JSON.stringify(anchors[0].anchors)
);
check(
  'a single-line anchor has no range',
  anchors[1].anchors[0].line === 20 && anchors[1].anchors[0].endLine === null
);
check(
  'a range that does not start before it ends is dropped',
  anchors[2].anchors[0].line === 30 && anchors[2].anchors[0].endLine === null,
  JSON.stringify(anchors[2].anchors)
);
check(
  'the prompt asks for ranges and for the right side',
  flowPrompt({ scopeLabel: 's' }).system.includes('endLine') &&
    flowPrompt({ scopeLabel: 's' }).system.includes('Do not collapse a range')
);

console.log('cache key');
const key = flowCacheKey({ root: '/repo', scope: 'branch:main', head: 'abc' });
check('the same material makes the same key', key === flowCacheKey({ root: '/repo', scope: 'branch:main', head: 'abc' }));
check('a new head makes a new key', key !== flowCacheKey({ root: '/repo', scope: 'branch:main', head: 'def' }));
check('another scope makes a new key', key !== flowCacheKey({ root: '/repo', scope: 'unstaged', head: 'abc' }));
check(
  'a different conversation is a different generation',
  key !== flowCacheKey({ root: '/repo', scope: 'branch:main', head: 'abc', context: '换个说法' }) &&
    key !== flowCacheKey({ root: '/repo', scope: 'branch:main', head: 'abc', context: '另一个说法' }),
  'context must not collide in the cache'
);
check(
  'the same conversation keeps the same key',
  flowCacheKey({ root: '/r', scope: 's', head: 'h', context: '同一段话' }) ===
    flowCacheKey({ root: '/r', scope: 's', head: 'h', context: '同一段话' }) &&
    stableHash('') === stableHash(undefined)
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
