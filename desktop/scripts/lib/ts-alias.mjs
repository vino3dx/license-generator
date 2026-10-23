#!/usr/bin/env node
// 让 Node 原生 TS 运行（Node 24 自带类型剥离）解析 src 内的 @core/@shared 路径别名。
// 用法：node --import ./scripts/lib/ts-alias.mjs <脚本>.ts
import { register } from 'node:module'

register('./ts-alias-loader.mjs', import.meta.url)
