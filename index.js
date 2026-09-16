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

            // 含停顿 / 副语言芯片的普通语音
            const chipSegments = Array.isArray(requestBody.segments) ? requestBody.segments : null;
            if (chipSegments && chipSegments.some(s => s && s.type !== 'text')) {
                return await getSegmentedVoice(
                    chipSegments,
                    voice,
                    voiceOptsFromParams({ speed, volume, pitch, style, styledegree, outputFormat })
                );
            }

            return await getVoice(input, voice, voiceOptsFromParams({ speed, volume, pitch, style, styledegree, outputFormat }));

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
            const ms = Math.max(0, Math.min(5000, Number(seg.ms) || 0));
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
    const segments = (turn && Array.isArray(turn.segments))
        ? turn.segments
        : [{ type: 'text', value: String((turn && turn.text) || '') }];
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

        // 调用TTS服务
        return await getVoice(
            text,
            voice,
            voiceOptsFromParams({ speed, volume, pitch, style, styledegree: formData.get('styledegree'), outputFormat })
        );

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

