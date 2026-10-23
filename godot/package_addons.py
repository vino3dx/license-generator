#!/usr/bin/env python3
"""重新生成 P2 插件分发包（输出到仓库级 releases/，不再写回源码目录）。

约定（与 2026-09-29 的原始 addons.zip 保持一致）：
- 压缩包根目录是 addons/，插件位于 addons/aegis/；
- 打包 .gd / .cfg / .uid 等源码与配置，不打包 .godot 缓存与 .import；
- 条目路径统一使用 /，保留文件修改时间。

用法：
  python godot/package_addons.py                 # 输出 releases/aegis-addon-v3.zip
  python godot/package_addons.py path/to/out.zip # 指定输出路径
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "addons"
RELEASE_DIR = ROOT.parent / "releases"
DEFAULT_TARGET = RELEASE_DIR / "aegis-addon-v3.zip"
EXCLUDED_SUFFIXES = (".import",)
EXCLUDED_DIRS = {".godot"}


def main() -> int:
    if not SOURCE.is_dir():
        print(f"缺少源码目录: {SOURCE}", file=sys.stderr)
        return 1

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    entries: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(SOURCE):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        current = Path(dirpath)
        entries.append(current)
        for name in sorted(filenames):
            if name.endswith(EXCLUDED_SUFFIXES):
                continue
            entries.append(current / name)

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            relative = entry.relative_to(ROOT).as_posix()
            if entry.is_dir():
                archive.write(entry, relative + "/")
            else:
                archive.write(entry, relative)

    print(f"已生成 {target}（{len(entries)} 个条目）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
