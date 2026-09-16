// 语音规模统计：从 data/voices.json 现算，写出 README 里的受管清单区。
//
//   node scripts/gen-voice-stats.mjs          # 重写 README 的清单区
//   node scripts/gen-voice-stats.mjs --check  # 只校验，不一致就非零退出
//
// 为什么需要它：宣传文案里的数字一旦靠手写就会漂移（旧文案还停在「20+ 种语音」，
// 实际早就是三百多个）。这里把「统计口径」和「写入」放在同一个文件，
// scripts/check-copy.mjs 再复用同一份结果，保证文档与页面永远对得上。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

export const START_MARK = '<!-- VOICE_STATS:START -->';
export const END_MARK = '<!-- VOICE_STATS:END -->';

// 家族的书名号写法，用来把 family 键翻译成人话
const FAMILY_LABELS = {
    standard: '标准',
    multilingual: '多语言',
    dragonHD: 'Neural-HD',
    dragonHDOmni: 'Neural-HD-Omni',
    dragonHDFlash: 'Neural-HD-Flash',
    maiVoice2: 'MAI-Voice-2',
    dialect: '方言',
    multitalker: '多人语音'
};

const FAMILY_NOTES = {
    standard: '经典 Neural 语音，风格按语音逐条列',
    multilingual: 'MultilingualNeural，一副嗓子说多国语言',
    dragonHD: 'LLM 驱动的 HD 语音，共用 62 项模型级风格表',
    dragonHDOmni: 'HD 的 Omni 版本，风格 61 项（不含 whispering）',
    dragonHDFlash: 'HD 的低延迟版本，仅中文与英文',
    maiVoice2: '另一套 HD 语音，含 ·Flash 低延迟变体',
    dialect: '中文方言、吴语与台湾国语',
    multitalker: '按轮次合成对话，同一批模型挂在多个语言页签下'
};

// 家族展示顺序：先按上面这张表的声明顺序，未登记的家族排到最后
const FAMILY_ORDER = Object.keys(FAMILY_LABELS);

/// 统计语音规模。所有数字都来自 data/voices.json，不写死任何常量。
export function voiceStats() {
    const catalog = JSON.parse(read('data/voices.json')).voiceCatalog;

    const languages = [];
    const accents = [];
    const families = {};
    const ids = new Set();
    const multitalkerModels = new Set();
    let entries = 0;

    for (const accent of catalog) {
        accents.push(accent);
        if (!languages.some(item => item.lang === accent.lang)) {
            languages.push({ lang: accent.lang, langLabel: accent.langLabel, accents: 0 });
        }
        languages.find(item => item.lang === accent.lang).accents += 1;
        for (const group of accent.groups) {
            families[group.family] = (families[group.family] || 0) + group.voices.length;
            for (const voice of group.voices) {
                entries += 1;
                ids.add(voice.id);
                if (group.family === 'multitalker') {
                    multitalkerModels.add(String(voice.id).split('-')[0]);
                }
            }
        }
    }

    const familyList = Object.keys(families)
        .sort((a, b) => {
            const rank = key => (FAMILY_ORDER.indexOf(key) + 1 || FAMILY_ORDER.length + 1);
            return rank(a) - rank(b);
        })
        .map(family => ({ family, label: FAMILY_LABELS[family] || family, count: families[family] }));

    return {
        languages,
        accents,
        entries,
        uniqueIds: ids.size,
        families: familyList,
        familyCount: familyList.length,
        multitalkerModels: multitalkerModels.size
    };
}

/// 生成 README 清单区的正文（不含首尾标记）
export function voiceStatsBlock(stats) {
    const lines = [];
    lines.push('> 本节由 `node scripts/gen-voice-stats.mjs` 从 `data/voices.json` 现算并写入，**不要手改**；');
    lines.push('> 改完语音目录跑一次脚本即可。`node scripts/check-copy.mjs` 会校验文档与页面里的数字是否还对得上。');
    lines.push('');
    lines.push('| 指标 | 数值 |');
    lines.push('| --- | --- |');
    lines.push(`| 语言 | ${stats.languages.length} |`);
    lines.push(`| 口音 | ${stats.accents.length} |`);
    lines.push(`| 语音条目 | ${stats.entries} |`);
    lines.push(`| 去重语音 id | ${stats.uniqueIds} |`);
    lines.push(`| 音色家族 | ${stats.familyCount} |`);
    lines.push(`| 多人对话模型 | ${stats.multitalkerModels} |`);
    lines.push('');
    lines.push('「语音条目」按下拉里的条数算：同一副嗓子在多个语言页签下各占一条，所以比去重 id 多。');
    lines.push(`多人对话是 ${stats.multitalkerModels} 个模型（\`en-\` / \`zh-\` / \`fr-Multitalker\`）挂在多个语言页签下，共 ${stats.families.find(item => item.family === 'multitalker').count} 个入口。`);
    lines.push('');
    lines.push('**家族分布**（按语音条目计）');
    lines.push('');
    lines.push('| 家族 | 数量 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const family of stats.families) {
        lines.push(`| ${family.label} | ${family.count} | ${FAMILY_NOTES[family.family] || ''} |`);
    }
    lines.push('');
    lines.push('**完整清单**（语言 → 口音 → 分组 → 语音）');
    lines.push('');
    for (const language of stats.languages) {
        lines.push(`<details><summary><b>${language.langLabel} ${language.lang}（${language.accents} 个口音）</b></summary>`);
        lines.push('');
        for (const accent of stats.accents.filter(item => item.lang === language.lang)) {
            lines.push(`#### ${accent.langLabel} · ${accent.tabLabel}（\`${accent.locale}\`）`);
            lines.push('');
            lines.push('| 分组 | 数量 | 语音 |');
            lines.push('| --- | --- | --- |');
            for (const group of accent.groups) {
                const names = group.voices.map(voice => voice.name).join('、');
                lines.push(`| ${group.label} | ${group.voices.length} | ${names} |`);
            }
            lines.push('');
        }
        lines.push('</details>');
        lines.push('');
    }
    return lines.join('\n').replace(/\n+$/, '');
}

/// 把清单区写进 README，只动两个标记之间的内容
export function writeVoiceStats(stats) {
    const file = join(root, 'README.md');
    const readme = readFileSync(file, 'utf8');
    const start = readme.indexOf(START_MARK);
    const end = readme.indexOf(END_MARK);
    if (start < 0 || end < 0) {
        throw new Error('README.md 缺少 ' + START_MARK + ' / ' + END_MARK + ' 标记');
    }
    const next = readme.slice(0, start + START_MARK.length)
        + '\n' + voiceStatsBlock(stats) + '\n'
        + readme.slice(end);
    writeFileSync(file, next, 'utf8');
    return next !== readme;
}

// 直接执行时才跑命令行逻辑，被 import 时只提供函数
if (process.argv[1] && process.argv[1].endsWith('gen-voice-stats.mjs')) {
    const stats = voiceStats();
    if (process.argv.includes('--check')) {
        const current = read('README.md');
        const start = current.indexOf(START_MARK);
        const end = current.indexOf(END_MARK);
        if (start < 0 || end < 0) throw new Error('README.md 缺少清单区标记');
        const actual = current.slice(start + START_MARK.length, end).trim();
        if (actual !== voiceStatsBlock(stats)) {
            throw new Error('README 的语音清单区与 data/voices.json 不一致，请跑一次 node scripts/gen-voice-stats.mjs');
        }
        console.log('语音清单：与 data/voices.json 一致');
    } else {
        const changed = writeVoiceStats(stats);
        console.log('语音规模：' + stats.languages.length + ' 种语言 / ' + stats.accents.length
            + ' 个口音 / ' + stats.entries + ' 条语音 / 去重 ' + stats.uniqueIds + ' 个 id');
        console.log(changed ? 'README 清单区已更新' : 'README 清单区无变化');
    }
}
