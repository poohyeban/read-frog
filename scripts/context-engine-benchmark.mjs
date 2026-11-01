import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { build } from "vite"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(process.argv[2] || repository)
const destination = resolve(process.argv[3] || "/tmp/context-v2-benchmark.json")
const output = `/tmp/context-v2-benchmark-build-${process.pid}`
const source = resolve(sourceRoot, "src")
const harness = resolve(repository, "e2e/translation-harness")
const replacements = new Map([
  [resolve(source, "utils/message"), `${harness}/messages.js`],
  [resolve(source, "utils/i18n"), `${harness}/i18n.js`],
])
await build({
  configFile: false,
  root: sourceRoot,
  logLevel: "warn",
  resolve: { alias: { "@": source, "#imports": `${harness}/runtime.js` } },
  plugins: [
    {
      name: "context-benchmark",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "virtual:context-benchmark") return "\0context-benchmark"
        const absolute = id.startsWith("@/")
          ? resolve(source, id.slice(2))
          : id.startsWith(".") && importer
            ? resolve(dirname(importer), id)
            : id
        return replacements.get(absolute)
      },
      load(id) {
        if (id !== "\0context-benchmark") return undefined
        return `import * as context from '@/utils/host/translate/webpage-context';
      window.contextAPI = context;
      window.costs = { longTasks: [] };
      new PerformanceObserver(list => { window.costs.longTasks.push(...list.getEntries().map(e => e.duration)) }).observe({type:'longtask', buffered:true});
      window.bench = async (count, ordinary = false) => {
        context.releaseWebPageContext();
        const main = document.createElement('main');
        if (ordinary) main.innerHTML = '<article><h1>Frog research</h1><p id="unit-0">English article about frogs and their habitat. UNIT_0</p></article>';
        else {
          main.setAttribute('role','feed');
          const fragment = document.createDocumentFragment();
          for(let i=0;i<count;i++) { const item=document.createElement('article');item.id='unit-'+i;item.innerHTML='<h2>Post '+i+'</h2><p>Independent English source about research and its interpretation. UNIT_'+i+'</p><a rel="bookmark" href="/posts/'+i+'">Permalink</a>';fragment.append(item) }
          main.append(fragment);
        }
        document.body.replaceChildren(main);
        const samples={reads:[],warm:[],mutations:[],resolves:[]};
        const nodes=Array.from({length:Math.min(count,50)},(_,i)=>document.querySelector('#unit-'+i));
        let isolated=true;
        const read=async node=>context.getOrCreateWebPageContext(true,undefined,{source:node});
        for(const node of nodes) { const start=performance.now(); const value=await read(node); samples.reads.push(performance.now()-start); if(count>1 && nodes.indexOf(node)===0) isolated=value?.webContent?.replaceAll(String.fromCharCode(92),'').includes('UNIT_0') && !value?.webContent?.replaceAll(String.fromCharCode(92),'').includes('UNIT_1'); }
        const resolver=context[window.resolverExport];
        if(resolver) for(let i=0;i<100;i++){const start=performance.now();resolver({source:nodes[i%nodes.length]});samples.resolves.push(performance.now()-start)}
        for(let i=0;i<100;i++){const start=performance.now();await read(nodes[i%nodes.length]);samples.warm.push(performance.now()-start)}
        let rebuiltCorrectly=true;
        for(let batch=0;batch<10;batch++){
          const start=performance.now();
          for(let i=0;i<100;i++){ const node=main.lastElementChild;main.prepend(node); const extra=document.createElement('aside');extra.textContent='unrelated ticker';main.append(extra);extra.remove() }
          await Promise.resolve();context.synchronizeWebPageContext();
          samples.mutations.push(performance.now()-start);
        }
        const own=nodes[0]; const text=ordinary ? own : own.querySelector('p');
        text.textContent='RECYCLED_DIFFERENT_POST';
        await Promise.resolve();
        rebuiltCorrectly=(await read(own))?.webContent?.replaceAll(String.fromCharCode(92),'').includes('RECYCLED_DIFFERENT_POST') ?? false;
        const diagnostic=context[window.diagnosticExport];
        const beforeRelease=diagnostic?.() ?? null;
        context.releaseWebPageContext();
        const afterRelease=diagnostic?.() ?? null;
        await new Promise(resolve=>setTimeout(resolve,50));
        return {count,ordinary,samples,isolated,rebuiltCorrectly,beforeRelease,afterRelease,longTasks:window.costs.longTasks};
      };
    `
      },
    },
  ],
  build: {
    target: "esnext",
    outDir: output,
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: "virtual:context-benchmark",
      output: { entryFileNames: "entry.js", chunkFileNames: "[name].js" },
    },
  },
})
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html")
      res.end(
        '<html><head><title>Context benchmark</title></head><body><script type="module" src="/entry.js"></script></body></html>',
      )
      return
    }
    res.setHeader("content-type", "text/javascript")
    res.end(await readFile(resolve(output, req.url.slice(1))))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
})
const result = {
  sourceRoot,
  browser: browser.version(),
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  samples: [],
  paidHTTP: 0,
  notes:
    "Real Chromium DOM/context extraction; no model requests. Fifty distinct scopes and 100 warm reads per corpus; 10 batches of 100 reorder/insertion/deletion operations.",
}
try {
  for (const count of [1, 100, 1000, 50000]) {
    const page = await browser.newPage()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.bench)
    await page.evaluate(() => {
      window.resolverExport = "resolveContextScope"
      window.diagnosticExport = "getContextDiagnostics"
    })
    await cdp.send("HeapProfiler.collectGarbage")
    const initial = await cdp.send("Performance.getMetrics")
    const measured = await page.evaluate(({ count: units }) => window.bench(units, units === 1), {
      count,
    })
    await cdp.send("HeapProfiler.collectGarbage")
    const final = await cdp.send("Performance.getMetrics")
    const metric = (data, name) => data.metrics.find((m) => m.name === name)?.value ?? null
    measured.cpuTaskSeconds = metric(final, "TaskDuration") - metric(initial, "TaskDuration")
    measured.heapAfterRelease = metric(final, "JSHeapUsedSize")
    result.samples.push(measured)
    await page.close()
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, JSON.stringify(result, null, 2) + "\n")
    process.stdout.write(`Measured ${count} units\n`)
  }
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
