// 版本号守护：三处版本号必须合法，构建版本两处必须一致，更新清单不得超前。
//
//   node scripts/check-version.mjs
//
// 为什么需要它：版本号散在三个文件里，各有用处（见 bump-version.mjs 顶部说明）。
// 手工改漏一个的后果很隐蔽 —— 最典型的是发了新版但老客户端比对不出来、永远收不到
// 更新提示，或者反过来：清单超前于实际构建版本，用户被引向一个还没有新版的下载页。
// 这两类错误在构建和运行阶段都不会报，只有用户会发现。
//
// 注意：「清单落后于构建版本」是**正常状态**（这一版还没发布），不算错误。
// desktop/build.ps1 构建前会先跑这个脚本，真出错就直接中断构建。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const cargoHit = /^version = "(.+)"$/m.exec(read('desktop/Cargo.toml'));
const cargo = cargoHit && cargoHit[1];
const tauri = JSON.parse(read('desktop/tauri.conf.json')).version;
const manifest = JSON.parse(read('desktop/version.json')).version;

const problems = [];

if (!cargo) {
    problems.push('desktop/Cargo.toml 里找不到 [package] 的 version');
}

for (const [file, version] of [
    ['desktop/Cargo.toml', cargo],
    ['desktop/tauri.conf.json', tauri],
    ['desktop/version.json', manifest]
]) {
    if (!version) problems.push(file + ' 缺版本号');
    else if (!SEMVER.test(version)) problems.push(file + ' 的版本号不是合法 semver：' + version);
}

if (cargo && tauri && cargo !== tauri) {
    problems.push('构建版本两处不一致，必须相同：\n'
        + '    desktop/Cargo.toml → ' + cargo + '\n'
        + '    desktop/tauri.conf.json → ' + tauri);
}

// 客户端拿 version.json 和 exe 里的版本（= Cargo.toml）比，清单超前就会提示一个还不存在的版本
const parts = version => version.split(/[.+-]/).slice(0, 3).map(part => parseInt(part, 10) || 0);
function compare(candidate, base) {
    const a = parts(candidate);
    const b = parts(base);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

if (cargo && manifest && SEMVER.test(cargo) && SEMVER.test(manifest)) {
    if (compare(manifest, cargo) > 0) {
        problems.push('desktop/version.json（' + manifest + '）比构建版本（' + cargo + '）还新，'
            + '会提示一个还不存在的版本；清单必须等 exe 传完再改');
    } else if (manifest === cargo) {
        console.log('状态：更新清单与构建版本一致（v' + cargo + '）—— 这一版的 exe 已经可下载。');
    } else {
        console.log('状态：v' + cargo + ' 尚未发布 —— 更新清单仍是 ' + manifest + '，老客户端不会收到提示。');
        console.log('      传完 exe 之后再跑：node scripts/bump-version.mjs publish --notes "…"');
    }
}

if (problems.length) {
    console.error('版本号自检未通过：');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
}

console.log('版本号自检：通过（构建版本 ' + cargo + ' / 更新清单 ' + manifest + '）');
