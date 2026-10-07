// 版本号唯一入口 —— 分两步：「升构建版本」与「发布更新清单」。
//
//   node scripts/bump-version.mjs minor                         # 0.1.0 -> 0.2.0，只升构建版本
//   node scripts/bump-version.mjs minor --notes "…"             # 同上，顺手记下这次改了什么
//   node scripts/bump-version.mjs minor --publish --notes "…"   # 升版本，同时同步更新清单
//   node scripts/bump-version.mjs publish --notes "…"           # 不升版本，只把清单补到当前构建版本
//
// 为什么必须分两步：三处版本号含义不同 ——
//   desktop/Cargo.toml        编译进 exe 的版本，也就是「当前构建的是哪一版」
//   desktop/tauri.conf.json   打包元数据（exe 属性里的文件/产品版本），始终跟着 Cargo.toml
//   desktop/version.json      仓库里给客户端拉的「最新可下载版本」
// 客户端只拿 version.json 和 exe 里的版本比。exe 还没传上去就先改了清单，老用户下次
// 启动会收到一个指向空下载页的更新提示 —— 所以第三步 publish 必须在传完 exe 之后。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARGO = join(root, 'desktop', 'Cargo.toml');
const TAURI = join(root, 'desktop', 'tauri.conf.json');
const MANIFEST = join(root, 'desktop', 'version.json');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const CARGO_VERSION = /^version = "(.+)"$/m;
const KEYWORDS = ['patch', 'minor', 'major'];

const read = path => readFileSync(path, 'utf8');
const cargoVersion = () => (CARGO_VERSION.exec(read(CARGO)) || [])[1];
const tauriVersion = () => JSON.parse(read(TAURI)).version;
const manifest = () => JSON.parse(read(MANIFEST));

function parts(version) {
    return version.split(/[.+-]/).slice(0, 3).map(part => parseInt(part, 10) || 0);
}

/// 逐位比较：candidate 比 base 新返回正数
function compare(candidate, base) {
    const a = parts(candidate);
    const b = parts(base);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function bump(current, keyword) {
    const [major, minor, patch] = parts(current);
    if (keyword === 'major') return `${major + 1}.0.0`;
    if (keyword === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

function usage() {
    console.error('用法：');
    console.error('  node scripts/bump-version.mjs <patch|minor|major|X.Y.Z> [--notes "更新说明"]');
    console.error('  node scripts/bump-version.mjs <同上> --publish [--notes "更新说明"]');
    console.error('  node scripts/bump-version.mjs publish [--notes "更新说明"]');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 参数：--notes 后跟一个取值，别把它当成版本号
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const notes = args.includes('--notes') ? args[args.indexOf('--notes') + 1] || null : null;
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--notes') {
        i += 1;
        continue;
    }
    if (args[i].startsWith('--')) continue;
    positional.push(args[i]);
}
const request = positional[0] || '';
const publishOnly = request === 'publish';
const doPublish = publishOnly || args.includes('--publish');

if (!request && !doPublish) usage();

const current = cargoVersion();
if (!current) {
    console.error('desktop/Cargo.toml 里找不到 [package] 的 version');
    process.exit(1);
}

const tauri = tauriVersion();
if (current !== tauri) {
    console.error('Cargo.toml 与 tauri.conf.json 版本号已经不一致，请先手工对齐：');
    console.error(`  desktop/Cargo.toml       ${current}`);
    console.error(`  desktop/tauri.conf.json  ${tauri}`);
    process.exit(1);
}
if (!SEMVER.test(current)) {
    console.error(`当前版本号不是合法 semver：${current}`);
    process.exit(1);
}

const before = manifest();
if (!SEMVER.test(before.version || '')) {
    console.error(`desktop/version.json 里不是合法 semver：${before.version}`);
    process.exit(1);
}
if (compare(before.version, current) > 0) {
    console.error(`更新清单 ${before.version} 已经比构建版本 ${current} 新，这不可能也不该修：`);
    console.error('  说明清单被误改过，请先把它改回不高于 Cargo.toml 的版本');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 算目标版本
// ---------------------------------------------------------------------------
let target = current;
if (!publishOnly) {
    target = KEYWORDS.includes(request) ? bump(current, request) : request;
    if (!SEMVER.test(target)) {
        console.error(`新版本号不是合法 semver：${target}（要形如 1.2.3，可带 -beta.1）`);
        process.exit(1);
    }
    if (compare(target, current) <= 0) {
        console.error(`新版本号 ${target} 不比当前 ${current} 新，拒绝改小/改平`);
        process.exit(1);
    }
    // 三处各按自己的格式改，只动一行，避免整文件重排
    writeFileSync(CARGO, read(CARGO).replace(CARGO_VERSION, `version = "${target}"`));
    writeFileSync(TAURI, read(TAURI).replace(/("version":\s*")[^"]+(")/, `$1${target}$2`));
}

if (doPublish) {
    const next = { ...before, version: target };
    if (notes) next.notes = notes;
    writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log(publishOnly
    ? `构建版本不变（${current}），发布更新清单`
    : `构建版本 ${current} → ${target}`);
console.log('  desktop/Cargo.toml' + (publishOnly ? '（未改）' : ''));
console.log('  desktop/tauri.conf.json' + (publishOnly ? '（未改）' : ''));
console.log(doPublish
    ? `  desktop/version.json  → ${target}（客户端会看到更新提示）`
    : `  desktop/version.json  仍是 ${before.version}（这一版还没发布，客户端不会收到提示）`);

if (notes && !doPublish) {
    console.log('');
    console.log('注意：更新说明写在 version.json 里，这次没发布，所以 --notes 没有落盘。');
    console.log('      发布时再带上它：node scripts/bump-version.mjs publish --notes "…"');
}

console.log('');
if (doPublish) {
    console.log('接下来：');
    console.log(`  1. desktop\\build.ps1        构建 exe（v${target}）`);
    console.log(`  2. 传到 GitHub Releases（打 tag v${target}）—— 必须在推送之前完成`);
    console.log('  3. 提交并推送（version.json 就是这一步生效的）');
} else {
    console.log('接下来：');
    console.log(`  1. desktop\\build.ps1        构建 exe（v${target}）`);
    console.log(`  2. 传到 GitHub Releases（打 tag v${target}）`);
    console.log('  3. 提交并推送代码（先别推 version.json）');
    console.log('  4. exe 传好之后再发布更新清单，老用户这时才会收到提示：');
    console.log(`     node scripts/bump-version.mjs publish --notes "这一版改了什么"`);
}
