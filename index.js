// ===========================================================================
// 共享数据与页面
// ---------------------------------------------------------------------------
// data/*.json（语音目录与文案）与 src/index.html（整页前端）是网页版（本文件）与
// 桌面版（desktop/）的唯一来源：改语音目录只改 data/voices.json，两边同时生效。
// 页面里的占位标记形如 /*__DATA:键名__*/，由下面的 renderPage() 逐个替换。
// ===========================================================================
import voicesData from './data/voices.json';
import labelsData from './data/labels.json';
import pageTemplate from './src/index.html';

// ===========================================================================
// 出站请求的浏览器标识
// ---------------------------------------------------------------------------
// 取 token 与合成请求都会带上它，值要与当前 Edge 稳定版保持一致，
// 版本对照：https://learn.microsoft.com/deployedge/microsoft-edge-relnote-stable-channel
// 桌面版同一份值在 desktop/src/auth.rs 的 USER_AGENT，
// scripts/check-copy.mjs 会校验两处一致，别只改一边。
// ===========================================================================
const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.4234.32";

const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60;
let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

const VOICE_CATALOG = voicesData.voiceCatalog;
const MULTITALKER_SPEAKERS = voicesData.multitalkerSpeakers;
const MULTITALKER_LOCALE = voicesData.multitalkerLocale;

const STYLE_LABELS = labelsData.styleLabels;
const PARALINGUISTIC_LABELS = labelsData.paralinguisticLabels;
const PARALINGUISTICS = labelsData.paralinguistics;
const HD_STYLES = labelsData.hdStyles;
const HD_OMNI_STYLES = labelsData.hdOmniStyles;
const STYLES_UNKNOWN = labelsData.stylesUnknown;
const TEXT_PLACEHOLDERS = labelsData.textPlaceholders;
const PROMOTION = labelsData.promotion;

// ===========================================================================
// 目录索引与查找（后端据此推导 xml:lang）
// ===========================================================================
// 对话音色（en-/zh-/fr-Multitalker…）会同时挂在多个语言页签下，locale 只跟随自身前缀
const VOICE_INDEX = {};
for (const lang of VOICE_CATALOG) {
    for (const group of lang.groups) {
        for (const v of group.voices) {
            const byId = group.family === 'multitalker'
                ? MULTITALKER_LOCALE[String(v.id).split('-')[0]]
                : null;
            VOICE_INDEX[v.id] = { locale: v.locale || group.locale || byId || lang.locale };
        }
    }
}

// 语音名 → locale；目录外（API 直传未知语音）时按前缀兜底推断
function localeOfVoice(voiceId) {
    const hit = VOICE_INDEX[voiceId];
    if (hit) return hit.locale;
    return String(voiceId).split(':')[0].split('-').slice(0, 2).join('-');
}

// ===========================================================================
// 页面渲染：把 src/index.html 里的占位标记替换成注入数据（冷启动只跑一次）
// ---------------------------------------------------------------------------
// 值统一是「可直接塞进页面的字符串」：对象与数组走 JSON.stringify，
// 文本字段直接写字面量 —— 与原先模板插值的输出完全一致。
// 少任何一个标记都直接抛错，避免静默返回半截页面。
// ===========================================================================
function renderPage() {
    const values = {
        'VOICE_CATALOG': JSON.stringify(VOICE_CATALOG),
        'STYLE_LABELS': JSON.stringify(STYLE_LABELS),
        'PARALINGUISTIC_LABELS': JSON.stringify(PARALINGUISTIC_LABELS),
        'HD_STYLES': JSON.stringify(HD_STYLES),
        'HD_OMNI_STYLES': JSON.stringify(HD_OMNI_STYLES),
        'PARALINGUISTICS': JSON.stringify(PARALINGUISTICS),
        'TEXT_PLACEHOLDERS': JSON.stringify(TEXT_PLACEHOLDERS),
        'MULTITALKER_SPEAKERS': JSON.stringify(MULTITALKER_SPEAKERS),
        'STYLES_UNKNOWN': JSON.stringify(STYLES_UNKNOWN),
        // 运行环境：页面据此决定要不要显示自绘窗口按钮（桌面版才有）
        'RUNTIME': '"web"',
        'PROMOTION': JSON.stringify(PROMOTION),
        'PROMOTION.title': PROMOTION.title,
        'PROMOTION.subtitle': PROMOTION.subtitle,
        'PROMOTION.qrCodeUrl': PROMOTION.qrCodeUrl,
        'PROMOTION.qrCodeAlt': PROMOTION.qrCodeAlt,
        'PROMOTION.name': PROMOTION.name,
        'PROMOTION.description': PROMOTION.description,
        'PROMOTION.benefits': PROMOTION.benefits.map(text => '<li>' + text + '</li>').join('')
    };

    let html = pageTemplate;
    for (const key of Object.keys(values)) {
        const marker = '/*__DATA:' + key + '__*/';
        if (html.indexOf(marker) < 0) throw new Error('页面缺少占位标记：' + key);
        html = html.split(marker).join(values[key]);
    }
    return html;
}

// 页面推迟到首次访问 / 才渲染：模块顶层求值会让只调合成接口的冷启动白付 18 次全量替换
let htmlPage = null;
function pageHtml() {
    if (htmlPage === null) htmlPage = renderPage();
    return htmlPage;
}

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, ctx);
    }
};

async function handleRequest(request, ctx) {
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }




    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // 返回前端页面；顺带预热一次凭据，用户第一次点生成就不必再等拿 token
    if (path === "/" || path === "/index.html") {
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(getEndpoint().catch(() => { }));
        }
        return htmlResponse(pageHtml());
    }

    // 语音转文字：待开发。路由保留为入口，暂不向第三方转发任何请求
    if (path === "/v1/audio/transcriptions") {
        return errorResponse("语音转文字功能开发中，敬请期待", "not_implemented", 501);
    }

    if (path === "/v1/audio/speech") {
        try {
            const contentType = request.headers.get("content-type") || "";
            
            // 处理文件上传
            if (contentType.includes("multipart/form-data")) {
                return await handleFileUpload(request);
            }
            
            // 处理JSON请求（原有功能）
            const requestBody = await request.json();
            const {
                input,
                voice = "zh-CN-XiaoxiaoNeural",
                speed = '1.0',
                volume = '0',
                pitch = '0',
                style = '',
                styledegree,
                // 多人对话：dialogue 为真时 input 是「a: … / b: …」的行格式
                dialogue,
                speakerA = 'emma',
                speakerB = 'andrew',
                optsA,
                optsB,
                outputFormat
            } = requestBody;

            // 听力测试：前端已把整篇文稿解析成时间线，这里逐块合成后按序拼接
            if (requestBody.exam) {
                return await getExamVoice(requestBody);
            }

            if (dialogue) {
                const sa = String(speakerA).toLowerCase();
                const sb = String(speakerB).toLowerCase();
                // 逐行编辑器会直接给结构化 turns；上传 txt 仍走文本解析
                const turns = (Array.isArray(requestBody.turns) && requestBody.turns.length)
                    ? requestBody.turns
                    : parseDialogueTurns(input, sa, sb);
                return await getDialogueVoice(
                    turns,
                    voice,
                    voiceOptsFromParams({ ...(optsA || {}), outputFormat }),
                    voiceOptsFromParams({ ...(optsB || {}), outputFormat }),
                    sa,
                    sb
                );
            }

            // 含停顿 / 副语言芯片的普通语音：片段要么由页面解析好传进来，
            // 要么直接写在这段纯文本里（手打 or 第三方调用），这里解析一遍
            const opts = voiceOptsFromParams({ speed, volume, pitch, style, styledegree, outputFormat });
            const chipSegments = Array.isArray(requestBody.segments) ? requestBody.segments : null;
            const segments = (chipSegments && chipSegments.some(s => s && s.type !== 'text'))
                ? chipSegments
                : parseTextMarks(input);
            if (segments) {
                return await getSegmentedVoice(segments, voice, opts);
            }

            return await getVoice(input, voice, opts);

        } catch (error) {
            console.error("Error:", error);
            return errorResponse(error.message, "edge_tts_error");
        }
    }

    // 默认返回 404
    return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Authorization"
        }
    });
}

// ===========================================================================
// 统一的响应构造：所有路由都从这里出，避免每个分支重复拼 headers
// ===========================================================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...makeCORSHeaders()
        }
    });
}

// 错误响应；参数校验类错误用下面的 invalidRequest 更短
function errorResponse(message, code, status = 500, type = 'api_error', param = null) {
    return jsonResponse({ error: { message, type, param, code } }, status);
}

// 请求参数类错误（默认 400 / param = 'file'）
function invalidRequest(message, code, status = 400, param = 'file') {
    return errorResponse(message, code, status, 'invalid_request_error', param);
}

// 输出格式 → 响应 Content-Type（MP3 / WAV(PCM) / OGG 三种容器）
function audioContentType(outputFormat) {
    const format = String(outputFormat || '');
    if (format.indexOf('ogg-') === 0) return 'audio/ogg';
    if (format.indexOf('webm-') === 0) return 'audio/webm';
    if (format.indexOf('raw-') === 0) return 'audio/wav';
    return 'audio/mpeg';
}

// 音频响应：接受单个 Blob 或多个分片
function audioResponse(chunks, outputFormat) {
    const contentType = audioContentType(outputFormat);
    return new Response(new Blob([].concat(chunks), { type: contentType }), {
        headers: {
            "Content-Type": contentType,
            ...makeCORSHeaders()
        }
    });
}

function htmlResponse(html) {
    return new Response(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...makeCORSHeaders()
        }
    });
}

// 添加延迟函数
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 优化文本分块函数

// 按句切分长文本：中英文标点 + 换行都算句末，标点随句保留（不再补「。」）
function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];

    // 落地当前块；超长时优先在空格处断开，避免把单词切成两半
    const flush = (piece) => {
        const part = piece.trim();
        if (!part) return;
        if (part.length <= maxChunkSize) {
            chunks.push(part);
            return;
        }
        let rest = part;
        while (rest.length > maxChunkSize) {
            let cut = rest.lastIndexOf(' ', maxChunkSize);
            if (cut <= 0) cut = maxChunkSize;
            chunks.push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
        }
        if (rest) chunks.push(rest);
    };

    let current = '';
    for (const piece of String(text || '').match(/[^。！？!?.；;…\n]+[。！？!?.；;…]*|\n+/g) || []) {
        if (!piece.trim()) continue;                             // 纯换行不入块
        if (current.length + piece.length > maxChunkSize) {      // 计入标点，严格不超过上限
            flush(current);
            current = '';
        }
        current += piece;
    }
    flush(current);

    return chunks;
}

// 合成并发度：纯文本 / 芯片片段 / 多人对话三条链路共用
// 429 与 5xx 由 postTtsSsml 内部的退避重试兜底，这里不再人为穿插等待
const TTS_CONCURRENCY = 5;

// 并发执行并按原顺序回填结果（音频拼接顺序必须与分组顺序一致）
async function runPool(items, worker, concurrency = TTS_CONCURRENCY) {
    const results = new Array(items.length);
    let next = 0;

    async function runner() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i], i);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
    return results;
}

// opts = { rate, pitch, volume, style, styledegree, outputFormat }
async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", opts = {}) {
    const { rate, pitch, volume, style, outputFormat } = normalizeVoiceOpts(opts);
    try {
        // 文本预处理
        const cleanText = text.trim();
        if (!cleanText) {
            throw new Error("文本内容为空");
        }
        
        // 如果文本很短，直接处理
        if (cleanText.length <= 1500) {
            return audioResponse(await getAudioChunk(cleanText, voiceName, opts), outputFormat);
        }

        // 优化的文本分块
        const chunks = optimizedTextSplit(cleanText, 1500);

        // 检查分块数量，防止超过CloudFlare限制
        if (chunks.length > 40) {
            throw new Error(`文本过长，分块数量(${chunks.length})超过限制。请缩短文本或分批处理。`);
        }

        console.log(`文本已分为 ${chunks.length} 个块进行处理`);

        // 并发合成各块（已去掉原先批内错开与批间固定等待），再拼接
        return audioResponse(await runPool(chunks, chunk => getAudioChunk(chunk, voiceName, opts)), outputFormat);

    } catch (error) {
        console.error("语音合成失败:", error);
        return errorResponse(
            error.message || String(error),
            "edge_tts_error",
            500,
            "api_error",
            `${voiceName}, ${rate}, ${pitch}, ${volume}, ${style}, ${outputFormat}, ${opts.styledegree}`
        );
    }
}



//获取单个音频数据（增强错误处理和重试机制）
async function getAudioChunk(text, voiceName, opts, maxRetries = 3) {
    const { outputFormat } = normalizeVoiceOpts(opts);

    // 处理文本中的延迟标记
    let m = text.match(/\[(\d+)\]\s*?$/);
    let slien = 0;
    if (m && m.length == 2) {
        slien = parseInt(m[1]);
        text = text.replace(m[0], '');
    }

    // 验证文本长度
    if (!text.trim()) {
        throw new Error("文本块为空");
    }

    if (text.length > 2000) {
        throw new Error("文本块过长: " + text.length + " 字符，最大支持2000字符");
    }

    return await postTtsSsml(getSsml(text, voiceName, opts, slien), outputFormat, maxRetries);
}

// 把 SSML 发到 Edge TTS 端点并取回音频，带重试（普通语音与多人对话共用）
async function postTtsSsml(ssml, outputFormat, maxRetries = 3) {
    const retryDelay = 500; // 重试延迟500ms

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            const url = "https://" + endpoint.r + ".tts.speech.microsoft.com/cognitiveservices/v1";

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": EDGE_UA,
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: ssml
            });

            if (!response.ok) {
                const errorText = await response.text();

                // 根据错误类型决定是否重试
                if (response.status === 429) {
                    // 频率限制，需要重试
                    if (attempt < maxRetries) {
                        console.log("频率限制，第" + (attempt + 1) + "次重试，等待" + (retryDelay * (attempt + 1)) + "ms");
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error("请求频率过高，已重试" + maxRetries + "次仍失败");
                } else if (response.status >= 500) {
                    // 服务器错误，可以重试
                    if (attempt < maxRetries) {
                        console.log("服务器错误，第" + (attempt + 1) + "次重试，等待" + (retryDelay * (attempt + 1)) + "ms");
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error("Edge TTS服务器错误: " + response.status + " " + errorText);
                } else {
                    // 客户端错误，不重试
                    throw new Error("Edge TTS API错误: " + response.status + " " + errorText);
                }
            }

            return await response.blob();

        } catch (error) {
            if (attempt === maxRetries) {
                // 最后一次重试失败
                throw new Error("音频生成失败（已重试" + maxRetries + "次）: " + error.message);
            }

            // 如果是网络错误或其他可重试错误
            if (error.message.indexOf('fetch') >= 0 || error.message.indexOf('network') >= 0) {
                console.log("网络错误，第" + (attempt + 1) + "次重试，等待" + (retryDelay * (attempt + 1)) + "ms");
                await delay(retryDelay * (attempt + 1));
                continue;
            }

            // 其他错误直接抛出
            throw error;
        }
    }
}

// XML文本转义函数
function escapeXmlText(text) {
    return text
        .replace(/&/g, '&amp;')   // 必须首先处理 &
        .replace(/</g, '&lt;')    // 处理 <
        .replace(/>/g, '&gt;')    // 处理 >
        .replace(/"/g, '&quot;')  // 处理 "
        .replace(/'/g, '&apos;'); // 处理 '
}

// 语音参数默认值与归一化
function normalizeVoiceOpts(opts = {}) {
    return {
        rate: opts.rate || '+0%',
        pitch: opts.pitch || '+0Hz',
        volume: opts.volume || '+0%',
        style: opts.style || '',
        // 官方默认 styledegree 为 1（项目原先写死 2，现改为可配置）
        styledegree: Number(opts.styledegree) || 1,
        outputFormat: opts.outputFormat || 'audio-24khz-96kbitrate-mono-mp3'
    };
}

// 把接口的 speed / volume / pitch 换算成 Edge 需要的 rate / pitch / volume 格式
function voiceOptsFromParams({ speed = '1.0', volume = '0', pitch = '0', style = '', styledegree, outputFormat } = {}) {
    const rate = parseInt(String((parseFloat(speed) - 1.0) * 100));
    const numVolume = parseInt(String(parseFloat(volume) * 100));
    const numPitch = parseInt(pitch);
    // 'general' 不是微软的合法风格值，历史上一直被服务端忽略，这里直接当作「不指定」
    const normalizedStyle = (!style || style === 'general') ? '' : style;
    return {
        rate: rate >= 0 ? `+${rate}%` : `${rate}%`,
        pitch: numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
        volume: numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
        style: normalizedStyle,
        styledegree: Number(styledegree) || 1,
        outputFormat
    };
}

// SSML 信封：普通 / 片段 / 对话三种合成共用
// xml:lang 需与语音所属区域设置一致，否则粤语等会按普通话读音处理
function ssmlEnvelope(voiceName, inner, msttsNs = 'http://www.w3.org/2001/mstts') {
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="${msttsNs}" version="1.0" xml:lang="${localeOfVoice(voiceName)}"> 
                <voice name="${voiceName}"> 
                    ${inner}
                </voice> 
            </speak>`;
}

// 可选 express-as 包装：未指定风格时省略，让服务端直接使用默认中性语音
function withStyle(inner, opts) {
    const { style, styledegree } = normalizeVoiceOpts(opts);
    return style
        ? `<mstts:express-as style="${style}" styledegree="${styledegree}">${inner}</mstts:express-as>`
        : inner;
}

function getSsml(text, voiceName, opts, slien = 0) {
    const { rate, pitch, volume } = normalizeVoiceOpts(opts);
    const tail = slien > 0 ? `<break time="${slien}ms" />` : '';
    const prosody = `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapeXmlText(text)}</prosody> ${tail}`;
    return ssmlEnvelope(voiceName, withStyle(prosody, opts));
}

// ===========================================================================
// 片段（segments）：文本 / 停顿 / 副语言
// ---------------------------------------------------------------------------
// 前端把可编辑区解析成片段数组后提交，这里负责还原成 SSML。
// 停顿输出为 <break>，与 prosody 平级，位置精确到文本中间。
// ===========================================================================

// 片段 → SSML 内容（不含 express-as 包装）
function segmentsToInner(segments, opts) {
    const { rate, pitch, volume } = normalizeVoiceOpts(opts);
    const parts = [];
    let buffer = '';

    const flushText = () => {
        if (!buffer) return;
        parts.push(`<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapeXmlText(buffer)}</prosody>`);
        buffer = '';
    };

    for (const seg of segments || []) {
        if (!seg) continue;
        if (seg.type === 'text') {
            buffer += String(seg.value == null ? '' : seg.value);
        } else if (seg.type === 'para') {
            // 副语言标记是直接写进文本的字面量
            buffer += '[' + String(seg.tag || '').replace(/[^A-Za-z_]/g, '') + ']';
        } else if (seg.type === 'pause') {
            flushText();
            // 官方 SSML 的 break 上限是 20s（实测单条 20000ms 确实产出 20 秒静音）
            const ms = Math.max(0, Math.min(20000, Number(seg.ms) || 0));
            if (ms > 0) parts.push(`<break time="${ms}ms"/>`);
        }
    }
    flushText();
    return parts.join('');
}

// 片段数组 → 单语音 SSML
function getSegmentsSsml(segments, voiceName, opts) {
    return ssmlEnvelope(voiceName, withStyle(segmentsToInner(segments, opts), opts));
}

// 片段长度（停顿不计字符）
function segmentLength(seg) {
    if (!seg) return 0;
    if (seg.type === 'para') return String(seg.tag || '').length + 2;
    if (seg.type === 'text') return String(seg.value || '').length;
    return 0;
}

// ===========================================================================
// 纯文本里的标记：[停顿 2s] / [2s] / [500ms] / [laughter]（手打或上传的 txt）
// ---------------------------------------------------------------------------
// 规则与页面里的解析逐字一致：带单位一律认，不带单位必须带「停顿」字样
//（否则 [1] / [2024] 这类方括号会被当成停顿吞掉）；
// 副语言只在非对话场景解析 —— MultiTalker 不支持，页面里同样是这个门控。
// ===========================================================================
const PAUSE_UNIT_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|s)$/;
const PAUSE_BARE_RE = /^([0-9]+(?:\.[0-9]+)?)$/;
const MARK_RE = /\[([^\]]+)\]/g;

function parsePauseMs(text) {
    const raw = String(text).trim();
    const body = raw.split('停顿').join('').trim();
    const unit = body.match(PAUSE_UNIT_RE);
    if (unit) return Math.round(parseFloat(unit[1]) * (unit[2] === 's' ? 1000 : 1));
    const bare = raw.indexOf('停顿') >= 0 ? body.match(PAUSE_BARE_RE) : null;
    return bare ? Math.round(parseFloat(bare[1])) : 0;
}

// 纯文本 → 片段数组；一处标记都没有时返回 null（调用方照旧走纯文本链路）
function parseTextMarks(text, allowPara = true) {
    const source = String(text == null ? '' : text);
    const out = [];
    let last = 0;
    let m = null;
    MARK_RE.lastIndex = 0;
    while ((m = MARK_RE.exec(source)) !== null) {
        const tag = m[1].trim().toLowerCase();
        let seg = null;
        if (allowPara && PARALINGUISTICS.indexOf(tag) >= 0) seg = { type: 'para', tag };
        else {
            const ms = parsePauseMs(tag);
            if (ms > 0) seg = { type: 'pause', ms };
        }
        if (!seg) continue;
        if (m.index > last) out.push({ type: 'text', value: source.slice(last, m.index) });
        out.push(seg);
        last = m.index + m[0].length;
    }
    if (!out.length) return null;
    if (last < source.length) out.push({ type: 'text', value: source.slice(last) });
    return out;
}

// 按长度阈值分组：元素整体进出，绝不切开（片段 / 对话轮次共用）
function groupByLength(items, lengthOf, maxChars = 1500, maxGroups = 40, label = '内容') {
    const groups = [];
    let current = [];
    let size = 0;
    for (const item of items || []) {
        const len = lengthOf(item);
        if (current.length && size + len > maxChars) {
            groups.push(current);
            current = [];
            size = 0;
        }
        current.push(item);
        size += len;
    }
    if (current.length) groups.push(current);
    if (groups.length > maxGroups) {
        throw new Error(`${label}过长，分块数量(${groups.length})超过限制。请缩短内容或分批处理。`);
    }
    return groups;
}

// 并发合成各组并拼接（分段 / 对话共用；按组顺序回填，保证音频先后正确）
async function synthesizeGroups(groups, ssmlOf, outputFormat) {
    const audioChunks = await runPool(groups, group => postTtsSsml(ssmlOf(group), outputFormat));
    return audioResponse(audioChunks, outputFormat);
}

// 含芯片的普通语音合成：按片段分组 → 逐组请求 → 拼接
async function getSegmentedVoice(segments, voiceName, opts) {
    const groups = groupByLength(segments, segmentLength);
    if (!groups.length) throw new Error('文本内容为空');
    const { outputFormat } = normalizeVoiceOpts(opts);
    return synthesizeGroups(groups, g => getSegmentsSsml(g, voiceName, opts), outputFormat);
}

// ===========================================================================
// 多人对话（MultiTalker）
// ---------------------------------------------------------------------------
// 实测约束：一段对话只有 2 个音色槽位 —— 第 1 个说话人一个音色，其余说话人
// 共用第 2 个音色；同名说话人跨轮音色保持一致。因此界面只提供 A / B 两个角色，
// 避免用户加到第三人却静默退化成第二个音色。
// ===========================================================================

// 把「a: 文本 / b: 文本」的行格式解析成轮次；无前缀的行并入上一句
function parseDialogueTurns(text, speakerA, speakerB) {
    const turns = [];
    let last = 'a';
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^([abAB])\s*[:：]\s*([\s\S]*)$/);
        if (m) {
            last = m[1].toLowerCase();
            const content = m[2].trim();
            if (content) turns.push({ key: last, speaker: last === 'a' ? speakerA : speakerB, text: content });
        } else if (turns.length) {
            turns[turns.length - 1].text += '\n' + line;
        } else {
            turns.push({ key: last, speaker: last === 'a' ? speakerA : speakerB, text: line });
        }
    }
    return turns;
}

// 把一轮统一成 { key, speaker, segments }
// 兼容三种来源：前端逐行编辑（key + segments）、上传 txt（text）、旧调用
function normalizeDialogueTurn(turn, speakerA, speakerB) {
    const key = turn && turn.key === 'b' ? 'b' : 'a';
    const text = String((turn && turn.text) || '');
    // 上传 txt 只有纯文本，顺手把里面的停顿标记解析成片段（对话里不认副语言）
    const segments = (turn && Array.isArray(turn.segments))
        ? turn.segments
        : (parseTextMarks(text, false) || [{ type: 'text', value: text }]);
    const speaker = (turn && turn.speaker) || (key === 'a' ? speakerA : speakerB);
    return { key, speaker, segments };
}

function turnLength(turn) {
    return (turn.segments || []).reduce((n, s) => n + segmentLength(s), 0);
}

// 一组轮次生成一个结构完整的 <mstts:dialog>
// 注意：mstts 命名空间用 https，与官方 MultiTalker 示例保持一致
function getDialogueSsml(turns, voiceName, optsA, optsB) {
    const body = turns.map(t => {
        const opts = t.key === 'a' ? optsA : optsB;
        return `<mstts:turn speaker="${t.speaker}">${withStyle(segmentsToInner(t.segments, opts), opts)}</mstts:turn>`;
    }).join('\n');
    const dialog = '<mstts:dialog>\n                        ' + body + '\n                    </mstts:dialog>';
    return ssmlEnvelope(voiceName, dialog, 'https://www.w3.org/2001/mstts');
}

// 普通模式：一条 speak 里放多个 <voice>，男女各用自己的音色
// 实测两个坑：
//   1. break 写在两个 voice 之间会被判 400，必须写在 voice 内部；
//   2. 写在文本「之后」的 break 会被端点直接吞掉，只有写在文本「之前」才生效。
// 所以上一句末尾的停顿芯片和延迟补偿，都要挪到下一句的开头。
function getMultiVoiceSsml(turns, voiceOf, optsOf, turnGapMs = 0) {
    const raw = Number(turnGapMs);
    const gap = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 0;
    let carry = 0;
    const body = turns.map((turn, i) => {
        const key = turn.key === 'b' ? 'b' : 'a';
        const opts = optsOf[key];
        // 取出本句末尾的停顿芯片，交给下一句开头（最后一句的由块的 pauseAfterMs 负责）
        const segments = (turn.segments || []).slice();
        let tail = 0;
        while (segments.length && segments[segments.length - 1].type === 'pause') {
            const ms = Number(segments.pop().ms);
            if (Number.isFinite(ms)) tail += ms;
        }
        const lead = carry + (i > 0 ? gap : 0);
        carry = tail;
        const brk = lead > 0 ? `<break time="${Math.min(20000, Math.round(lead))}ms"/>` : '';
        return `<voice name="${voiceOf[key]}">${brk}${withStyle(segmentsToInner(segments, opts), opts)}</voice>`;
    }).join('');
    const locale = localeOfVoice(voiceOf.a || voiceOf.b || 'en-US');
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="${locale}">${body}</speak>`;
}

// 多人对话合成：按 turn 分组（不切开轮次）→ 逐组请求 → 拼接音频
async function getDialogueVoice(turns, voiceName, optsA, optsB, speakerA = 'emma', speakerB = 'andrew') {
    const list = (turns || [])
        .map(t => normalizeDialogueTurn(t, speakerA, speakerB))
        .filter(t => t.segments.some(s => segmentLength(s) > 0));
    if (!list.length) throw new Error('对话内容为空，请至少写一句话');

    const groups = groupByLength(list, turnLength, 1500, 40, '对话');
    const { outputFormat } = normalizeVoiceOpts(optsA);
    return synthesizeGroups(groups, g => getDialogueSsml(g, voiceName, optsA, optsB), outputFormat);
}

// ===========================================================================
// 听力测试（exam）：一个音频块一个 SSML，按时间线顺序拼成一整条
// ---------------------------------------------------------------------------
// 微软的 MultiTalker 只有 2 个音色槽位，撑不起「中文播音 + 男声 + 女声 + 独白」
// 四角色，所以前端先把整篇文稿拆成时间线：中文提示走中文单音色、男女对话走
// en-Multitalker、独白走单人 DragonHD，后端各发一次请求再把音频拼起来。
// 长停顿不挂在块里，而是把用到的时长各合成一段纯静音反复复用：省下大量子请求，
// 也绕开了「mstts:dialog 后面能不能挂 break」这个不确定。
// ===========================================================================

// 静音块也需要一个文本，纯标点几乎不发声
const SILENCE_TEXT = '。';
// 静音池固定用这个音色：实测「。」在 MAI / DragonHD 系列下会被读出一个怪声
//（用户听到的「两遍之间的怪声」就是它），而 Xiaoxiao 读「。」是纯静音
const SILENCE_VOICE = 'zh-CN-XiaoxiaoNeural';

// 叮咚提示音：24kHz 单声道 MP3（源见 design/chime/叮咚.mp3，转出件 叮咚-restored.mp3），
// 只做过 0.5L+0.5R 下混与重采样，未做音量/响度/降噪处理；参数与默认输出格式一致，直接内联。
// （网页版与桌面版各存一份，改要一起改）
const CHIME_B64 = 'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAwAAAAAAAAAAAAAAD/86TAAAAAAAAAAAAASW5mbwAAAA8AAABWAABh4AAFCAsOERQXFxodICMmKSksLzI0Nzo6PUBDRklMTE9SVVhbXl5hZGZpbG9vcnV4e36BhISHio2Qk5aWmZueoaSnp6qtsLO2ubm8v8LFyMvLzdDT1tnc3N/i5ejr7u7x9Pf6/f8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAPAAAAAAAAAYeA994OaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/86TEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/86TEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/86TEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/86TEAAAAAAAAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/86TEAACwBAAA4AAAO/2BMQU1FMy4xMDBVVVVVVVVVVUfC9SLKgyCphQRvHAq/FtxoggQML1GiKGRamPIETUyINBsFHzGmRkwRNDLmyIcZAsCYJsUB0hxyHxk55qTBxDxjVYYeMkWBhcWlhzczhRAWY5sHUELgUUMOXFgQOHmCTAqYZNCLDwKBMU8NIrO2fNi1C4IxxwxA8DUzPIiUyClYUKGzLobhQ8DogGFp3kRIBKESxU4LXB5MZAGcNaYY4ZOeaVgdQkb5sjOqBGoWKAYmOCTcuwcvAqky6490Y0eU2Kg5h4GMDwSjIADCiA5yAmR1NRwhgAIGYHI0GIWG3DHOiGcSHGbCNCIwxp/Zz7B0BsaYKGuqZhCEYUVgZvMkMj/86TE/2RzBPAK1vXlGFZQtBQvN+QlXmdKAORT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qqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/86TEAAAAA0gAAAAATEFNRTMuMTAwqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/86TEAAAAA0gAAAAATEFNRTMuMTAwqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/86TEAAAAA0gAAAAATEFNRTMuMTAwqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/86TEAAAAA0gAAAAATEFNRTMuMTAwqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/86TEAAAAA0gAAAAATEFNRTMuMTAwqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=';

let chimeCache = null;
async function chimeBytes() {
    if (chimeCache === null) chimeCache = await base64ToBytes(CHIME_B64);
    return chimeCache;
}

// 用到的停顿时长各合成一次，之后反复复用
async function buildSilencePool(durations, voiceName, opts) {
    const pool = {};
    const unique = [];
    for (const ms of durations) {
        const value = Number(ms);
        if (value > 0 && unique.indexOf(value) < 0) unique.push(value);
    }
    if (!unique.length) return pool;
    const chunks = await runPool(unique, ms => postTtsSsml(getSsml(SILENCE_TEXT, voiceName, opts, ms), opts.outputFormat));
    unique.forEach((ms, i) => { pool[ms] = chunks[i]; });
    return pool;
}

async function getExamVoice(body) {
    const opts = normalizeVoiceOpts({ outputFormat: body.outputFormat });
    const voices = body.voices || {};
    const cnVoice = voices.cn || 'zh-CN-XiaoxiaoNeural';
    // 独白是英文，没指定时不能回落到中文播音音色
    const monoVoice = voices.mono || 'en-US-Andrew:DragonHDLatestNeural';
    const multitalker = body.multitalker || 'en-Multitalker:DragonHDLatestNeural';
    // 普通模式传完整音色 id，目录里大小写不统一，不能用 toLowerCase 洗；只有 mstts 分支要小写说话人名
    const male = String(voices.male || 'andrew');
    const female = String(voices.female || 'ava');
    const optsA = voiceOptsFromParams({ ...(body.optsA || {}), outputFormat: body.outputFormat });
    const optsB = voiceOptsFromParams({ ...(body.optsB || {}), outputFormat: body.outputFormat });
    const optsMono = voiceOptsFromParams({ ...(body.optsMono || {}), outputFormat: body.outputFormat });
    const optsCn = voiceOptsFromParams({ ...(body.optsCn || {}), outputFormat: body.outputFormat });
    const timeline = Array.isArray(body.timeline) ? body.timeline : [];
    if (!timeline.length) throw new Error('听力内容为空，请先粘贴文稿');

    // 句尾的 break 在不少音色（DragonHD / MAI 系列）下会被端点吞掉，
    // 所以每块末尾的停顿芯片一律摘出来，交给静音池在块后拼。
    // 块内两句之间的停顿摘不出来（它们在同一条 SSML 里），只能靠句首 break —— 见 getMultiVoiceSsml
    for (const item of timeline) {
        if (!item) continue;
        const last = item.kind === 'dialogue' ? (item.turns || [])[item.turns.length - 1] : item;
        const segs = (last && last.segments) || [];
        let extra = 0;
        while (segs.length && segs.some(s => segmentLength(s) > 0) && segs[segs.length - 1].type === 'pause') {
            const ms = Number(segs.pop().ms);
            if (Number.isFinite(ms)) extra += ms;
        }
        const prev = Number(item.pauseAfterMs);
        item.pauseAfterMs = (Number.isFinite(prev) ? prev : 0) + extra;
    }

    // 停顿与结尾留白都靠静音片段；结尾按 20s 一片反复拼
    const durations = [];
    const remember = ms => {
        const value = Number(ms);
        if (value > 0 && durations.indexOf(value) < 0) durations.push(value);
    };
    for (const item of timeline) {
        remember(item.gapMs);
        remember(item.pauseAfterMs);
    }
    const tailMs = Number(body.tailMs);
    if (tailMs > 0) remember(20000);
    const silence = await buildSilencePool(durations, SILENCE_VOICE, opts);

    // 逐块合成：一段对话整段进一个 mstts:dialog，中文与独白各一条普通 SSML
    const blocks = await runPool(timeline, item => {
        if (item && item.kind === 'dialogue') {
            const turns = (item.turns || []).map(turn => ({
                key: turn.key === 'b' ? 'b' : 'a',
                speaker: turn.key === 'b' ? female.toLowerCase() : male.toLowerCase(),
                segments: turn.segments || []
            })).filter(turn => turn.segments.some(s => segmentLength(s) > 0));
            if (!turns.length) throw new Error('有一段录音是空的，请检查 M: / W: 行');
            // 普通模式：一条 speak 内多个 voice；原生模式照旧走 mstts:dialog
            if (item.plain) {
                return postTtsSsml(getMultiVoiceSsml(turns, { a: male, b: female }, { a: optsA, b: optsB }, item.turnGapMs), opts.outputFormat);
            }
            return postTtsSsml(getDialogueSsml(turns, multitalker, optsA, optsB), opts.outputFormat);
        }
        const segments = (item && item.segments) || [];
        if (!segments.some(s => segmentLength(s) > 0)) {
            throw new Error('有一段文稿是空的，请检查换行');
        }
        const isMono = item.kind === 'mono';
        const voiceName = isMono ? monoVoice : cnVoice;
        return postTtsSsml(getSegmentsSsml(segments, voiceName, isMono ? optsMono : optsCn), opts.outputFormat);
    });

    // 提示音只在 MP3 输出下插：WAV 拿回来的是裸 PCM，混进 MP3 字节会解不动
    const wantChime = body.chime && String(opts.outputFormat).indexOf('audio-') === 0 && CHIME_B64;
    const chime = wantChime ? await chimeBytes() : null;

    const pieces = [];
    for (let i = 0; i < timeline.length; i++) {
        const item = timeline[i];
        const audio = blocks[i];
        // 连播两遍时提示音只响在第一遍之前
        if (item.chime && chime) pieces.push(chime);
        const rawRepeat = Number(item.repeat);
        const repeat = rawRepeat > 0 ? Math.floor(rawRepeat) : 1;
        for (let round = 1; round <= repeat; round++) {
            pieces.push(audio);
            if (round < repeat && item.gapMs && silence[item.gapMs]) pieces.push(silence[item.gapMs]);
        }
        // 对话尾巴上的停顿（前端从 dialog 里挪出来的）在这里补上
        if (item.pauseAfterMs && silence[item.pauseAfterMs]) pieces.push(silence[item.pauseAfterMs]);
    }
    if (tailMs > 0 && silence[20000]) {
        // 向上取整，与桌面端一致：尾白宁可多给不能少给
        const slices = Math.max(1, Math.ceil(tailMs / 20000));
        for (let n = 0; n < slices; n++) pieces.push(silence[20000]);
    }

    return audioResponse(pieces, opts.outputFormat);
}

async function getEndpoint() {
    const now = Date.now() / 1000;

    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    // 获取新token
    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = uuid();

    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": EDGE_UA,
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0",
                "Accept-Encoding": "gzip"
            }
        });

        if (!response.ok) {
            throw new Error(`获取endpoint失败: ${response.status}`);
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));

        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        return data;

    } catch (error) {
        console.error("获取endpoint失败:", error);
        // 如果有缓存的token，即使过期也尝试使用
        if (tokenInfo.token) {
            console.log("使用过期的缓存token");
            return tokenInfo.endpoint;
        }
        throw error;
    }
}



function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key",
        "Access-Control-Max-Age": "86400"
    };
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
    return formattedDate.toLowerCase();
}

// 处理文件上传的函数
async function handleFileUpload(request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        const voice = formData.get('voice') || 'zh-CN-XiaoxiaoNeural';
        const speed = formData.get('speed') || '1.0';
        const volume = formData.get('volume') || '0';
        const pitch = formData.get('pitch') || '0';
        const style = formData.get('style') || '';
        const outputFormat = formData.get('outputFormat') || '';

        // 验证文件
        if (!file) {
            return invalidRequest("未找到上传的文件", "missing_file");
        }

        // 验证文件类型
        if (!file.type.includes('text/') && !file.name.toLowerCase().endsWith('.txt')) {
            return invalidRequest("不支持的文件类型，请上传txt文件", "invalid_file_type");
        }

        // 验证文件大小（限制为5MB）
        if (file.size > 5 * 1024 * 1024) {
            return invalidRequest("文件大小超过限制（最大5MB）", "file_too_large");
        }

        // 读取文件内容
        const text = await file.text();

        // 验证文本内容
        if (!text.trim()) {
            return invalidRequest("文件内容为空", "empty_file");
        }

        // 文本长度限制（50000字符，与 40 组 × 1500 字的合成上限对齐）
        if (text.length > 50000) {
            return invalidRequest("文本内容过长（最大50000字符）", "text_too_long");
        }

        // 上传的 txt 也可以按 a: / b: 行格式走多人对话
        if (formData.get('dialogue')) {
            const sa = String(formData.get('speakerA') || 'emma').toLowerCase();
            const sb = String(formData.get('speakerB') || 'andrew').toLowerCase();
            const turns = parseDialogueTurns(text, sa, sb);
            return await getDialogueVoice(
                turns,
                voice,
                voiceOptsFromParams({ ...JSON.parse(formData.get('optsA') || '{}'), outputFormat }),
                voiceOptsFromParams({ ...JSON.parse(formData.get('optsB') || '{}'), outputFormat }),
                sa,
                sb
            );
        }

        // 调用TTS服务：txt 里写了停顿 / 副语言标记就按片段合成
        const opts = voiceOptsFromParams({ speed, volume, pitch, style, styledegree: formData.get('styledegree'), outputFormat });
        const marks = parseTextMarks(text);
        return marks
            ? await getSegmentedVoice(marks, voice, opts)
            : await getVoice(text, voice, opts);

    } catch (error) {
        console.error("文件上传处理失败:", error);
        return errorResponse("文件处理失败", "file_processing_error");
    }
}

/* ===== 待开发：语音转文字（恢复时删掉这对注释标记，并把上面的路由改回调用本函数） =====
// 处理语音转录的函数
async function handleAudioTranscription(request) {
    try {
        // 验证请求方法
        if (request.method !== 'POST') {
            return invalidRequest("只支持POST方法", "method_not_allowed", 405, "method");
        }

        const contentType = request.headers.get("content-type") || "";

        // 验证Content-Type
        if (!contentType.includes("multipart/form-data")) {
            return invalidRequest("请求必须使用multipart/form-data格式", "invalid_content_type", 400, "content-type");
        }

        // 解析FormData
        const formData = await request.formData();
        const audioFile = formData.get('file');
        const customToken = formData.get('token');

        // 验证音频文件
        if (!audioFile) {
            return invalidRequest("未找到音频文件", "missing_file");
        }

        // 验证文件大小（限制为10MB）
        if (audioFile.size > 10 * 1024 * 1024) {
            return invalidRequest("音频文件大小不能超过10MB", "file_too_large");
        }

        // 验证音频文件格式
        const allowedTypes = [
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/flac', 'audio/aac',
            'audio/ogg', 'audio/webm', 'audio/amr', 'audio/3gpp'
        ];
        
        const isValidType = allowedTypes.some(type => 
            audioFile.type.includes(type) || 
            audioFile.name.toLowerCase().match(/\.(mp3|wav|m4a|flac|aac|ogg|webm|amr|3gp)$/i)
        );

        if (!isValidType) {
            return invalidRequest("不支持的音频文件格式，请上传mp3、wav、m4a、flac、aac、ogg、webm、amr或3gp格式的文件", "invalid_file_type");
        }

        // TODO: 待开发 —— 在此填入自己的硅基流动 Token（原内置 Token 已移除）
        const token = customToken || '';

        // 构建发送到硅基流动API的FormData
        const apiFormData = new FormData();
        apiFormData.append('file', audioFile);
        apiFormData.append('model', 'FunAudioLLM/SenseVoiceSmall');

        // 发送请求到硅基流动API
        const apiResponse = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: apiFormData
        });

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error('硅基流动API错误:', apiResponse.status, errorText);
            
            let errorMessage = '语音转录服务暂时不可用';
            
            if (apiResponse.status === 401) {
                errorMessage = 'API Token无效，请检查您的配置';
            } else if (apiResponse.status === 429) {
                errorMessage = '请求过于频繁，请稍后再试';
            } else if (apiResponse.status === 413) {
                errorMessage = '音频文件太大，请选择较小的文件';
            }

            return errorResponse(errorMessage, "transcription_api_error", apiResponse.status);
        }

        // 获取转录结果
        const transcriptionResult = await apiResponse.json();

        // 返回转录结果
        return jsonResponse(transcriptionResult);

    } catch (error) {
        console.error("语音转录处理失败:", error);
        return errorResponse("语音转录处理失败", "transcription_processing_error");
    }
}
===== 待开发结束 ===== */

