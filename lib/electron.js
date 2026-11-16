// dsh-dashboard 宿主侧：Electron 定位与下载（私有目录，杜绝与 dsh-pet 共享 ~/.dsh/electron 互盖版本）
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Electron 私有落盘目录：~/.dsh/dsh-dashboard/electron（P0-1：与 dsh-pet 隔离）。 */
export function electronDir(dshHome) {
  return join(dshHome, 'dsh-dashboard', 'electron')
}

export function electronExePath(dshHome) {
  return join(electronDir(dshHome), 'Electron.app', 'Contents', 'MacOS', 'Electron')
}

export function versionFilePath(dshHome) {
  return join(electronDir(dshHome), 'version')
}

/** 缓存可用 = 可执行文件存在 且 version 文件与宿主 Electron 版本一致。 */
export function resolveElectron({ dshHome, version }) {
  try {
    if (existsSync(electronExePath(dshHome)) && readFileSync(versionFilePath(dshHome), 'utf8').trim() === version) {
      return electronExePath(dshHome)
    }
  } catch {
    // 忽略读取失败，走下载
  }
  return null
}

/**
 * 下载并校验 Electron（npmmirror）→ 解压到私有目录。
 * 校验：官方 SHASUMS256.txt（npmmirror 同步提供）。
 * @returns {Promise<string>} Electron 可执行文件绝对路径
 */
export async function ensureElectron({ dshHome, version, logger, onProgress }) {
  const cached = resolveElectron({ dshHome, version })
  if (cached) return cached

  const dir = electronDir(dshHome)
  mkdirSync(dir, { recursive: true })
  const log = (m) => { try { logger?.info?.(`[dsh-dashboard] ${m}`) } catch { /* 静默 */ } }
  const progress = (text, done = false) => { try { onProgress?.({ text, done }) } catch { /* 静默 */ } }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const zipName = `electron-v${version}-darwin-${arch}.zip`
  const baseUrl = `https://npmmirror.com/mirrors/electron/${version}`
  const zipPath = join(dir, `.download-${zipName}`)
  const tmpExtract = join(dir, `.extract-${Date.now()}`)

  log(`下载 Electron ${version} (darwin-${arch}) ...`)
  progress('开始下载 Electron ' + version)
  let resp
  try {
    resp = await fetch(`${baseUrl}/${zipName}`, { redirect: 'follow' })
  } catch (e) {
    throw new Error(`Electron 下载请求失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!resp.ok || !resp.body) throw new Error(`Electron 下载失败 HTTP ${resp.status}`)

  const sha256 = createHash('sha256')
  const chunks = []
  const total = Number(resp.headers.get('content-length') || 0)
  let received = 0
  let lastLogAt = 0
  for await (const chunk of resp.body) {
    chunks.push(chunk)
    sha256.update(chunk)
    received += chunk.length
    const now = Date.now()
    if (now - lastLogAt > 3000) {
      lastLogAt = now
      const pct = total ? Math.min(100, Math.floor(received / total * 100)) : -1
      log(`下载中 ${(received / 1048576).toFixed(1)}MB${total ? ` / ${(total / 1048576).toFixed(1)}MB (${pct}%)` : ''}`)
      progress(`下载中 ${pct >= 0 ? pct + '%' : (received / 1048576).toFixed(1) + 'MB'}`)
    }
  }
  const data = Buffer.concat(chunks)
  writeFileSync(zipPath, data)
  log('下载完成，校验 SHASUMS256 ...')
  progress('校验 SHASUMS256')

  // SHASUMS256 校验（拿不到清单时跳过，但记日志）
  try {
    const sumsResp = await fetch(`${baseUrl}/SHASUMS256.txt`, { redirect: 'follow' })
    if (sumsResp.ok) {
      const sumsText = await sumsResp.text()
      const line = sumsText.split('\n').map((s) => s.trim()).find((s) => s.endsWith(zipName))
      const expected = line ? line.split(/\s+/)[0] : null
      if (expected) {
        const actual = sha256.digest('hex')
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(`Electron 校验失败（SHA256 不匹配）：${zipName}`)
        }
        log('SHASUMS256 校验通过')
      } else {
        log('SHASUMS256 清单中未找到本包条目，跳过校验')
      }
    }
  } catch (e) {
    if (String(e && e.message).startsWith('Electron 校验失败')) throw e
    log(`SHASUMS256 清单获取失败（跳过校验）：${e instanceof Error ? e.message : String(e)}`)
  }

  // 解压（macOS 系统自带 ditto）
  log('解压 Electron ...')
  progress('解压 Electron')
  mkdirSync(tmpExtract, { recursive: true })
  const ditto = spawnSync('/usr/bin/ditto', ['-x', '-k', zipPath, tmpExtract], { stdio: 'ignore' })
  if (ditto.status !== 0) {
    rmSync(tmpExtract, { recursive: true, force: true })
    throw new Error('Electron 解压失败（ditto）')
  }
  const appSrc = join(tmpExtract, 'Electron.app')
  if (!existsSync(appSrc)) {
    rmSync(tmpExtract, { recursive: true, force: true })
    throw new Error('Electron 压缩包缺少 Electron.app')
  }
  const finalApp = join(dir, 'Electron.app')
  if (existsSync(finalApp)) rmSync(finalApp, { recursive: true, force: true })
  renameSync(appSrc, finalApp)
  rmSync(tmpExtract, { recursive: true, force: true })
  rmSync(zipPath, { force: true })
  writeFileSync(versionFilePath(dshHome), version + '\n')
  const exe = electronExePath(dshHome)
  log(`Electron ${version} 就绪：${exe}`)
  progress('Electron 就绪', true)
  return exe
}
