/**
 * review-graph — the AI business-flow document: prompt, validation, cache key.
 *
 * Pure functions only. The model call lives in the Host half; everything that
 * can be wrong *around* that call — what we ask for, what we accept back, and
 * what makes two requests the same request — is testable here without a model.
 */

/** Context caps, materialized into the prompt so the user sees the budget. */
export const FLOW_LIMITS = {
  /** Changed files named in the prompt. */
  files: 200,
  /**
   * Output tokens the model may spend.
   *
   * A reasoning model bills its thinking here: 8k was spent entirely on
   * reasoning in a real run, so the visible answer never started. The document
   * itself is a few KB; the rest is headroom for thinking.
   */
  maxOutputTokens: 40_000,
  /** Characters of conversation context (why the change was asked for). */
  contextChars: 4_000,
};

/**
 * A small stable hash, for cache identity.
 *
 * The conversation context is part of what a generation was based on, so two
 * generations that differ only in context must not share a cache entry.
 * @param text any string
 * @returns an 8-character hex digest
 */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Strip a fenced block a model may wrap JSON in, then parse it. */
export function parseFlowDocument(text) {
  if (typeof text !== 'string') return { ok: false, problems: ['the model returned no text'] };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced === null ? text : fenced[1]).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, problems: ['no JSON object in the answer'] };
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    return { ok: false, problems: [`the answer is not JSON: ${error.message}`] };
  }
  return validateFlowDocument(parsed);
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isList = (value) => Array.isArray(value);

/**
 * Validate one generated document.
 *
 * A model answer is untrusted input: every field the renderer reads is checked
 * here, and unusable parts are reported instead of half-rendered.
 * @param value decoded JSON
 * @returns `{ ok: true, value }` or `{ ok: false, problems }`
 */
export function validateFlowDocument(value) {
  const problems = [];
  if (value === null || typeof value !== 'object' || isList(value)) {
    return { ok: false, problems: ['the answer is not an object'] };
  }
  if (!isText(value.summary)) problems.push('summary is missing');
  if (!isList(value.flows) || value.flows.length === 0) {
    return { ok: false, problems: [...problems, 'flows is missing or empty'] };
  }
  const flows = [];
  for (const [index, flow] of value.flows.entries()) {
    const where = `flows[${index}]`;
    if (flow === null || typeof flow !== 'object' || isList(flow)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (!isText(flow.title)) problems.push(`${where}.title is missing`);
    const steps = normalizeSide(flow.after, `${where}.after`, problems, true);
    const before = normalizeSide(flow.before, `${where}.before`, problems, false);
    if (steps === null) continue;
    flows.push({
      id: isText(flow.id) ? flow.id : `flow-${index + 1}`,
      title: isText(flow.title) ? flow.title : `${where}`,
      detail: isText(flow.detail) ? flow.detail : '',
      before,
      after: steps,
    });
  }
  if (flows.length === 0) return { ok: false, problems: [...problems, 'no usable flow'] };
  const risks = [];
  for (const risk of isList(value.risks) ? value.risks : []) {
    if (risk === null || typeof risk !== 'object') continue;
    if (!isText(risk.title)) continue;
    risks.push({
      title: risk.title,
      detail: isText(risk.detail) ? risk.detail : '',
      files: (isList(risk.files) ? risk.files : []).filter(isText),
    });
  }
  return { ok: true, value: { summary: value.summary, flows, risks } };
}

/** One side of a comparison: the nodes and the labelled edges between them. */
function normalizeSide(side, where, problems, required) {
  if (side === undefined || side === null) {
    if (required) problems.push(`${where} is missing`);
    return required ? null : { nodes: [], edges: [] };
  }
  const nodes = [];
  const ids = new Set();
  for (const [index, node] of (isList(side.nodes) ? side.nodes : []).entries()) {
    if (node === null || typeof node !== 'object') continue;
    if (!isText(node.label)) {
      problems.push(`${where}.nodes[${index}].label is missing`);
      continue;
    }
    const id = isText(node.id) ? node.id : `n${index + 1}`;
    if (ids.has(id)) {
      problems.push(`${where}.nodes has a duplicate id "${id}"`);
      continue;
    }
    ids.add(id);
    nodes.push({
      id,
      // A decision is drawn as one: the reviewer's diagram has conditions, and a
      // box that looks like a step makes a branch unreadable.
      kind: node.kind === 'decision' ? 'decision' : 'step',
      label: node.label,
      detail: isText(node.detail) ? node.detail : '',
      files: (isList(node.files) ? node.files : []).filter(isText),
      anchors: (isList(node.anchors) ? node.anchors : [])
        .filter((anchor) => anchor !== null && typeof anchor === 'object' && isText(anchor.path))
        .map((anchor) => {
          const line = Number.isSafeInteger(anchor.line) && anchor.line > 0 ? anchor.line : null;
          const declared =
            Number.isSafeInteger(anchor.endLine) && anchor.endLine > 0 ? anchor.endLine : null;
          // A range only means something under a start, and it is inclusive.
          const endLine = declared !== null && line !== null && declared > line ? declared : null;
          return { path: anchor.path, line, endLine };
        }),
      confidence: node.confidence === 'low' ? 'low' : 'high',
    });
  }
  if (nodes.length === 0) {
    problems.push(`${where}.nodes is empty`);
    // A side with nothing to draw makes the whole flow unusable, so the caller
    // drops the flow instead of rendering half of a comparison.
    return required ? null : { nodes: [], edges: [] };
  }
  const edges = [];
  for (const [index, edge] of (isList(side.edges) ? side.edges : []).entries()) {
    if (edge === null || typeof edge !== 'object') continue;
    if (!isText(edge.from) || !isText(edge.to) || !ids.has(edge.from) || !ids.has(edge.to)) {
      problems.push(`${where}.edges[${index}] does not connect two of its nodes`);
      continue;
    }
    edges.push({ from: edge.from, to: edge.to, label: isText(edge.label) ? edge.label : '' });
  }
  return { nodes, edges };
}

/**
 * The prompt for one generation.
 *
 * The model is asked for something it can be held to: several flows, each with
 * the state before and after the change, in the reviewer's language, grounded
 * in the material and allowed to say "low confidence" instead of inventing.
 * @param input `{ language, scopeLabel, branch, files, symbols, edges, snippets }`
 * @returns `{ system, user, bytes }`
 */
export function flowPrompt(input) {
  // The file list is the graph's own list; it is not capped here.
  const files = input.files ?? [];
  const lines = [];
  const context = typeof input.context === 'string' ? input.context.trim() : '';
  if (context !== '') {
    lines.push('Conversation context (why this change was asked for):');
    lines.push(context.slice(0, FLOW_LIMITS.contextChars));
    lines.push('');
  }
  lines.push(`Change source: ${input.scopeLabel ?? 'unspecified'}`);
  if (isText(input.branch)) lines.push(`Branch: ${input.branch}`);
  lines.push('');
  lines.push(`Changed files (${files.length}):`);
  for (const file of files) {
    const counts =
      file.added === null || file.added === undefined ? '' : ` +${file.added} −${file.deleted ?? 0}`;
    lines.push(`- ${file.path} [${file.untracked === true ? '?' : file.status}]${counts}`);
  }
  const symbols = input.symbols ?? {};
  const named = Object.keys(symbols).filter((path) => (symbols[path] ?? []).length > 0);
  if (named.length > 0) {
    lines.push('');
    lines.push('Symbols the changed files export:');
    for (const path of named) lines.push(`- ${path}: ${symbols[path].join(', ')}`);
  }
  const edges = input.edges ?? [];
  if (edges.length > 0) {
    lines.push('');
    lines.push('References between changed files:');
    for (const edge of edges.slice(0, 200)) {
      lines.push(`- ${edge.from} → ${edge.to}${edge.kinds ? ` (${edge.kinds.join('/')})` : ''}`);
    }
  }
  // Every changed file, whole. Nothing is clipped and nothing is skipped:
  // deciding what the model may read is the caller's business, and a truncated
  // excerpt silently changes the answer.
  const snippets = [];
  for (const snippet of input.snippets ?? []) {
    const text = String(snippet.diff ?? '');
    if (text.trim() === '') continue;
    snippets.push(`--- ${snippet.path}\n${text}`);
  }
  if (snippets.length > 0) {
    lines.push('');
    lines.push('Change excerpts (clipped to the stated budget):');
    lines.push(...snippets);
  }

  const system = [
    'You explain what a code change does to the *business processes* it touches, in the reviewer\'s language.',
    'Answer with one JSON object and nothing else: its first character must be "{" and its last "}".',
    'Never narrate your reasoning, restate the request, or explain the JSON around it.',
    'Write every label, detail, and risk in ASD-STE100 Simplified Technical English: short sentences, one idea per sentence, common words, no idioms, no marketing language.',
    'Produce one flow per affected business process; a change often touches more than one, and they must be separate entries.',
    'Each flow carries the process before the change and after it, so a reviewer can compare them side by side.',
    'The diagram is the deliverable and it must be readable at a glance: keep every node label to a few words (at most about 12 characters in Chinese), and put anything longer into detail, which the diagram does not show.',
    'Nodes are business steps written in plain language (what the system does for whom), never function or file names; put code names only in the detail and files fields.',
    'Do not produce a risk list, a review checklist, or advice: this document only explains the business processes the change touches, and `risks` stays an empty array.',
    'A node that is a condition or a choice carries "kind": "decision", and each of its outgoing edges carries the branch it takes ("有"/"无", "是"/"否", or the condition value).',
    'Every node MUST list at least one file it is based on in "files", and add an "anchors" entry with that file and the line you mean whenever the material shows one — a node without a file cannot be opened by the reviewer.',
    'An anchor covers a range when the step does: give "line" and "endLine" (inclusive) for a block of lines, and only "line" for one line. Do not collapse a range to its first line.',
    'Anchor lines are lines of the file on the side the diagram shows: the "before" side names original lines, the "after" side names the changed lines.',
    'Anchor a step to the code that implements it. Do not send the reader to a document, a comment file, or a configuration file for a step about behaviour; name such a file only when the step itself is about that document, and say so in the detail.',
    'If the material does not support a step or an edge, omit it, or mark the node "confidence": "low" — never invent behaviour.',
    'When conversation context is given, use it to name the business intent and the people or systems involved — but the code is the authority on what actually changed; if the two disagree, follow the code.',
    'Do not read the excerpts exhaustively and do not restate them: decide the flows from the file list, the symbols, and the references, then answer.',
    'JSON shape:',
    '{"summary": string, "flows": [{"id": string, "title": string, "detail": string, "before": {"nodes": [{"id": string, "kind": "step"|"decision", "label": string, "detail": string, "files": [string], "anchors": [{"path": string, "line": number, "endLine": number|null}], "confidence": "high"|"low"}], "edges": [{"from": string, "to": string, "label": string}]}, "after": {"nodes": [...], "edges": [...]}}], "risks": [{"title": string, "detail": string, "files": [string]}]}',
    '`before` is the process as the change source\'s base has it; `after` is the state the change produces. Keep node ids local to their side.',
  ].join('\n');

  const user = `${lines.join('\n')}\n\nExplain the business processes this change affects.`;
  return {
    system,
    user,
    bytes: Buffer.byteLength(system + user, 'utf8'),
    withExcerpts: snippets.length,
    // The excerpts on their own, so a caller can label that figure honestly
    // instead of calling the whole prompt "the change excerpts".
    excerptBytes: Buffer.byteLength(snippets.join('\n'), 'utf8'),
  };
}

/** Clip text, marking that it was cut. */
function clipText(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (clipped)`;
}

/** The instruction a record stands for, when the caller names none. */
export const FLOW_INSTRUCTION = '生成流程图解释所有变更的代码';

/**
 * The message a debug record appends to the conversation.
 *
 * It is the *request*, not the material: an appended message is something the
 * user said, so it may not carry the prompt, the diff, or the answer. The
 * generation's full prompt and raw answer stay in the panel that asked for
 * them, where reading them costs nothing and misrepresents nobody.
 * @param input `{ instruction, scope, model, provider, usage, generatedAt, cached }`
 * @returns a one-line request plus one line of provenance
 */
export function flowRecordText(input) {
  const usage =
    input.usage === null || input.usage === undefined
      ? null
      : `${input.usage.inputTokens ?? '?'}+${input.usage.outputTokens ?? '?'} tok`;
  const provenance = [
    input.scope === undefined || input.scope === null ? null : `变更来源：${input.scope}`,
    `模型：${[input.provider, input.model].filter((part) => typeof part === 'string' && part !== '').join(' ') || '?'}`,
    usage,
    input.generatedAt ?? null,
    input.cached === true ? '复用缓存' : null,
  ].filter((part) => part !== null);
  const instruction =
    typeof input.instruction === 'string' && input.instruction.trim() !== ''
      ? input.instruction.trim()
      : FLOW_INSTRUCTION;
  return `${instruction}\n\n[review-graph] ${provenance.join(' · ')}`;
}

/**
 * The answer as the conversation reads it.
 *
 * The panel draws boxes and arrows; a chat message cannot, so the same document
 * is rendered as steps and transitions in plain language — the request says what
 * was asked, this says what came back, and the panel is the diagram of it.
 * @param document validated flow document
 * @param limit characters kept
 * @returns readable text
 */
export function flowAnswerText(document, limit = 6_000) {
  if (document === null || typeof document !== 'object') return '';
  const lines = ['业务流程（AI 生成）'];
  if (typeof document.summary === 'string' && document.summary.trim() !== '') {
    lines.push('', document.summary.trim());
  }
  const labelOf = (side, id) =>
    (side?.nodes ?? []).find((node) => node.id === id)?.label ?? id;
  for (const [index, flow] of (document.flows ?? []).entries()) {
    lines.push('', `${index + 1}. ${flow.title}`);
    if (typeof flow.detail === 'string' && flow.detail.trim() !== '') lines.push(`   ${flow.detail.trim()}`);
    const render = (title, side) => {
      const nodes = (side?.nodes ?? []).map((node) => node.label);
      if (nodes.length === 0) return;
      lines.push(`   ${title}：${nodes.join(' → ')}`);
      for (const edge of side?.edges ?? []) {
        lines.push(`     · ${labelOf(side, edge.from)} → ${labelOf(side, edge.to)}${edge.label === '' ? '' : `（${edge.label}）`}`);
      }
    };
    render('改动前', flow.before);
    render('改动后', flow.after);
  }
  if ((document.risks ?? []).length > 0) {
    lines.push('', '风险与关注点：');
    for (const risk of document.risks) {
      lines.push(`- ${risk.title}${risk.detail === '' ? '' : `：${risk.detail}`}`);
    }
  }
  const text = lines.join('\n');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (clipped)`;
}

/** Whether two generations describe the same material. */
export function flowCacheKey({ root, scope, head, revision, context }) {
  return [root, scope, head ?? '', revision ?? '', stableHash(context ?? '')].join('\u0000');
}
