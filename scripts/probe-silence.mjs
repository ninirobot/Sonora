// ===========================================================================
// 静音机制探针（一次性工具，Node ESM，零依赖）
// ---------------------------------------------------------------------------
//   node scripts/probe-silence.mjs            # 全部
//   node scripts/probe-silence.mjs --only=cn  # 只跑 id 含 cn 的用例
//
// 目的：实测「音色轨 × 静音机制」的生效矩阵。结论决定 index.js 与
// desktop/src/ssml.rs 里停顿怎么写，所以先测后改，不靠推理。
//
// 为什么每个机制都要跑两个时长：-exact 类型会「替换」原本的自然静音，
// 拿它和「无静音基线」求差会被自然句尾静音干扰（期望值算不准）。
// 改成比较同一机制 6000ms 与 2000ms 的差值 —— 差值 ≈ 4000 就是生效，
// 差值 ≈ 0 就是整条被端点吞掉，与自然静音无关。
//
// 为什么每个用例还要跑 3 次取中位数：HD / MultiTalker / MAI 这类模型每次
// 生成的语速都不一样，同一 SSML 重发一遍时长能差 ±400ms（第一版只测一次，
// 结果明显自相矛盾），单次测量不足以定性。
//
// 输出：scripts/probe-out/<用例>.wav（裸 PCM 套 WAV 头，可直接双击试听）
//       + 一张对照表，末尾给出「机制 × 音色轨」汇总
//
// 说明：这里刻意用 raw-24khz-16bit-mono-pcm 输出，时长 = 字节数 ÷ 48，
// 避开在 Node 里解析 MP3 帧；签名与取 token 的逻辑从 index.js 抄来，
// 浏览器标识用正则从 index.js 读，不写第二份。
// ===========================================================================
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const OUT_DIR = join(root, 'scripts', 'probe-out');

const EDGE_UA = (/const EDGE_UA = "([^"]+)"/.exec(read('index.js')) || [])[1];
if (!EDGE_UA) throw new Error('index.js 里找不到 EDGE_UA');

// 裸 PCM 参数：24kHz / 16bit / 单声道 → 每秒 48000 字节，即每毫秒 48 字节
const BYTES_PER_MS = 48;
const OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';
const CONCURRENCY = 4;

const crypto = globalThis.crypto || webcrypto;

// ===========================================================================
// 取 token / 发合成请求（逐字对齐 index.js 的 sign / getEndpoint / postTtsSsml）
// ===========================================================================

const b64ToBytes = b64 => new Uint8Array(Buffer.from(b64, 'base64'));
const bytesToB64 = bytes => Buffer.from(bytes).toString('base64');
const uuid = () => crypto.randomUUID().replace(/-/g, '');

function dateFormat() {
    return (new Date()).toUTCString().replace(/GMT/, '').trim() + ' GMT';
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function sign(urlStr) {
    const encodedUrl = encodeURIComponent(urlStr.split('://')[1]);
    const uuidStr = uuid();
    const formattedDate = dateFormat().toLowerCase();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = b64ToBytes('oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==');
    const signature = bytesToB64(await hmacSha256(decode, bytesToSign));
    return `MSTranslatorAndroidApp::${signature}::${formattedDate}::${uuidStr}`;
}

let token = null;

async function getToken() {
    if (token && Date.now() / 1000 < token.exp - 180) return token;
    const endpointUrl = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
            'Accept-Language': 'zh-Hans',
            'X-ClientVersion': '4.0.530a 5fe1dc6c',
            'X-UserId': '0f04d16a175c411e',
            'X-HomeGeographicRegion': 'zh-Hans-CN',
            'X-ClientTraceId': uuid(),
            'X-MT-Signature': await sign(endpointUrl),
            'User-Agent': EDGE_UA,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': '0',
            'Accept-Encoding': 'gzip'
        }
    });
    if (!response.ok) throw new Error('取 token 失败: ' + response.status + ' ' + await response.text());
    const data = await response.json();
    const jwt = JSON.parse(Buffer.from(data.t.split('.')[1], 'base64url').toString('utf8'));
    token = { r: data.r, t: data.t, exp: jwt.exp };
    return token;
}

async function synth(ssml) {
    const { r, t } = await getToken();
    const url = 'https://' + r + '.tts.speech.microsoft.com/cognitiveservices/v1';
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': t,
            'Content-Type': 'application/ssml+xml',
            'User-Agent': EDGE_UA,
            'X-Microsoft-OutputFormat': OUTPUT_FORMAT
        },
        body: ssml
    });
    if (!response.ok) throw new Error(response.status + ' ' + (await response.text()).slice(0, 300));
    return Buffer.from(await response.arrayBuffer());
}

// ===========================================================================
// SSML 构造：与 index.js 的 ssmlEnvelope / getMultiVoiceSsml / getDialogueSsml 同形
// ---------------------------------------------------------------------------
// 装配位置刻意照现在的实现走：结尾标签挂在 prosody「之后」（getSsml 就是
// `</prosody> ${tail}`），开头标签挂在 prosody「之前」。
// ===========================================================================

const NS_SYN = 'http://www.w3.org/2001/10/synthesis';
const NS_MSTTS_HTTP = 'http://www.w3.org/2001/mstts';
const NS_MSTTS_HTTPS = 'https://www.w3.org/2001/mstts';

function prosody(text) {
    return `<prosody rate="+0%" pitch="+0Hz" volume="+0%">${text}</prosody>`;
}

// 官方 HD 支持表把 <prosody> 标成「不支持」，这里换个语速看它到底调不调得动
function prosodyRate(text, rate) {
    return `<prosody rate="${rate}" pitch="+0Hz" volume="+0%">${text}</prosody>`;
}

function speak(locale, inner, ns) {
    return `<speak xmlns="${NS_SYN}" xmlns:mstts="${ns}" version="1.0" xml:lang="${locale}">\n  ${inner}\n</speak>`;
}

// inner 是「放在 voice 内容里的完整片段」
const WRAP = {
    // ns 可覆盖：用来排除「是不是命名空间把静音标签废了」这个可能
    voice: (t, inner) => speak(t.locale, `<voice name="${t.voice}">${inner}</voice>`, t.ns || NS_MSTTS_HTTP),
    plain: (t, innerA, innerB) => speak(t.locale,
        `<voice name="${t.voices[0]}">${innerA}</voice><voice name="${t.voices[1]}">${innerB}</voice>`, NS_MSTTS_HTTP),
    dialog: (t, innerA, innerB) => speak(t.locale,
        `<voice name="${t.voice}"><mstts:dialog><mstts:turn speaker="${t.speakers[0]}">${innerA}</mstts:turn>`
        + `<mstts:turn speaker="${t.speakers[1]}">${innerB}</mstts:turn></mstts:dialog></voice>`, NS_MSTTS_HTTPS)
};

// 多轮轨道的固定第二句：只为了让「结尾静音」后面还有内容，不是测量对象
const SECOND = {
    voice: '',
    plain: prosody('A second line here.'),
    dialog: prosody('A second line here.')
};

// ---------------------------------------------------------------------------
// 音色轨
// ---------------------------------------------------------------------------
const TRACKS = [
    {
        id: 'cn', suite: 'full', kind: 'voice', locale: 'zh-CN',
        voice: 'zh-CN-XiaoxiaoNeural',
        one: '这是一次测试。', mid: ['这是第一次测试。', '这是第二次测试。'],
        // 只跟静音池有关：池子片段就是「Xiaoxiao 读『。』+ 末尾停顿」，
        // 这两组用例量出「。」本身的长度，以及能不能干脆不写文本
        extra: [['silenceBase', 0], ['emptyExact', 2000], ['emptyExact', 6000],
            ['rateFast', 0], ['rateSlow', 0]]
    },
    {
        id: 'mono', suite: 'full', kind: 'voice', locale: 'en-US',
        voice: 'en-US-Andrew:DragonHDLatestNeural',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.'],
        // 官方元素在 HD 上不生效，得先把"是我写错了"这个可能排除掉：
        // 叠加型、绝对型放文本前、句子间叠加型，三种写法都试一遍
        extra: [
            ['tailAdd', 2000], ['tailAdd', 6000],
            ['tailBefore', 2000], ['tailBefore', 6000],
            ['sentAdd', 2000], ['sentAdd', 6000],
            ['rateFast', 0], ['rateSlow', 0]
        ]
    },
    // Dragon HD Omni：官方表说它的 <break> 也「不支持」，这条必须单独验
    {
        id: 'omni', suite: 'lite', kind: 'voice', locale: 'en-US',
        voice: 'en-US-Andrew:DragonHDOmniLatestNeural',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.'],
        extra: [['rateFast', 0], ['rateSlow', 0]]
    },
    // 换了命名空间（https）的同一副 HD 嗓子，排除命名空间这个变量
    {
        id: 'hdhttps', suite: 'lite', kind: 'voice', locale: 'en-US', ns: NS_MSTTS_HTTPS,
        voice: 'en-US-Andrew:DragonHDLatestNeural',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    },
    // 普通英文单音色：单独拎出来，排除「多 voice 拼接」这个干扰变量
    {
        id: 'ava', suite: 'lite', kind: 'voice', locale: 'en-US',
        voice: 'en-US-AvaNeural',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    },
    {
        id: 'dialog', suite: 'full', kind: 'dialog', locale: 'en-US',
        voice: 'en-Multitalker:DragonHDLatestNeural', speakers: ['andrew', 'ava'],
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    },
    {
        id: 'flash', suite: 'lite', kind: 'voice', locale: 'en-US',
        voice: 'en-US-Tyler:DragonHDFlashLatestNeural',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    },
    {
        id: 'mai', suite: 'lite', kind: 'voice', locale: 'en-US',
        voice: 'en-US-Ethan:MAI-Voice-2.1',
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    },
    {
        id: 'plain', suite: 'lite', kind: 'plain', locale: 'en-US',
        voices: ['en-US-AndrewNeural', 'en-US-AvaNeural'],
        one: 'This is a test.', mid: ['This is the first test.', 'This is the second test.']
    }
];

// ---------------------------------------------------------------------------
// 用例：kind × 时长。base / midBase / twoBase 是不带静音的基线
// ---------------------------------------------------------------------------
// 每个机制都取两个时长（-exact 会替换自然静音，只能靠差值判定，见文件头）
// 档位差刻意取 4000ms：HD / MultiTalker 每次生成的语速都不一样，实测同一用例
// 的抖动能到 ±400ms，2000ms 的档位差会被噪声吃掉，4000 才稳。
const SUITES = {
    full: [
        ['base', 0],
        ['tailBreak', 2000], ['tailBreak', 6000],
        ['headBreak', 2000], ['headBreak', 6000],
        ['tailExact', 2000], ['tailExact', 6000],
        ['lastBreak', 2000], ['lastBreak', 6000],
        ['leadExact', 2000], ['leadExact', 6000],
        ['midBase', 0], ['midBreak', 3000],
        ['twoBase', 0],
        ['sentExact', 2000], ['sentExact', 6000]
    ],
    // lite：多撒的几个音色轨只测「停顿的三种位置 + 句中」，够定性即可
    lite: [
        ['base', 0],
        ['tailBreak', 2000], ['tailBreak', 6000],
        ['tailExact', 2000], ['tailExact', 6000],
        ['lastBreak', 2000], ['lastBreak', 6000],
        ['midBase', 0], ['midBreak', 3000]
    ]
};

const tag = (type, ms) => `<mstts:silence type="${type}" value="${ms}ms"/>`;

// 句中停顿：与 segmentsToInner 一致 —— break 是 prosody 的「兄弟」，不写在 prosody 里
function midText(track, fragment) {
    return prosody(track.mid[0]) + fragment + prosody(track.mid[1]);
}

// 返回 { a, b } 两段内容，a 是第一段（测量对象），b 是固定第二段
function buildInner(track, kind, ms) {
    const second = SECOND[track.kind];
    const first = track.mid[0] + track.mid[1];
    switch (kind) {
        case 'base':
            return { a: prosody(track.one), b: second };
        case 'twoBase':
            return { a: prosody(first), b: second };
        case 'midBase':
            return { a: midText(track, ''), b: second };
        case 'tailBreak':
            return { a: prosody(track.one) + `<break time="${ms}ms"/>`, b: second };
        case 'tailExact':
            return { a: prosody(track.one) + tag('Tailing-exact', ms), b: second };
        // 停顿落在块的「最开头」：与末尾相对照
        case 'headBreak':
            return { a: `<break time="${ms}ms"/>` + prosody(track.one), b: second };
        // 叠加型（不带 -exact）：在自然静音之上「再加」，与绝对型对照
        case 'tailAdd':
            return { a: prosody(track.one) + tag('Tailing', ms), b: second };
        case 'sentAdd':
            return { a: tag('Sentenceboundary', ms) + prosody(first), b: second };
        // 静音标签改放到「文本之前」：官方示例就是这么摆的，排除位置影响
        case 'tailBefore':
            return { a: tag('Tailing-exact', ms) + prosody(track.one), b: second };
        // 语速对照：官方 HD 表说 <prosody> 不支持，快慢两档一比就知道
        case 'rateFast':
            return { a: prosodyRate(track.one, '+50%'), b: second };
        case 'rateSlow':
            return { a: prosodyRate(track.one, '-50%'), b: second };
        // 静音池片段的底噪：池子就是「Xiaoxiao 读『。』」，这里量一下「。」本身多长
        case 'silenceBase':
            return { a: prosody('。'), b: '' };
        // voice 里只放静音标签、不带任何文本：能省掉「。」就靠它
        case 'emptyExact':
            return { a: tag('Tailing-exact', ms), b: '' };
        // 停顿时芯片挂在「最后一个内容单元」之后 —— 落在整条音频的最末尾
        case 'lastBreak':
            return { a: prosody(track.one), b: second + `<break time="${ms}ms"/>` };
        case 'leadExact':
            return { a: tag('Leading-exact', ms) + prosody(track.one), b: second };
        case 'midBreak':
            return { a: midText(track, `<break time="${ms}ms"/>`), b: second };
        case 'sentExact':
            return { a: tag('Sentenceboundary-exact', ms) + prosody(first), b: second };
        default:
            throw new Error('未知用例: ' + kind);
    }
}

function buildSsml(track, kind, ms) {
    const { a, b } = buildInner(track, kind, ms);
    return WRAP[track.kind](track, a, b);
}

// ===========================================================================
// 跑
// ===========================================================================

const only = (process.argv.find(arg => arg.startsWith('--only=')) || '').slice(7);

// 每个用例跑 REPS 次、取中位数：这类模型每次生成的语速都不同，单次测量不可信
const REPS = 3;

const jobs = [];
for (const track of TRACKS) {
    for (const [kind, ms] of [...SUITES[track.suite], ...(track.extra || [])]) {
        // 单 voice 轨道的 tailBreak 本来就落在音频末尾，lastBreak 是同一件事，别发两遍
        if (kind === 'lastBreak' && track.kind === 'voice') continue;
        const key = track.id + '/' + kind + (ms ? ':' + ms : '');
        if (only && key.indexOf(only) < 0) continue;
        const ssml = buildSsml(track, kind, ms);
        for (let rep = 1; rep <= REPS; rep++) jobs.push({ key, rep, track, ssml });
    }
}

if (!jobs.length) throw new Error('没有匹配的用例');

// 只看 SSML 长什么样（不发请求）
if (process.argv.includes('--dry')) {
    for (const job of jobs) console.log(`\n--- ${job.id} ---\n${job.ssml}`);
    process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

async function runPool(items, worker, size) {
    const out = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return out;
}

const caseCount = new Set(jobs.map(job => job.key)).size;
console.log(`静音探针：${caseCount} 个用例 × ${REPS} 次 = ${jobs.length} 个请求，并发 ${CONCURRENCY}，输出 ${OUTPUT_FORMAT}`);
console.log(`音频落盘：${join('scripts', 'probe-out')}（每用例存一次）\n`);

const raw = await runPool(jobs, async job => {
    try {
        const pcm = await synth(job.ssml);
        if (job.rep === 1) writeFileSync(join(OUT_DIR, job.key.replace(/[/:]/g, '_') + '.wav'), wavWrap(pcm));
        return { key: job.key, ms: Math.round(pcm.length / BYTES_PER_MS), error: null };
    } catch (error) {
        return { key: job.key, ms: null, error: error.message };
    }
}, CONCURRENCY);

// ---------------------------------------------------------------------------
// 用例 → 中位数（同时留一份极差，噪声大的用例一眼可见）
// ---------------------------------------------------------------------------
const samples = new Map();
for (const item of raw) {
    if (!samples.has(item.key)) samples.set(item.key, { track: item.key.split('/')[0], ok: [], errors: [] });
    const bucket = samples.get(item.key);
    if (item.error) bucket.errors.push(item.error);
    else bucket.ok.push(item.ms);
}

const median = list => {
    const sorted = [...list].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const durations = key => {
    const hit = samples.get(key);
    return hit && hit.ok.length ? median(hit.ok) : null;
};
const spread = key => {
    const hit = samples.get(key);
    if (!hit || hit.ok.length < 2) return '';
    const sorted = [...hit.ok].sort((a, b) => a - b);
    return `（${sorted[0]}~${sorted[sorted.length - 1]}）`;
};

console.log('用例中位数：');
for (const [key, bucket] of samples) {
    if (!bucket.ok.length) {
        console.log(`  ${key.padEnd(24)}   FAIL   ${bucket.errors[0]}`);
    } else {
        console.log(`  ${key.padEnd(24)} ${String(median(bucket.ok)).padStart(6)} ms ${spread(key)}`);
    }
}

// 差值判定：同一机制两个时长的差，与实际档位差比
// 容差 500ms：档位差是 4000 / 3000，容差只用来吸收中位数本身的抖动
const TOLERANCE = 500;
const VERDICT = (delta, expect) => {
    if (delta == null) return '（缺数据）';
    if (Math.abs(delta - expect) <= TOLERANCE) return '✅ 生效';
    if (Math.abs(delta) <= TOLERANCE) return '❌ 被吞';
    return '⚠️ 偏差 ' + (delta > 0 ? '+' : '') + Math.round(delta) + 'ms';
};

const pairs = [
    { label: '句尾 break（现有写法）', from: 'tailBreak:2000', to: 'tailBreak:6000', expect: 4000 },
    { label: '块开头 break', from: 'headBreak:2000', to: 'headBreak:6000', expect: 4000 },
    { label: '音频最末尾 break', from: 'lastBreak:2000', to: 'lastBreak:6000', expect: 4000 },
    { label: 'Tailing-exact（目标写法）', from: 'tailExact:2000', to: 'tailExact:6000', expect: 4000 },
    { label: 'Tailing（叠加型）', from: 'tailAdd:2000', to: 'tailAdd:6000', expect: 4000 },
    { label: 'Tailing-exact 放文本前', from: 'tailBefore:2000', to: 'tailBefore:6000', expect: 4000 },
    { label: 'Sentenceboundary（叠加型）', from: 'sentAdd:2000', to: 'sentAdd:6000', expect: 4000 },
    { label: 'Leading-exact', from: 'leadExact:2000', to: 'leadExact:6000', expect: 4000 },
    { label: 'Sentenceboundary-exact', from: 'sentExact:2000', to: 'sentExact:6000', expect: 4000 },
    { label: '句中 break', from: 'midBase', to: 'midBreak:3000', expect: 3000 }
];

console.log('\n================ 判定（比较同一机制两个时长的差值）================');
const summary = [];
for (const track of TRACKS) {
    if (![...samples.keys()].some(key => key.startsWith(track.id + '/'))) continue;
    console.log(`\n[${track.id}] ${track.voice || track.voices.join(' + ')}  基线 ${durations(track.id + '/base') ?? '—'} ms`);
    const row = { track: track.id };
    for (const pair of pairs) {
        const from = durations(track.id + '/' + pair.from);
        const to = durations(track.id + '/' + pair.to);
        if (from == null || to == null) continue;
        const delta = to - from;
        row[pair.label] = delta;
        console.log(`  ${pair.label.padEnd(24)} Δ ${String(delta).padStart(6)} ms（期望 ${pair.expect}）  ${VERDICT(delta, pair.expect)}`);
    }
    summary.push(row);
}

// ---------------------------------------------------------------------------
// 汇总：每个机制在哪些轨道上成立
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 附加读数：prosody 到底调不调得动语速（官方 HD 表把 <prosody> 标成「不支持」）
// ---------------------------------------------------------------------------
console.log('\n================ 语速对照（慢 −50% 应比快 +50% 明显更长）================');
const RATE_PROBES = TRACKS.filter(track => [...samples.keys()].some(key => key === track.id + '/rateFast'));
for (const track of RATE_PROBES) {
    const fast = durations(track.id + '/rateFast');
    const slow = durations(track.id + '/rateSlow');
    if (fast == null || slow == null) continue;
    const delta = slow - fast;
    console.log(`  ${track.id.padEnd(8)} 快 ${String(fast).padStart(5)}ms / 慢 ${String(slow).padStart(5)}ms  差 ${String(delta).padStart(5)}ms  `
        + (delta > 300 ? '✅ prosody 生效' : '❌ prosody 被忽略'));
}

console.log('\n================ 汇总 ================');
for (const pair of pairs) {
    const ok = summary.filter(row => row[pair.label] != null && Math.abs(row[pair.label] - pair.expect) <= 150).map(row => row.track);
    const dead = summary.filter(row => row[pair.label] != null && Math.abs(row[pair.label]) <= 150).map(row => row.track);
    const tested = summary.filter(row => row[pair.label] != null).map(row => row.track);
    console.log(`${pair.label}：生效 [${ok.join(' ')}]  被吞 [${dead.join(' ')}]  未测 [${[...new Set(TRACKS.map(t => t.id))].filter(id => tested.indexOf(id) < 0).join(' ')}]`);
}

const failed = raw.filter(item => item.error);
console.log(`\n失败 ${failed.length} / ${raw.length}`);
for (const item of failed) console.log(`  ${item.key}: ${item.error}`);

// ---------------------------------------------------------------------------
// 裸 PCM 套 WAV 头，方便双击试听（也不影响手工量时长）
// ---------------------------------------------------------------------------
function wavWrap(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(24000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
