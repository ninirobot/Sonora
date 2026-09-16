// 界面原型自检：确保 design/ 下的每款原型都是「单文件、零依赖、脚本能跑」。
//
//   node scripts/check-design.mjs
//
// 为什么需要它：原型有一堆内联脚本与互链，手改之后很容易出现
// 「脚本语法错误导致整款原型变成死图」或「链接写错点不开」，
// 而这两种问题光看代码都看不出来。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'design');
const files = readdirSync(dir).filter(name => name.endsWith('.html'));

const problems = [];
let totalScripts = 0;

for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    const isOverview = file.startsWith('00-');

    // 1. 内联脚本必须能编译（总览页是纯展示，不要求有脚本）
    const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    if (!scripts.length && !isOverview) problems.push(file + '：没有任何 <script> 块');
    for (const [, code] of scripts) {
        totalScripts += 1;
        try {
            new Function(code);
        } catch (error) {
            problems.push(file + '：内联脚本编译失败 — ' + error.message);
        }
    }

    // 2. 站内链接必须指向真实存在的文件
    for (const [, href] of source.matchAll(/href="([^"]+\.html)"/g)) {
        if (!files.includes(href)) problems.push(file + '：链接指向不存在的文件 ' + href);
    }

    // 3. 必须是零外部资源（保证离线双击可用）
    for (const [, url] of source.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
        problems.push(file + '：引用了外部资源 ' + url);
    }
}

if (problems.length) {
    console.error('原型自检未通过：');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
}

const overview = readFileSync(join(dir, '00-overview.html'), 'utf8');
const cards = [...overview.matchAll(/href="(\d\d-[^"]+\.html)"/g)].length;

console.log('原型自检：通过');
console.log('  文件 ' + files.length + ' 个（含总览），内联脚本 ' + totalScripts + ' 块全部可编译');
console.log('  总览页收录 ' + cards + ' 款原型，且全部为单文件零外部资源');
