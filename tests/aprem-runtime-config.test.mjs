import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync('js/app/config/runtime-config.js','utf8').replaceAll('export ', '');
function load(window) {
  return vm.runInNewContext(`${source}\n({runtimeConfig, url:buildApiUrl('/layers/public')})`, {window});
}
test('APREM keeps operational API for production /aprem/ and uses local API on localhost',()=>{
  assert.equal(load({location:{hostname:'fgarduno-nas.github.io',pathname:'/aprem/'}}).url,'https://api-egem.geodinamica.mx/api/v1/layers/public');
  assert.equal(load({location:{hostname:'localhost'}}).runtimeConfig.apiBaseUrl,'http://localhost:4000/api/v1');
});
test('APREM override takes precedence while legacy deployments remain compatible',()=>{
  const window={location:{hostname:'fgarduno-nas.github.io'},__EGEM_CONFIG__:{apiBaseUrl:'https://legacy.example/api/v1/'}};
  assert.equal(load(window).runtimeConfig.apiBaseUrl,'https://legacy.example/api/v1');
  window.__APREM_CONFIG__={apiBaseUrl:'https://api-aprem.example/api/v1///'};
  assert.equal(load(window).url,'https://api-aprem.example/api/v1/layers/public');
});
