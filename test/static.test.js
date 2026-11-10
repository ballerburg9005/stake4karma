import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const get = p => readFile(resolve(root,p),'utf8');

test('branch-root GitHub Pages provides reachable public entrypoints', async () => {
  const home = await get('index.html');
  const recovery = await get('recover.html');
  assert.match(home, /location\.replace\('\.\/site\//);
  assert.match(recovery, /location\.replace\('\.\/site\/recover\.html/);
  assert.match(home, /location\.search \+ location\.hash/); // preserve contract sharing query
  assert.match(recovery, /location\.search \+ location\.hash/);
  assert.match(await get('site/index.html'), /src="\.\/app\.js"/);
  assert.match(await get('site/app.js'), /from '\.\/stake\.js'/);
  assert.match(await get('site/recover.js'), /from '\.\/stake\.js'/);
  assert.match(await get('site/stake.js'), /export \* from '\.\.\/src\/stake\.js'/);
  assert.match(await get('src/stake.js'), /export async function withdraw\(/);
  await access(resolve(root,'.nojekyll'));
});

test('standalone dist/ bundle loads without depending on parent src/ paths', async () => {
  const build = spawnSync(process.execPath, ['scripts/build-pages.mjs'], {cwd:root,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  assert.match(await get('dist/index.html'), /src="\.\/app\.js"/);
  assert.match(await get('dist/app.js'), /from '\.\/stake\.js'/);
  assert.match(await get('dist/recover.js'), /from '\.\/stake\.js'/);
  const sdk = await get('dist/stake.js');
  assert.match(sdk, /export async function withdraw\(/);
  assert.doesNotMatch(sdk, /export \* from '\.\.\/src/);
});
