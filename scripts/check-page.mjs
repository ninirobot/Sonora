// 页面自检：把 src/index.html 里的占位标记替换成 data/*.json 的数据，
// 再抽出 <script> 做语法检查。
//
//   node scripts/check-page.mjs
//
// 为什么需要它：整页前端内联在 HTML 里，内联脚本一旦有语法错误，浏览器会整段跳过，
// 表现为「页签、语音下拉全空」且控制台只有一个报错 —— 光看源码很难发现。
// 这里用 new Function 只做编译不执行，能提前把语法问题挡住。
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

const page = read('src/index.html');
const voices = JSON.parse(read('data/voices.json'));
const labels = JSON.parse(read('data/labels.json'));
const promotion = labels.promotion;

// 与 index.js 的 renderPage()、desktop 的 data.rs 保持同一套键名
const values = {
    'VOICE_CATALOG': JSON.stringify(voices.voiceCatalog),
    'STYLE_LABELS': JSON.stringify(labels.styleLabels),
    'PARALINGUISTIC_LABELS': JSON.stringify(labels.paralinguisticLabels),
    'HD_STYLES': JSON.stringify(labels.hdStyles),
    'HD_OMNI_STYLES': JSON.stringify(labels.hdOmniStyles),
    'PARALINGUISTICS': JSON.stringify(labels.paralinguistics),
    'TEXT_PLACEHOLDERS': JSON.stringify(labels.textPlaceholders),
    'MULTITALKER_SPEAKERS': JSON.stringify(voices.multitalkerSpeakers),
    'STYLES_UNKNOWN': JSON.stringify(labels.stylesUnknown),
    'RUNTIME': '"web"',
    'PROMOTION': JSON.stringify(promotion),
    'PROMOTION.title': promotion.title,
    'PROMOTION.subtitle': promotion.subtitle,
    'PROMOTION.qrCodeUrl': promotion.qrCodeUrl,
    'PROMOTION.qrCodeAlt': promotion.qrCodeAlt,
    'PROMOTION.name': promotion.name,
    'PROMOTION.description': promotion.description,
    'PROMOTION.benefits': promotion.benefits.map(text => '<li>' + text + '</li>').join('')
};

let replaced = 0;
let html = page.replace(/\/\*__DATA:([\w.]+)__\*\//g, (all, key) => {
    if (!(key in values)) throw new Error('页面出现未知占位标记：' + key);
    replaced += 1;
    return values[key];
});

if (replaced !== Object.keys(values).length) {
    throw new Error('占位标记未全部命中：替换 ' + replaced + ' 处，期望 ' + Object.keys(values).length + ' 处');
}
if (html.indexOf('__DATA:') >= 0) throw new Error('页面里仍有残留的占位标记');

// 抽出内联脚本：只编译不执行，语法错误会直接抛出来
const scripts = [];
const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
let hit;
while ((hit = scriptRe.exec(html)) !== null) scripts.push(hit[1]);

if (!scripts.length) throw new Error('页面里没有找到 <script> 块');

let lines = 0;
let backslashLines = 0;
for (const code of scripts) {
    const scriptLines = code.split(/\r?\n/);
    lines += scriptLines.length;
    for (const line of scriptLines) {
        if (line.indexOf(String.fromCharCode(92)) >= 0) backslashLines += 1;
    }
    new Function(code);
}

if (backslashLines > 0) throw new Error('内联脚本仍有 ' + backslashLines + ' 行含反斜杠（模板里会被吃掉）');

// 体积上限：语音目录与整页前端都内联进 Worker 和 exe，涨上去没人会发现
const LIMITS = { pageChars: 175000, bundleBytes: 320000 };
const bundle = ['index.js', 'data/voices.json', 'data/labels.json', 'src/index.html']
    .reduce((sum, file) => sum + statSync(join(root, file)).size, 0);
if (page.length > LIMITS.pageChars) throw new Error('页面模板 ' + page.length + ' 字符，超过上限 ' + LIMITS.pageChars);
if (bundle > LIMITS.bundleBytes) throw new Error('打包 ' + bundle + ' 字节，超过上限 ' + LIMITS.bundleBytes);

console.log('页面渲染：' + html.length + ' 字符，占位标记 ' + replaced + ' 处全部命中');
console.log('体积：模板 ' + page.length + ' / ' + LIMITS.pageChars + ' 字符，打包 ' + bundle + ' / ' + LIMITS.bundleBytes + ' 字节');
console.log('内联脚本：' + scripts.length + ' 块 / ' + lines + ' 行，语法通过，反斜杠 0 行');
