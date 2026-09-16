# ![Sonora](desktop/icons/icon.svg) Sonora · 声界

把文字读出来。

Sonora 是一台语音工作台，合成走微软 Edge TTS。**9 种语言、23 个口音、300+ 副嗓音**，一个窗口里调完就能导出。（语音转文字**还在开发中**，入口会先占个位。）

两种形态共用同一套界面和语音目录：

- **网页版** —— 一个 Cloudflare Worker 文件，部署完就有网址。
- **Windows 桌面版** —— 一个 exe，双击即用，不用自己部署服务。

两边都顺带开着 **OpenAI 风格的接口**（`POST /v1/audio/speech`），自己的脚本也能直接调。

---

## 能做什么

**文本转语音**

三种输入：**单人文本 / A/B 多人对话 / 上传 txt**。正文里可以插**停顿**（0–5 秒可调）和**副语言**（笑声、咳嗽、换气、叹气等），从别处粘贴带 `[停顿 2s]`、`[laughter]` 这类标记的文本会自动还原成可编辑的芯片。**语速、音调、风格、风格强度**都能调，输出支持 **MP3 / WAV / OGG**。长文按句切分再拼回一段音频，生成后可试听或导出。

**语音转文字（开发中）**

左侧的「转录」入口保留着，点进去是一句「功能开发中，敬请期待」。上传音频拿到文本、结果复制编辑、一键送进合成这些都会在后续版本里补上，接口 `POST /v1/audio/transcriptions` 现在返回 501。

**界面**

左边一列切换「语音合成 / 语音转文字 / 设置」，右边是参数面板，底部状态栏显示运行方式与当前格式。界面有 **8 种语言**，首次打开按浏览器语言自动选。

---

## 快速开始

### 网页版

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ninirobot/Sonora)

或者手动部署：

```bash
npm install -g wrangler
wrangler login
wrangler deploy        # 输出的 *.workers.dev 域名即可访问，不用配任何密钥
```

本地调试用 `wrangler dev`，默认 http://localhost:8787 。

### Windows 桌面版

环境装一次就够：[Rust](https://rustup.rs)、Visual Studio 生成工具（勾选「使用 C++ 的桌面开发」），然后：

```powershell
cargo install tauri-cli --version "^2" --locked
cd desktop
.\build.ps1            # 调试运行用 .\build.ps1 -Dev
```

产物是 `desktop\target\release\sonora.exe`，**单个文件约 3.9MB，双击即用**，不写注册表，直接拷给别人就能跑。

> 桌面版只是省掉了「自己部署一个服务」，**合成仍然需要联网**。

---

## 怎么用

1. **顶部选语言**，需要时再选口音，两者决定右边的嗓音列表。
2. **输入或粘贴文本**；要停顿、笑声就在光标处插入。
3. **右边选嗓音**，调语速、音调、风格，点生成，试听或导出。

**多人对话模式**下，每行开头写 `A:` / `B:` 指定说话人，两个角色可以各配一个嗓音和语速。

左侧的「转录」是语音转文字的入口，目前点进去只有一句「功能开发中，敬请期待」，功能做好之前不用管它。

---

## 语音规模

下面这份清单由 `node scripts/gen-voice-stats.mjs` 从 `data/voices.json` 现算生成，改完语音目录跑一次脚本就会重写。

<!-- VOICE_STATS:START -->
> 本节由 `node scripts/gen-voice-stats.mjs` 从 `data/voices.json` 现算并写入，**不要手改**；
> 改完语音目录跑一次脚本即可。`node scripts/check-copy.mjs` 会校验文档与页面里的数字是否还对得上。

| 指标 | 数值 |
| --- | --- |
| 语言 | 9 |
| 口音 | 23 |
| 语音条目 | 386 |
| 去重语音 id | 379 |
| 音色家族 | 8 |
| 多人对话模型 | 3 |

「语音条目」按下拉里的条数算：同一副嗓子在多个语言页签下各占一条，所以比去重 id 多。
多人对话是 3 个模型（`en-` / `zh-` / `fr-Multitalker`）挂在多个语言页签下，共 10 个入口。

**家族分布**（按语音条目计）

| 家族 | 数量 | 说明 |
| --- | --- | --- |
| 标准 | 186 | 经典 Neural 语音，风格按语音逐条列 |
| 多语言 | 51 | MultilingualNeural，一副嗓子说多国语言 |
| Neural-HD | 52 | LLM 驱动的 HD 语音，共用 62 项模型级风格表 |
| Neural-HD-Omni | 15 | HD 的 Omni 版本，风格 61 项（不含 whispering） |
| Neural-HD-Flash | 18 | HD 的低延迟版本，仅中文与英文 |
| MAI-Voice-2 | 42 | 另一套 HD 语音，含 ·Flash 低延迟变体 |
| 方言 | 12 | 中文方言、吴语与台湾国语 |
| 多人语音 | 10 | 按轮次合成对话，同一批模型挂在多个语言页签下 |

**完整清单**（语言 → 口音 → 分组 → 语音）

<details><summary><b>中文 zh（2 个口音）</b></summary>

#### 中文 · 普通话（`zh-CN`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 24 | 晓晓、云希、云扬、晓伊、云健、晓辰、晓涵、晓梦、晓墨、晓秋、晓柔、晓睿、晓双、晓萱、晓颜、晓悠、晓甄、云枫、云皓、云杰、云夏、云野、云泽、晓晓·方言 |
| 多语言 | 8 | 晓晓、晓辰、晓双、晓悠、晓雨、云帆、云霄、云逸 |
| Neural-HD | 2 | 晓辰、云帆 |
| Neural-HD-Omni | 3 | 晓月、云琪、Maroonallegro |
| Neural-HD-Flash | 15 | 晓晓、晓晓2、晓辰、晓伊、晓雨、晓涵、晓可、晓双、晓悠、云希、云逸、云霄、云汉、云夏、云野 |
| MAI-Voice-2 | 8 | Bo、Bo·Flash、Mei、Mei·Flash、Wei、Wei·Flash、Lan、Lan·Flash |
| 多人语音 | 2 | 英文对话、中文对话 |

#### 中文 · 方言（`zh-CN`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 地方方言 | 7 | 云琪·广西、云登·河南、晓北·辽宁、云彪·辽宁、晓妮·陕西、云翔·山东、云希·四川 |
| 吴语 | 2 | 晓彤、云哲 |
| 台湾国语 | 3 | 晓臻、云杰、晓雨 |

</details>

<details><summary><b>粤语 yue（1 个口音）</b></summary>

#### 粤语 · 粤语（`zh-HK`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 粤语·繁体（香港） | 3 | 晓曼、晓佳、云龙 |
| 粤语·简体（广东） | 2 | 晓敏、云松 |

</details>

<details><summary><b>English en（14 个口音）</b></summary>

#### English · US（`en-US`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 31 | Aria、Jenny、Guy、Davis、Jane、Jason、Sara、Tony、Nancy、Ava、Kai、Luna、Andrew、Emma、Brian、Amber、Ana、Ashley、Brandon、Christopher、Cora、Elizabeth、Eric、Jacob、Michelle、Monica、Roger、Steffan、AIGenerate1、AIGenerate2、Blue |
| 多语言 | 29 | Andrew、Phoebe、Davis、Derek、Nancy、Serena、Ava、Amanda、Adam、Emma、Brian、Cora、Christopher、Brandon、Dustin、Evelyn、Jenny、Lewis、Lola、Ryan、Samuel、Steffan、Alloy Turbo、Echo Turbo、Fable Turbo、Onyx Turbo、Nova Turbo、Shimmer Turbo、Ash Turbo |
| Neural-HD | 30 | Ava、Andrew、Adam、Alloy、Aria、Bree、Brian、Davis、Emma、Emma2、Jane、Jenny、Nova、Phoebe、Serena、Steffan、Andrew2、Andrew3、Ava3、Evelyn、Jimmie、Juno、Mila、Tessa、Tiana、Tyler、Vance、Andrew-Preview、Ava-Preview、Serena-Preview |
| Neural-HD-Omni | 10 | Andrew、Caleb、Dana、Lewis、Phoebe、Ava、Emma、Blushzephyr、Goldenspark、Jelly |
| Neural-HD-Flash | 3 | Jimmie、Tiana、Tyler |
| MAI-Voice-2 | 12 | Ethan、Ethan·Flash、Olivia、Olivia·Flash、Harper、Harper·Flash、Grant、Grant·Flash、Iris、Iris·Flash、Jasper、Jasper·Flash |
| 多人语音 | 1 | 英文对话 |

#### English · UK（`en-GB`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 14 | Sonia、Ryan、Libby、Abbi、Bella、Hollie、Maisie、Olivia、Alfie、Elliot、Ethan、Noah、Oliver、Thomas |
| 多语言 | 2 | Ada、Ollie |
| Neural-HD | 4 | Ada、Sonia、Ollie、Ryan |

#### English · AU（`en-AU`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 14 | Natasha、Annette、Carly、Elsie、Freya、Joanne、Kim、Tina、William、Darren、Duncan、Ken、Neil、Tim |
| 多语言 | 1 | William |
| Neural-HD-Omni | 2 | Cyanspark、Siennatopaz |
| MAI-Voice-2 | 2 | Isla、Isla·Flash |

#### English · IN（`en-IN`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 14 | Neerja、Aarti、Aashi、Ananya、Kavya、Aarav、Arjun、Kunal、Prabhat、Rehaan、Aarti·Indic、Neerja·Indic、Arjun·Indic、Prabhat·Indic |
| Neural-HD | 6 | Diya、Meera、Aarti、Neerja、Lavanya、Arjun |

#### English · CA（`en-CA`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Clara、Liam |

#### English · IE（`en-IE`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Emily、Connor |

#### English · NZ（`en-NZ`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Molly、Mitchell |

#### English · SG（`en-SG`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Luna、Wayne |

#### English · HK（`en-HK`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Yan、Sam |

#### English · ZA（`en-ZA`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Leah、Luke |

#### English · PH（`en-PH`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Rosa、James |

#### English · KE（`en-KE`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Asilia、Chilemba |

#### English · NG（`en-NG`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Ezinne、Abeo |

#### English · TZ（`en-TZ`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 2 | Imani、Elimu |

</details>

<details><summary><b>日本語 ja（1 个口音）</b></summary>

#### 日本語 · 日本語（`ja-JP`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 7 | Nanami、Keita、Aoi、Daichi、Mayu、Naoki、Shiori |
| 多语言 | 1 | Masaru |
| Neural-HD | 2 | Nanami、Masaru |
| MAI-Voice-2 Flash | 2 | Haruto、Sakura |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>한국어 ko（1 个口音）</b></summary>

#### 한국어 · 한국어（`ko-KR`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 9 | InJoon、SunHi、BongJin、GookMin、Hyunsu、JiMin、SeoHyeon、SoonBok、YuJin |
| 多语言 | 1 | Hyunsu |
| Neural-HD | 2 | SunHi、Hyunsu |
| MAI-Voice-2 | 4 | Haena、Haena·Flash、Junho、Junho·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Français fr（1 个口音）</b></summary>

#### Français · Français（`fr-FR`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 14 | Denise、Henri、Alain、Brigitte、Celeste、Claude、Coralie、Eloise、Jacqueline、Jerome、Josephine、Maurice、Yves、Yvette |
| 多语言 | 3 | Vivienne、Remy、Lucien |
| Neural-HD | 2 | Vivienne、Remy |
| MAI-Voice-2 | 4 | Marc、Marc·Flash、Soleil、Soleil·Flash |
| 多人语音 | 2 | 法语对话、英文对话 |

</details>

<details><summary><b>Español es（1 个口音）</b></summary>

#### Español · Español（`es-ES`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 16 | Alvaro、Elvira、Abril、Arnau、Dario、Elias、Estrella、Irene、Laia、Lia、Nil、Saul、Teo、Triana、Vera、Ximena |
| 多语言 | 4 | Arabella、Isidora、Tristan、Ximena |
| Neural-HD | 2 | Ximena、Tristan |
| MAI-Voice-2 | 2 | Marta、Marta·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Русский ru（1 个口音）</b></summary>

#### Русский · Русский（`ru-RU`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 3 | Svetlana、Dmitry、Dariya |
| MAI-Voice-2 | 4 | Lev、Lev·Flash、Masha、Masha·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Deutsch de（1 个口音）</b></summary>

#### Deutsch · Deutsch（`de-DE`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 15 | Conrad、Katja、Amala、Bernd、Christoph、Elke、Gisela、Kasper、Killian、Klarissa、Klaus、Louisa、Maja、Ralf、Tanja |
| 多语言 | 2 | Seraphina、Florian |
| Neural-HD | 2 | Seraphina、Florian |
| MAI-Voice-2 | 4 | Klaus、Klaus·Flash、Mia、Mia·Flash |
| 多人语音 | 1 | 英文对话 |

</details>
<!-- VOICE_STATS:END -->

---

## HTTP 接口

三个路由：**`GET /`**（页面）、**`POST /v1/audio/speech`**（合成）、**`POST /v1/audio/transcriptions`**（转录，开发中），全部支持 **CORS**。

### 合成语音

```bash
curl -X POST "https://<your-worker>.workers.dev/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "你好，这是一段测试文本。",
    "voice": "zh-CN-XiaoxiaoNeural",
    "speed": 1.0,
    "pitch": "0",
    "style": "cheerful",
    "styledegree": 1
  }' \
  --output speech.mp3
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `input` | — | 待合成文本（用 `dialogue` / `segments` 时可省） |
| `voice` | `zh-CN-XiaoxiaoNeural` | 嗓音 id |
| `speed` | `1.0` | 语速，0–2 |
| `pitch` | `"0"` | 音调，-50 ~ 50 |
| `volume` | `"0"` | 音量 |
| `style` | `""` | 风格，留空则不发送 |
| `styledegree` | 服务端默认 | 风格强度，常用 `0.5 / 1 / 1.5 / 2` |
| `outputFormat` | `audio-24khz-96kbitrate-mono-mp3` | Edge TTS 的输出格式标识 |
| `segments` | — | 结构化片段（停顿 / 副语言） |
| `dialogue` / `turns` / `speakerA` / `speakerB` / `optsA` / `optsB` | — | 多人对话用，见下 |

成功直接返回音频字节，失败返回：

```json
{ "error": { "message": "文本内容过长", "type": "invalid_request_error", "param": "file", "code": "text_too_long" } }
```

带上停顿与副语言，`segments` 里出现非 `text` 类型就走片段合成，芯片边界不会被切分：

```json
{
  "voice": "en-US-Ava:DragonHDLatestNeural",
  "segments": [
    { "type": "text", "value": "Nice to meet you." },
    { "type": "pause", "duration": 800 },
    { "type": "para", "value": "laughter" },
    { "type": "text", "value": "Let us begin." }
  ]
}
```

`pause` 的 `duration` 单位是毫秒。

多人对话（`turns` 可直接给结构化轮次，不给 `input` 时必须有）：

```json
{
  "dialogue": true,
  "voice": "en-Multitalker:DragonHDLatestNeural",
  "speakerA": "ava",
  "speakerB": "andrew",
  "optsA": { "speed": 1.1 },
  "optsB": { "speed": 0.95 },
  "input": "A: How is the new model?\nB: Faster than I expected."
}
```

### 上传 txt 合成

`Content-Type: multipart/form-data`，字段同 JSON 版，另加 `file`：

```bash
curl -X POST "https://<your-worker>.workers.dev/v1/audio/speech" \
  -F "file=@script.txt" \
  -F "voice=zh-CN-XiaoxiaoNeural" \
  -F "speed=1.0" \
  --output speech.mp3
```

按对话解析时追加 `dialogue=1`、`speakerA`、`speakerB`、`optsA`、`optsB`（后两个是 JSON 字符串）。

### 语音转文字（开发中）

路由 `POST /v1/audio/transcriptions` 先占着位，目前不转发任何请求，直接返回 501：

```json
{ "error": { "message": "语音转文字功能开发中，敬请期待", "type": "api_error", "param": null, "code": "not_implemented" } }
```

功能做好之后再补上传音频的用法。

---

## 限制与已知表现

| 项目 | 限制 |
| --- | --- |
| 上传 txt | ≤ 500KB、≤ 10000 字符 |
| 上传音频（开发中） | 计划 ≤ 10MB |
| 长文本 | 每组 ≤ 1500 字符，最多 40 组 |
| 对话音色 | **一段对话只有 2 个槽位**，第三人及之后回落到第二人的音色 |
| 多人对话语言 | **仅英文内容稳定**；中文对话请选 `en-Multitalker`，`zh-Multitalker` 的说话人指派会乱序 |

- **风格**：只对英文内容听得出来，中文选了也基本没差别；服务端遇到不支持的风格会静默回落到中性。
- **副语言**：Omni 系列各语言（含中文）可用，HD 系列在中文以外可用，Flash 系列不生效。
- **语速 / 停顿**：对所有音色都有效；风格、强度、音调对多人对话无效。

---

## 目录结构

```
├── index.js        # 网页版入口：路由、SSML 构造、页面渲染
├── data/           # 语音目录与文案（网页版与桌面版共用）
│   ├── voices.json #   语音目录、对话音色名单与 locale
│   └── labels.json #   风格中文名、副语言、界面文案
├── src/
│   └── index.html  # 整页界面
├── desktop/        # Windows 桌面版（Tauri 2 + Rust）
├── scripts/        # 小工具：页面自检、语音统计、文案守护
├── wrangler.toml   # Cloudflare Workers 配置
└── LICENSE         # MIT
```

**改语音目录只改 `data/voices.json`**，网页版与桌面版同时生效；改完跑一次 `node scripts/gen-voice-stats.mjs` 更新上面的清单。

---

## 项目来源

感谢 [wangwangit/tts](https://github.com/wangwangit/tts)（MIT）最早的单文件 Worker ＋ Edge TTS 思路，上游版权署名保留在 [LICENSE](./LICENSE) 中。

---

## 许可证

[MIT](./LICENSE)
