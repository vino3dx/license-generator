#!/usr/bin/env python3
"""重新生成 godot/addons.zip 分发包。

约定（与 2026-09-29 的原始 addons.zip 保持一致）：
- 压缩包根目录是 addons/，插件位于 addons/aegis/；
- 打包 .gd / .cfg / .uid 等源码与配置，不打包 .godot 缓存与 .import；
- 条目路径统一使用 /，保留文件修改时间。

用法：python godot/package_addons.py
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "addons"
TARGET = ROOT / "addons.zip"
EXCLUDED_SUFFIXES = (".import",)
EXCLUDED_DIRS = {".godot"}


def main() -> int:
    if not SOURCE.is_dir():
        print(f"缺少源码目录: {SOURCE}", file=sys.stderr)
        return 1

    entries: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(SOURCE):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        current = Path(dirpath)
        entries.append(current)
        for name in sorted(filenames):
            if name.endswith(EXCLUDED_SUFFIXES):
                continue
            entries.append(current / name)

    with zipfile.ZipFile(TARGET, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            relative = entry.relative_to(ROOT).as_posix()
            if entry.is_dir():
                archive.write(entry, relative + "/")
            else:
                archive.write(entry, relative)

    print(f"已生成 {TARGET}（{len(entries)} 个条目）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
