/**
 * 把 session-view-plugin 装进一个 DSH profile（默认 desktop），幂等。
 *
 * 做三件事：
 *   1. 拷贝 package.json / dsh.plugin.json / lib/ 到 profiles/<profile>/node_modules/session-view-plugin
 *   2. 在 profiles/<profile>/package.json 的 dependencies 里补一行 file: 依赖（已存在则跳过）
 *   3. 在 profiles/<profile>/cordis.patch.yml 里补一条 insert（已存在则跳过），并在改动前备份 .bak-<时间戳>
 *
 * 用法：node scripts/install.mjs [--profile desktop] [--dry-run]
 * 生效：改完必须重启 DSH（Loader 只在启动时组装插件树）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name

const args = process.argv.slice(2)
const profileArg = args.indexOf('--profile')
const profile = profileArg >= 0 ? args[profileArg + 1] : 'desktop'
const dryRun = args.includes('--dry-run')

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const profilePkgFile = path.join(profileDir, 'package.json')
const targetDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)

if (!existsSync(patchFile) || !existsSync(profilePkgFile)) {
  console.error(`找不到 profile：${profileDir}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * 逐文件拷贝一棵目录树。
 * 不用 fs.cpSync：Windows 上 profile 的 node_modules 常是 pnpm 的 junction，
 * cpSync 的 `\\?\` 长路径前缀会 ESRCH。
 * @param {string} from 源目录。
 * @param {string} to 目标目录。
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
  }
}

// 1) 拷贝产物
if (dryRun) {
  console.log(`[dry-run] 拷贝 -> ${targetDir}`)
} else {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of ['package.json', 'dsh.plugin.json']) {
    writeFileSync(path.join(targetDir, entry), readFileSync(path.join(pluginDir, entry)))
  }
  rmSync(path.join(targetDir, 'lib'), { recursive: true, force: true })
  copyTree(path.join(pluginDir, 'lib'), path.join(targetDir, 'lib'))
  console.log(`已拷贝 -> ${targetDir}`)
}

// 2) profile package.json 的 file: 依赖
const profilePkgText = readFileSync(profilePkgFile, 'utf8')
if (profilePkgText.includes(`"${PACKAGE_NAME}"`)) {
  console.log('package.json 已有依赖，跳过')
} else if (dryRun) {
  console.log('[dry-run] package.json 补依赖')
} else {
  const spec = `file:${pluginDir.replace(/\\/g, '/')}`
  const next = profilePkgText.replace(
    /"dependencies":\s*\{/,
    (match) => `${match}\n    ${JSON.stringify(PACKAGE_NAME)}: ${JSON.stringify(spec)},`
  )
  if (next === profilePkgText) {
    console.error('package.json 里找不到 dependencies 段，未改动')
    process.exit(1)
  }
  writeFileSync(`${profilePkgFile}.bak-${stamp}`, profilePkgText, 'utf8')
  writeFileSync(profilePkgFile, next, 'utf8')
  console.log(`package.json 已加依赖：${PACKAGE_NAME} -> ${spec}`)
}

// 3) cordis.patch.yml 的 insert 行
const patchText = readFileSync(patchFile, 'utf8')
if (patchText.includes(`id: ${PACKAGE_NAME}`)) {
  console.log('cordis.patch.yml 已有 insert，跳过')
} else if (dryRun) {
  console.log('[dry-run] cordis.patch.yml 补 insert')
} else {
  const block = [
    '',
    `# ===== ${new Date().toISOString().slice(0, 10)} 会话视图插件（本地包 ${pluginDir}）=====`,
    '# 侧栏图标 → 全局会话总览面板（main key = session-view）。删除本段即卸载。',
    '- insert:',
    `    - id: ${PACKAGE_NAME}`,
    `      name: '${PACKAGE_NAME}'`,
    '',
  ].join('\n')
  writeFileSync(`${patchFile}.bak-${stamp}`, patchText, 'utf8')
  writeFileSync(patchFile, `${patchText.replace(/\s*$/, '')}\n${block}`, 'utf8')
  console.log('cordis.patch.yml 已加 insert')
}

console.log('完成。重启 DSH 后生效。')
