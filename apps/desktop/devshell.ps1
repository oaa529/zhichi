# 桌面端开发辅助（Windows）
#
# 背景：Rust 的 msvc 工具链需要 Windows SDK（kernel32.lib 等）。
# 这台机器的 Windows SDK **只有安装记录、文件已丢失**（VS Installer 里显示
# "已安装"但磁盘上没有 lib/include/bin），且静默/提权安装都被同一问题挡住
# （安装器认为已装好，直接跳过；UAC 静默路径不可用）。
#
# 因此本机走 **GNU 工具链**路线（已验证可编译、可运行）：
#   1. rustup 装了 stable-x86_64-pc-windows-gnu（含 host 侧，build script 也用它）
#   2. MinGW-w64（D:\MinGw\mingw64）提供 CRT 与全部 Windows import lib
#   3. 仓库目录已 `rustup override set stable-x86_64-pc-windows-gnu`
#      （记录在 ~/.rustup/settings.toml，不污染仓库）
#   4. ~/.cargo/config.toml 给 gnu target 指定了 linker（默认值，显式写明）
#
# 标准机器上有完好的 Windows SDK 时不需要这些：直接 pnpm desktop:dev 即可
# （tauri CLI 用默认 msvc 工具链编译）。

param(
    [string]$Command = ""
)

$ErrorActionPreference = "Stop"

# cargo（rustup 装在用户目录，不在系统 PATH）
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
    Write-Output "[devshell] cargo 已加入 PATH"
}

# MinGW（GNU 工具链的链接器所在；正常有 SDK 的机器可不管）
$mingwCandidates = @(
    "D:\MinGw\mingw64\bin",
    "C:\msys64\mingw64\bin",
    "C:\Program Files\Git\mingw64\bin"
)
foreach ($dir in $mingwCandidates) {
    if (Test-Path $dir) {
        $env:Path = "$dir;$env:Path"
        Write-Output "[devshell] MinGW 已加入 PATH：$dir"
        break
    }
}

# 确认当前仓库用的是哪个工具链（正常情况下显示 gnu，因为目录 override）
try {
    $shown = (& rustup show active-toolchain 2>$null)
    Write-Output "[devshell] 活动工具链：$shown"
} catch {
    Write-Output "[devshell] 读不到 rustup 工具链信息（不影响，只要 cargo 能跑）"
}

if ($Command) {
    Write-Output "[devshell] 执行：$Command"
    & $Command
}
