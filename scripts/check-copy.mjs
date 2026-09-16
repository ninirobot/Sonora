// 文案守护：把「宣传数字」与「真实语音目录」绑在一起，口径不一致就直接报错。
//
//   node scripts/check-copy.mjs
//
// 为什么需要它：旧文案把 379 副嗓音写成「20+ 种语音」，就是因为数字是手写的、
// 没人对账。这里做三件事：
//   1. README 的语音清单区必须与 data/voices.json 现算结果逐字一致；
//   2. 文档与页面里不允许再出现「20+」那批旧口径；
//   3. 页面 8 种界面语言的词典都必须带上品牌名、宣传口径 300+ 与三个真实数字，漏改一个语种就会被抓住。
// 另外顺手校验两处伪装浏览器标识是否还是同一个值（改一处忘一处很常见）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { START_MARK, END_MARK, voiceStats, voiceStatsBlock } from './gen-voice-stats.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

const problems = [];
const check = (ok, message) => {
    if (!ok) problems.push(message);
};

// ---------------------------------------------------------------------------
// 1. README 清单区
// ---------------------------------------------------------------------------
const stats = voiceStats();
const readme = read('README.md');
const start = readme.indexOf(START_MARK);
const end = readme.indexOf(END_MARK);

check(start >= 0 && end > start, 'README.md 缺少 ' + START_MARK + ' / ' + END_MARK + ' 标记');
if (start >= 0 && end > start) {
    const actual = readme.slice(start + START_MARK.length, end).trim();
    check(actual === voiceStatsBlock(stats),
        'README 的语音清单区与 data/voices.json 不一致，跑一次 node scripts/gen-voice-stats.mjs 即可');
}

// ---------------------------------------------------------------------------
// 2. 不许再出现的旧口径与旧品牌名
// ---------------------------------------------------------------------------
// 旧品牌名是大小写敏感匹配，两种写法都要列，少一个就漏一个
const BANNED = [
    '20+', '20＋', '20 以上', '20以上', '20以上の', '20 以上の',
    '20개 이상', 'más de 20', 'Más de 20', 'plus de 20', 'über 20',
    'более 20', 'Более 20', 'VoiceCraft', 'voicecraft', 'tts-voice-magic'
];

const page = read('src/index.html');
for (const [file, text] of [
    ['README.md', readme],
    ['src/index.html', page],
    ['wrangler.toml', read('wrangler.toml')],
    ['desktop/tauri.conf.json', read('desktop/tauri.conf.json')]
]) {
    for (const word of BANNED) {
        check(text.indexOf(word) < 0, file + ' 里还有旧口径：' + word);
    }
}

// ---------------------------------------------------------------------------
// 3. 页面 8 个语种的词典
// ---------------------------------------------------------------------------
const dictStart = page.indexOf('const translations = {');
const dictEnd = page.indexOf('\n        };', dictStart);
check(dictStart >= 0 && dictEnd > dictStart, 'src/index.html 里找不到 translations 词典');

if (dictStart >= 0 && dictEnd > dictStart) {
    const dict = page.slice(dictStart, dictEnd);
    // 每个语种块以「12 个空格 + 语言码 + : {」开头
    const parts = dict.split(/\n\s{12}([a-z]{2}): \{/).slice(1);
    const locales = {};
    for (let i = 0; i < parts.length; i += 2) locales[parts[i]] = parts[i + 1];

    const expectLocales = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];
    check(Object.keys(locales).length === expectLocales.length,
        '页面词典语种数量不是 ' + expectLocales.length + ' 个，实际 ' + Object.keys(locales).length + ' 个');

    // 宣传口径（300+）与真实规模数字分开断言：前者是话术，后者必须与 voices.json 一致
    const voiceLabel = '300+';
    const numbers = [stats.languages.length, stats.accents.length, stats.familyCount];
    for (const locale of expectLocales) {
        const block = locales[locale];
        if (!block) {
            problems.push('页面词典缺少语种：' + locale);
            continue;
        }
        check(block.indexOf(voiceLabel) >= 0,
            '语种 ' + locale + ' 的文案没带上宣传口径 ' + voiceLabel);
        for (const number of numbers) {
            check(block.indexOf(String(number)) >= 0,
                '语种 ' + locale + ' 的文案没带上真实数字 ' + number);
        }
        check(block.indexOf(locale === 'zh' ? '声界' : 'Sonora') >= 0,
            '语种 ' + locale + ' 的文案没带品牌名');
    }

    // 静态兜底文案（首屏未执行脚本时显示的就是它）
    check(/<title[^>]*>Sonora/.test(page), '页面静态标题没换成新品牌');
    check(/<h1[^>]*>Sonora/.test(page), '页面静态 h1 没换成新品牌');
}

// ---------------------------------------------------------------------------
// 4. 两处伪装浏览器标识必须同值
// ---------------------------------------------------------------------------
const uaOf = (file, pattern) => {
    const hit = pattern.exec(read(file));
    return hit && hit[1];
};
const webUa = uaOf('index.js', /const EDGE_UA = "([^"]+)"/);
const desktopUa = uaOf('desktop/src/auth.rs', /const USER_AGENT: &str = "([^"]+)"/);

check(!!webUa, 'index.js 里找不到 EDGE_UA 常量');
check(!!desktopUa, 'desktop/src/auth.rs 里找不到 USER_AGENT 常量');
check(webUa === desktopUa, '网页版与桌面版的浏览器标识不一致：\n  index.js: ' + webUa + '\n  auth.rs : ' + desktopUa);

// 令牌请求曾把 UA 写死成旧版本、正好躲过上面的常量比对：这里把 index.js 里
// 所有硬编码的 Edge 版本号都抓出来，不许出现与 EDGE_UA 不同的版本
const staleVersions = [...new Set(read('index.js').match(/Edg\/[\d.]+/g) || [])]
    .filter(version => !String(webUa).includes(version));
check(staleVersions.length === 0, 'index.js 里还有没跟着 EDGE_UA 走的旧 Edge 标识：' + staleVersions.join('、'));

// ---------------------------------------------------------------------------
if (problems.length) {
    console.error('文案自检未通过：');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
}

const uaVersion = /Edg\/([\d.]+)/.exec(webUa || '');
console.log('文案自检：通过');
console.log('  语音规模 ' + stats.uniqueIds + ' 个 id / ' + stats.entries + ' 条语音 / '
    + stats.languages.length + ' 种语言 / ' + stats.accents.length + ' 个口音');
console.log('  伪装标识 ' + (uaVersion ? 'Edge ' + uaVersion[1] : '（未解析出版本号）'));
