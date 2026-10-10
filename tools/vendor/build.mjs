// 사용법: cd tools/vendor && npm install && npm run build
// 결과: src/MdReader/wwwroot/vendor/{vendor.js, editor.js, mermaid.min.js, katex/}
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const out = resolve(here, '../../src/MdReader/wwwroot/vendor');
const pkgDir = (name) => dirname(require.resolve(name + '/package.json'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'katex/fonts'), { recursive: true });

await build({
  entryPoints: [join(here, 'vendor-entry.js')],
  bundle: true, minify: true, format: 'iife', target: 'chrome110',
  outfile: join(out, 'vendor.js'),
  legalComments: 'external',
  nodePaths: [join(here, 'node_modules'), ...(process.env.NODE_PATH ? [process.env.NODE_PATH] : [])]
});

await build({
  entryPoints: [join(here, 'editor-entry.js')],
  bundle: true, minify: true, format: 'iife', target: 'chrome110',
  outfile: join(out, 'editor.js'),
  legalComments: 'external',
  nodePaths: [join(here, 'node_modules'), ...(process.env.NODE_PATH ? [process.env.NODE_PATH] : [])]
});

cpSync(join(pkgDir('mermaid'), 'dist/mermaid.min.js'), join(out, 'mermaid.min.js'));
const katexDist = join(pkgDir('katex'), 'dist');
cpSync(join(katexDist, 'katex.min.css'), join(out, 'katex/katex.min.css'));
for (const f of readdirSync(join(katexDist, 'fonts'))) {
  if (f.endsWith('.woff2')) cpSync(join(katexDist, 'fonts', f), join(out, 'katex/fonts', f));
}
console.log('vendor →', out);
