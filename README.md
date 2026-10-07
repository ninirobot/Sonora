# ![Sonora](desktop/icons/icon.svg) Sonora · 声界

把文字读出来。

Sonora 是一台语音工作台，合成走微软 Edge TTS。**9 种语言、23 个口音、300+ 副嗓音**，一个窗口里调完就能导出。（语音转文字**还在开发中**，入口会先占个位。）

两种形态共用同一套界面和语音目录：

- **网页版** —— 一个 Cloudflare Worker 文件，部署完就有网址。
- **Windows 桌面版** —— 一个 exe，双击即用，不用自己部署服务。

两边都顺带开着 **OpenAI 风格的接口**（`POST /v1/audio/speech`），自己的脚本也能直接调。

> **怎么用**看 [使用说明](docs/使用说明.md)——每个按钮干什么、听力测试的文稿怎么写、出问题怎么办。
> 本文件讲的是**它是什么**和**怎么部署**。

---

## 能做什么

**文本转语音**

四种输入：**单人文本 / A/B 多人对话 / 上传 txt / 听力测试**。正文里可以插**停顿**（0–5 秒可调）和**副语言**（笑声、咳嗽、换气、叹气等），从别处粘贴带 `[停顿 2s]`、`[laughter]` 这类标记的文本会自动还原成可编辑的芯片。**语速、音调、音量、风格、风格强度**都能调，输出支持 **MP3 / WAV / OGG**。长文按句切分再拼回一段音频，生成后可试听或导出。

**听力测试**是为考卷准备的：文稿按「中文提示行 / `M:` 男声 / `W:` 女声」写，一段里只有一个人说话会自动识别成**独白**。一条音频里按顺序排出「叮咚 → 中文播报 → 英文录音」，可连播两遍、结尾留 2 分钟涂卡时间，四张卡片（中文播报 / M / W / 独白）各自配音色和语速。男女声有两种合成方式随时切换：**原生模式**走微软多说话人模型（韵律自然，但只有 8 个说话人可选），**普通模式**男女各用一副普通英文音色（整个英文目录任选，两人语速可分别微调）。

嗓音列表能搜索，点一下喇叭可以先用一句示例听听这副嗓子，常用的嗓音收藏后会带一颗星。生成过程中随时可以停止，失败了一键重试；最近几次的结果留在面板上，可以回听、重新导出。参数与文稿会自动记住，下次打开还在。

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
.\build.ps1            # 一键构建；调试运行用 .\build.ps1 -Dev
```

`build.ps1` 就是替你调 `cargo tauri build`（cargo 不在 PATH 时用全路径调），再打印产物路径和体积。cargo 已经配好了的话，直接 `cargo tauri build` 一样能构建。

产物是 `desktop\target\release\sonora.exe`，**单个文件约 3.8MB，双击即用**，不写注册表，直接拷给别人就能跑。

> 桌面版只是省掉了「自己部署一个服务」，**合成仍然需要联网**。

### 版本与发布

版本号有三处，含义不同：

| 文件 | 作用 |
| --- | --- |
| `desktop/Cargo.toml` | 编译进 exe 的版本，也就是「当前构建的是哪一版」 |
| `desktop/tauri.conf.json` | 打包元数据，exe 属性里看到的文件/产品版本（始终跟着 Cargo.toml） |
| `desktop/version.json` | 仓库里给客户端拉的「最新**可下载**版本」 |

**改版本号只用一条命令**（`desktop/build.ps1` 构建前会自动校验，真出错直接中断）：

```powershell
node scripts/bump-version.mjs minor                    # 0.1.0 -> 0.2.0，只升构建版本
node scripts/bump-version.mjs patch --notes "修个小问题"
node scripts/bump-version.mjs 1.0.0
```

发布流程（**先传 exe，再动更新清单**）：

1. `node scripts/bump-version.mjs minor --notes "这版改了什么"`；
2. 构建 exe：`cd desktop; .\build.ps1`；
3. 到 GitHub Releases 打 tag（`v0.2.0`）并上传新的 exe；
4. 传完之后再把更新清单推到同一版本，老用户这时才会收到提示：
   `node scripts/bump-version.mjs publish --notes "这版改了什么"`，然后提交推送。

> **顺序不能颠倒**：客户端拿 `version.json` 和 exe 里编进去的版本比。清单一旦超前，
> 用户就会收到一个指向空下载页的更新提示。所以「清单落后于构建版本」是正常状态
>（`check-version.mjs` 会明说「尚未发布」），而「清单超前」直接报错。
> 桌面版状态栏和「关于」里都显示当前版本号，不用去右键属性里翻。

---

## 怎么用

1. **顶部选语言**，需要时再选口音，两者决定右边的嗓音列表。
2. **输入或粘贴文本**；要停顿、笑声就在光标处插入。
3. **右边选嗓音**，调语速、音调、风格，点生成，试听或导出。

**多人对话模式**下，每行开头写 `A:` / `B:` 指定说话人，两个角色可以各配一个嗓音和语速。

**听力测试模式**下，中文提示直接写中文行，对话行用 `M:`（男）/ `W:`（女）开头。右栏换成一排卡片：**中文播报 / M / W / 独白**，各配音色与语速；顶部可切「原生 / 普通」两种对话方式。⚠️ **停顿芯片不要单独占一行**，要跟在某句话后面，否则会报「有一段文稿是空的」。

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
| 语音条目 | 387 |
| 去重语音 id | 380 |
| 音色家族 | 9 |
| 多人对话模型 | 3 |

「语音条目」按下拉里的条数算：同一副嗓子在多个语言页签下各占一条，所以比去重 id 多。
多人对话是 3 个模型（`en-` / `zh-` / `fr-Multitalker`）挂在多个语言页签下，共 10 个入口。

**家族分布**（按语音条目计）

| 家族 | 数量 | 说明 |
| --- | --- | --- |
| 标准 | 187 | 经典 Neural 语音，风格按语音逐条列 |
| 多语言 | 44 | MultilingualNeural，一副嗓子说多国语言 |
| OpenAI | 7 | Azure OpenAI 同款音色的 Turbo 版，延迟更低、多语言更稳 |
| Neural-HD | 52 | LLM 驱动的 HD 语音，共用 62 项模型级风格表 |
| Neural-HD-Omni | 15 | HD 的 Omni 版本，风格 61 项（不含 whispering） |
| Neural-HD-Flash | 18 | HD 的低延迟版本，仅中文与英文 |
| MAI-Voice-2.1 | 42 | 另一套 HD 语音，含 ·Flash 低延迟变体 |
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
| MAI-Voice-2.1 | 8 | Bo、Bo·Flash、Mei、Mei·Flash、Wei、Wei·Flash、Lan、Lan·Flash |
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
| 多语言 | 22 | Andrew、Phoebe、Davis、Derek、Nancy、Serena、Ava、Amanda、Adam、Emma、Brian、Cora、Christopher、Brandon、Dustin、Evelyn、Jenny、Lewis、Lola、Ryan、Samuel、Steffan |
| OpenAI | 7 | Alloy Turbo、Echo Turbo、Fable Turbo、Onyx Turbo、Nova Turbo、Shimmer Turbo、Ash Turbo |
| Neural-HD | 30 | Ava、Andrew、Adam、Alloy、Aria、Bree、Brian、Davis、Emma、Emma2、Jane、Jenny、Nova、Phoebe、Serena、Steffan、Andrew2、Andrew3、Ava3、Evelyn、Jimmie、Juno、Mila、Tessa、Tiana、Tyler、Vance、Andrew-Preview、Ava-Preview、Serena-Preview |
| Neural-HD-Omni | 10 | Andrew、Caleb、Dana、Lewis、Phoebe、Ava、Emma、Blushzephyr、Goldenspark、Jelly |
| Neural-HD-Flash | 3 | Jimmie、Tiana、Tyler |
| MAI-Voice-2.1 | 12 | Ethan、Ethan·Flash、Olivia、Olivia·Flash、Harper、Harper·Flash、Grant、Grant·Flash、Iris、Iris·Flash、Jasper、Jasper·Flash |
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
| MAI-Voice-2.1 | 2 | Isla、Isla·Flash |

#### English · IN（`en-IN`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 15 | Neerja、Neerja·Expressive、Aarti、Aashi、Ananya、Kavya、Aarav、Arjun、Kunal、Prabhat、Rehaan、Aarti·Indic、Neerja·Indic、Arjun·Indic、Prabhat·Indic |
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
| MAI-Voice-2.1 Flash | 2 | Haruto、Sakura |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>한국어 ko（1 个口音）</b></summary>

#### 한국어 · 한국어（`ko-KR`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 9 | InJoon、SunHi、BongJin、GookMin、Hyunsu、JiMin、SeoHyeon、SoonBok、YuJin |
| 多语言 | 1 | Hyunsu |
| Neural-HD | 2 | SunHi、Hyunsu |
| MAI-Voice-2.1 | 4 | Haena、Haena·Flash、Junho、Junho·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Français fr（1 个口音）</b></summary>

#### Français · Français（`fr-FR`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 14 | Denise、Henri、Alain、Brigitte、Celeste、Claude、Coralie、Eloise、Jacqueline、Jerome、Josephine、Maurice、Yves、Yvette |
| 多语言 | 3 | Vivienne、Remy、Lucien |
| Neural-HD | 2 | Vivienne、Remy |
| MAI-Voice-2.1 | 4 | Marc、Marc·Flash、Soleil、Soleil·Flash |
| 多人语音 | 2 | 法语对话、英文对话 |

</details>

<details><summary><b>Español es（1 个口音）</b></summary>

#### Español · Español（`es-ES`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 16 | Alvaro、Elvira、Abril、Arnau、Dario、Elias、Estrella、Irene、Laia、Lia、Nil、Saul、Teo、Triana、Vera、Ximena |
| 多语言 | 4 | Arabella、Isidora、Tristan、Ximena |
| Neural-HD | 2 | Ximena、Tristan |
| MAI-Voice-2.1 | 2 | Marta、Marta·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Русский ru（1 个口音）</b></summary>

#### Русский · Русский（`ru-RU`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 3 | Svetlana、Dmitry、Dariya |
| MAI-Voice-2.1 | 4 | Lev、Lev·Flash、Masha、Masha·Flash |
| 多人语音 | 1 | 英文对话 |

</details>

<details><summary><b>Deutsch de（1 个口音）</b></summary>

#### Deutsch · Deutsch（`de-DE`）

| 分组 | 数量 | 语音 |
| --- | --- | --- |
| 标准 | 15 | Conrad、Katja、Amala、Bernd、Christoph、Elke、Gisela、Kasper、Killian、Klarissa、Klaus、Louisa、Maja、Ralf、Tanja |
| 多语言 | 2 | Seraphina、Florian |
| Neural-HD | 2 | Seraphina、Florian |
| MAI-Voice-2.1 | 4 | Klaus、Klaus·Flash、Mia、Mia·Flash |
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
| `input` | — | 待合成文本（用 `dialogue` / `segments` 时可省）；可直接写 `[停顿 2s]` / `[laughter]` 这类标记，效果等同 `segments` |
| `voice` | `zh-CN-XiaoxiaoNeural` | 嗓音 id |
| `speed` | `1.0` | 语速，0–2 |
| `pitch` | `"0"` | 音调，-50 ~ 50 |
| `volume` | `"0"` | 音量，-1 ~ 1（界面上按百分比调） |
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
    { "type": "pause", "ms": 800 },
    { "type": "para", "tag": "laughter" },
    { "type": "text", "value": "Let us begin." }
  ]
}
```

`pause` 的 `ms` 单位是毫秒（单条上限 20000）；`para` 的 `tag` 取 `laughter` / `coughing` / `throat_clearing` / `breathing` / `sighing` / `yawning`。

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
| 上传 txt | ≤ 5MB、≤ 50000 字符 |
| 上传音频（开发中） | 计划 ≤ 10MB |
| 长文本 | 每组 ≤ 1500 字符，最多 40 组（桌面版 100 组） |
| 对话音色 | **一段对话只有 2 个槽位**，第三人及之后回落到第二人的音色 |
| 多人对话语言 | **仅英文内容稳定**；中文对话请选 `en-Multitalker`，`zh-Multitalker` 的说话人指派会乱序 |
| 听力测试 · 叮咚 | **仅 MP3 输出会插入提示音**；WAV / OGG 拿回来的是裸 PCM，混不了 MP3 数据 |
| 听力测试 · 停顿 | 落在**整条音频最末尾**的停顿，在 DragonHD 系列（含 Flash / Omni）、MAI 系列、MultiTalker 下会被端点吞；听力测试的这类停顿由程序改用「静音片段」在块后拼，不受影响。停顿芯片不能单独占一行 |
| 听力测试 · 网页版 | 受 CF 免费版 **50 个子请求**上限约束，特别长的稿子可能超；桌面版宽松得多（100 组） |

- **风格**：只对英文内容听得出来，中文选了也基本没差别；服务端遇到不支持的风格会静默回落到中性。
- **副语言**：Omni 系列各语言（含中文）可用，HD 系列在中文以外可用，Flash 系列不生效。
- **语速**：对所有音色都有效；风格、强度、音调对多人对话无效。
- **停顿**：句内、句间、对话轮次之间的停顿对所有音色都有效；只有落在**整条音频最末尾**的停顿会被 DragonHD 系列（含 Flash / Omni）、MAI 系列、MultiTalker 吞掉（实测 2026-10-07，可用 `node scripts/probe-silence.mjs` 复验）。

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
│   └── version.json # 客户端拉取的「最新版本」清单（见「版本与发布」）
├── docs/
│   └── 使用说明.md  # 用户向操作手册
├── scripts/        # 小工具：页面自检、语音统计、文案守护、版本号
├── wrangler.toml   # Cloudflare Workers 配置
└── LICENSE         # MIT
```

**改语音目录只改 `data/voices.json`**，网页版与桌面版同时生效；改完跑一次 `node scripts/gen-voice-stats.mjs` 更新上面的清单。

**改版本号只跑 `node scripts/bump-version.mjs`**，三处版本号一起改；`scripts/check-version.mjs` 负责校验它们一致（`build.ps1` 构建前自动跑一遍）。

---

## 项目来源

感谢 [wangwangit/tts](https://github.com/wangwangit/tts)（MIT）最早的单文件 Worker ＋ Edge TTS 思路，上游版权署名保留在 [LICENSE](./LICENSE) 中。

---

## 许可证

[MIT](./LICENSE)
