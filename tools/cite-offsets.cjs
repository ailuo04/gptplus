const fs = require('fs');
const D = 'C:\\ailuo_own\\gpt++\\tools\\asar-out\\';
const sh = fs.readFileSync(D + 'app-shared.js', 'latin1');
const ini = fs.readFileSync(D + 'app-initial.js', 'latin1');
const shNeedles = ['function UB(e)', 'function W9t(e)', 'function G9t(e)', 'function K9t(e)', 'var q9t', 'function O3r(e,t,n=100)', 'function Gfn(e,t)', 'W9t as iLt', 'G9t as oLt', 'UB as rLt', 'O3r as VN'];
const iniNeedles = ['j5r=ec(q', 'queryKey:[...Vye(i,t,s)', 'sendRequest(`model/list`', 'function c5r(', 'function l5r(', 'function D5r(e)', 'function Q9r(', 'function m5r(e)', 'h5r=[],g5r=', 'h=hVe(c)', 'f=IPe(c)', 'iLt as IPe', 'oLt as hVe', 'rLt as Hm', 'VN as Vye', 'Dye(e)&&i.has(e)', 'hasConfiguredModelCatalog:IPe(p)', 'isCustomModelProvider:hVe(p)', 'additionalAvailableModels:l'];
for (const n of shNeedles) console.log('app-shared.js  ' + String(sh.indexOf(n)).padStart(9) + '  ' + n);
for (const n of iniNeedles) console.log('app-initial.js ' + String(ini.indexOf(n)).padStart(9) + '  ' + n);
