import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ts = require(process.env.GRAPH_TYPESCRIPT);
const root = process.cwd();
const out = process.env.GRAPH_OUT;
fs.mkdirSync(out, { recursive: true });
const rel = p => path.relative(root, p).replaceAll('\\', '/');
const configPath = path.resolve('server/tsconfig.src.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const files = program.getSourceFiles().filter(f => rel(f.fileName).startsWith('server/src/'));
const fileSet = new Set(files.map(f => rel(f.fileName)));
const edges = [], unresolved = [];
function symbolKind(node) {
  let s = checker.getSymbolAtLocation(node);
  const seen = new Set();
  while (s && (s.flags & ts.SymbolFlags.Alias) && !seen.has(s)) {
    seen.add(s); s = checker.getAliasedSymbol(s);
  }
  const ds = s?.declarations ?? [];
  if (!ds.length) return 'unknown';
  if (ds.every(d => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d))) return 'type';
  if (ds.some(d => ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d))) return 'function';
  if (ds.some(d => ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))) return 'function';
  if (ds.some(d => ts.isVariableDeclaration(d) && d.parent && (d.parent.flags & ts.NodeFlags.Const))) return 'constant-binding';
  if (ds.some(d => ts.isClassDeclaration(d))) return 'class';
  if (ds.some(d => ts.isEnumDeclaration(d))) return 'enum';
  return 'other';
}
function add(sf, node, spec, syntax, bindings, runtime) {
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const base = { from: rel(sf.fileName), line: pos.line + 1, syntax, specifier: spec?.text ?? null, expression: spec?.getText(sf) ?? null, bindings, runtime: runtime && !sf.isDeclarationFile };
  if (!spec || !ts.isStringLiteralLike(spec)) {
    unresolved.push({ ...base, reason: 'nonliteral-module-reference' }); return;
  }
  const resolution = ts.resolveModuleName(spec.text, sf.fileName, parsed.options, ts.sys, undefined, undefined,
    syntax === 'require' || syntax === 'import-equals' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
  const builtin = spec.text.startsWith('node:') || require('node:module').builtinModules.includes(spec.text);
  const to = resolution ? rel(resolution.resolvedFileName) : null;
  const edge = { ...base, to, internal: fileSet.has(to), resolution: builtin ? 'builtin' : resolution ? 'resolved' : 'unresolved' };
  edges.push(edge);
  if (!resolution && !builtin) unresolved.push({ ...base, reason: 'module-resolution-failed' });
  for (const b of bindings) if (b.kind === 'unknown') unresolved.push({ ...base, binding: b.name, reason: 'symbol-classification-unknown' });
}
for (const sf of files) {
  function visit(n) {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause, bs = [];
      if (!c) bs.push({ name: '*', typeOnly: false, kind: 'side-effect' });
      if (c?.name) bs.push({ name: 'default', typeOnly: c.isTypeOnly, kind: symbolKind(c.name) });
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) bs.push({ name: '*', typeOnly: c.isTypeOnly, kind: 'namespace' });
        else for (const e of c.namedBindings.elements) bs.push({ name: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: c.isTypeOnly || e.isTypeOnly, kind: symbolKind(e.name) });
      }
      add(sf, n, n.moduleSpecifier, 'import', bs, !c?.isTypeOnly && (!bs.length || bs.some(b => !b.typeOnly)));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const bs = n.exportClause && ts.isNamedExports(n.exportClause)
        ? n.exportClause.elements.map(e => ({ name: (e.propertyName ?? e.name).text, typeOnly: n.isTypeOnly || e.isTypeOnly, kind: symbolKind(e.name) }))
        : [{ name: '*', typeOnly: n.isTypeOnly, kind: 'reexport-namespace' }];
      add(sf, n, n.moduleSpecifier, 'export-from', bs, !n.isTypeOnly && bs.some(b => !b.typeOnly));
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      add(sf, n, n.moduleReference.expression, 'import-equals', [{ name: n.name.text, typeOnly: n.isTypeOnly, kind: 'namespace' }], !n.isTypeOnly);
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      add(sf, n, n.argument.literal, 'import-type-query', [{ name: n.qualifier?.getText(sf) ?? '*', typeOnly: true, kind: 'type-query' }], false);
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      add(sf, n, n.arguments[0], n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require', [{ name: '*', typeOnly: false, kind: 'dynamic-namespace' }], true);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
}
function scc(nodes, es) {
  const adj = new Map(nodes.map(n => [n, []]));
  for (const [a,b] of es) if (adj.has(a) && adj.has(b)) adj.get(a).push(b);
  let counter = 0; const indices = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  function visit(v) {
    indices.set(v,counter); low.set(v,counter++); stack.push(v); active.add(v);
    for (const w of adj.get(v)) {
      if (!indices.has(w)) { visit(w); low.set(v,Math.min(low.get(v),low.get(w))); }
      else if (active.has(w)) low.set(v,Math.min(low.get(v),indices.get(w)));
    }
    if (low.get(v) === indices.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); active.delete(w); c.push(w); } while (w !== v);
      result.push(c.sort());
    }
  }
  for (const n of nodes) if (!indices.has(n)) visit(n);
  return result.sort((a,b) => b.length-a.length || a[0].localeCompare(b[0]));
}
const groups = {
  top: p => { const a = p.slice('server/src/'.length).split('/'); return a.length === 1 ? 'src-root' : a[0]; },
  serviceSubdirs: p => { const a = p.slice('server/src/'.length).split('/'); return a.length === 1 ? 'src-root' : a[0] === 'services' && a.length > 2 ? a.slice(0,2).join('/') : a[0]; },
};
const graphs = {};
for (const [graph, selected] of Object.entries({ type: edges.filter(e => e.internal), runtimeConservative: edges.filter(e => e.internal && e.runtime) })) {
  const components = scc([...fileSet], selected.map(e => [e.from,e.to]));
  const membership = new Map(components.flatMap((c,i) => c.map(n => [n,i])));
  const cycleEdges = selected.filter(e => membership.get(e.from) === membership.get(e.to) && (e.from === e.to || components[membership.get(e.from)].length > 1));
  const grouped = {};
  for (const [name, group] of Object.entries(groups)) {
    const counts = new Map();
    for (const e of selected) { const a=group(e.from), b=group(e.to); if (a!==b) { const k=a+' -> '+b; counts.set(k,(counts.get(k)??0)+1); } }
    const nodes = [...new Set([...fileSet].map(group))];
    grouped[name] = { nodes, edges: [...counts].sort().map(([edge,count]) => ({ edge,count })), scc: scc(nodes, selected.map(e => [group(e.from),group(e.to)])) };
  }
  graphs[graph] = { edgeCount: selected.length, scc: components, cycleEdges, grouped };
}
const git = (...args) => execFileSync('git',args,{encoding:'utf8'}).trim();
const metadata = {
  sourceSha: git('rev-parse','HEAD'), workflowSha: process.env.GRAPH_WORKFLOW_SHA,
  node: process.version, typescript: ts.version, nativeCompilerDependency: JSON.parse(fs.readFileSync('package.json')).devDependencies.typescript,
  command: 'GRAPH_TYPESCRIPT=<tools>/node_modules/typescript/lib/typescript.js GRAPH_OUT=<evidence> node <workflow-checkout>/.github/scripts/server-import-graph.mjs',
  config: 'server/tsconfig.src.json', options: parsed.options, files: files.length,
  groupRules: { top: 'first directory; files directly under src => src-root', serviceSubdirs: 'top, but services/<directory> is its own group; direct services files => services' },
  limits: ['No emit, diagnostics, typecheck or runtime execution. TypeScript 5.9.3 static API parses the TypeScript 7 project configuration.', 'type includes every statically resolved internal dependency including type-only and reexports. runtimeConservative excludes explicit type-only edges only; it is an upper bound, not emitted-JS proof.', 'Counts are syntactic module-reference occurrences, not unique source-target pairs. const-binding describes const declaration, not immutability or absence of effects.', 'External package dependencies are recorded, not traversed for SCCs. All server source files reached by program resolution are scanned, including any excluded file pulled by an import.', 'Nonliteral module references and unknown symbol classifications are listed, never guessed. Namespace and star reexports remain aggregate edges. require identifier shadowing is conservatively included; computed/aliased loaders beyond require/import syntax are outside coverage.']
};
for (const [name,value] of Object.entries({ metadata, edges, unresolved, graphs, files: files.map(f => ({ path:rel(f.fileName),lines:f.text.split('\n').length })) })) fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(value,null,2)+'\n');
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({ ...metadata, edgeCount:edges.length, unresolvedCount:unresolved.length, graphs:Object.fromEntries(Object.entries(graphs).map(([k,v]) => [k,{edgeCount:v.edgeCount,largestScc:v.scc[0],grouped:v.grouped}])) },null,2)+'\n');
for (const name of ['server-import-graph.mjs','../workflows/server-import-graph-evidence.yml']) {
  const input = path.resolve(path.dirname(new URL(import.meta.url).pathname),name);
  const bytes=fs.readFileSync(input); fs.writeFileSync(path.join(out,path.basename(input)),bytes);
  fs.appendFileSync(path.join(out,'SHA256SUMS'),crypto.createHash('sha256').update(bytes).digest('hex')+'  '+path.basename(input)+'\n');
}
console.log(JSON.stringify({ files:files.length,edges:edges.length,unresolved:unresolved.length,typeLargestScc:graphs.type.scc[0].length,runtimeLargestScc:graphs.runtimeConservative.scc[0].length }));
