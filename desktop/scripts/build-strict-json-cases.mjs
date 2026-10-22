#!/usr/bin/env node
// 生成 Node 与 Godot 共用的严格 JSON 测试向量。
// 用法：node scripts/build-strict-json-cases.mjs
//
// 约定：
// - json_cases[].expect 是 GDScript 侧的细粒度错误码（"ok" 表示应解析成功）；
// - json_cases[].expect_ok 是两端都必须一致的布尔结论，Node 测试只比对它；
// - utf8_cases 以十六进制字节给出，避开宿主语言字符串对非法字节的替换行为。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const jsonCases = []
function add(id, input, expect) {
  jsonCases.push({ id, input, expect, expect_ok: expect === 'ok' })
}

// ---- 合法输入 ----
add('valid-empty-object', '{}', 'ok')
add('valid-empty-array', '[]', 'ok')
add('valid-simple', '{"a":1}', 'ok')
add('valid-zero', '{"a":0}', 'ok')
add('valid-max-safe-integer', '{"a":9007199254740991}', 'ok')
add('valid-string', '{"a":"hello"}', 'ok')
add('valid-cjk', '{"a":"中文测试"}', 'ok')
add('valid-literals', '{"a":true,"b":false,"c":null}', 'ok')
add('valid-array', '{"a":[1,2,3]}', 'ok')
add('valid-nested', '{"a":{"b":{"c":1}}}', 'ok')
add('valid-whitespace', ' \t\r\n{ "a" : 1 } \n', 'ok')
add('valid-escapes', '{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t"}', 'ok')
add('valid-unicode-escape', '{"a":"\\u0041"}', 'ok')
add('valid-surrogate-pair', '{"a":"\\uD83D\\uDE00"}', 'ok')
add('valid-empty-string', '{"a":""}', 'ok')

// ---- 重复键 ----
add('dup-key', '{"a":1,"a":2}', 'json_duplicate_key')
add('dup-key-nested', '{"a":{"b":1,"b":2}}', 'json_duplicate_key')
add('dup-key-object-then-scalar', '{"a":1,"a":{"b":2}}', 'json_duplicate_key')
add('dup-key-in-array-element', '{"a":[{"b":1,"b":2}]}', 'json_duplicate_key')
add('dup-key-different-order', '{"a":1,"b":2,"a":3}', 'json_duplicate_key')

// ---- 数字 ----
add('num-float', '{"a":1.5}', 'json_invalid_number')
add('num-float-zero', '{"a":1.0}', 'json_invalid_number')
add('num-exponent', '{"a":1e3}', 'json_invalid_number')
add('num-exponent-upper', '{"a":1E3}', 'json_invalid_number')
add('num-leading-zero', '{"a":01}', 'json_invalid_number')
add('num-negative', '{"a":-1}', 'json_invalid_number')
add('num-negative-zero', '{"a":-0}', 'json_invalid_number')
add('num-over-safe', '{"a":9007199254740992}', 'json_invalid_number')
add('num-huge', '{"a":123456789012345678901234567890}', 'json_invalid_number')

// ---- 语法与结构 ----
add('trailing-junk', '{"a":1} junk', 'json_trailing_data')
add('trailing-object', '{"a":1}{"b":2}', 'json_trailing_data')
add('unclosed-object', '{"a":1', 'json_syntax')
add('missing-value', '{"a":}', 'json_syntax')
add('missing-colon', '{"a" 1}', 'json_syntax')
add('missing-comma', '{"a":1 "b":2}', 'json_syntax')
add('unquoted-key', '{a:1}', 'json_syntax')
add('single-quotes', "{'a':1}", 'json_syntax')
add('array-unclosed', '[1,2', 'json_syntax')
add('array-trailing-comma', '[1,]', 'json_syntax')
add('object-trailing-comma', '{"a":1,}', 'json_syntax')
add('bare-word', 'truex', 'json_trailing_data')
add('empty-input', '', 'json_empty')
add('only-whitespace', '   ', 'json_empty')

// ---- 转义 ----
add('escape-unknown', '{"a":"\\x41"}', 'json_invalid_escape')
add('escape-truncated-u', '{"a":"\\u12"}', 'json_invalid_escape')
add('escape-bad-hex', '{"a":"\\u12G4"}', 'json_invalid_escape')
add('escape-lone-high-surrogate', '{"a":"\\uD800"}', 'json_invalid_escape')
add('escape-lone-low-surrogate', '{"a":"\\uDC00"}', 'json_invalid_escape')
add('escape-high-then-normal', '{"a":"\\uD800\\u0041"}', 'json_invalid_escape')
add('escape-backslash-eof', '{"a":"\\', 'json_invalid_escape')

// ---- 裸控制字符 ----
add('control-char-0x01', `{"a":"${String.fromCharCode(1)}"}`, 'json_control_char')
add('control-char-newline', '{"a":"a\nb"}', 'json_control_char')
add('control-char-tab', '{"a":"a\tb"}', 'json_control_char')

// ---- 深度与长度 ----
function nest(levels) {
  let value = '1'
  for (let i = 0; i < levels; i += 1) {
    value = `{"a":${value}}`
  }
  return value
}
add('depth-8-allowed', nest(8), 'ok')
add('depth-9-rejected', nest(9), 'json_too_deep')
add('string-16384-allowed', `{"a":"${'x'.repeat(16384)}"}`, 'ok')
add('string-16385-rejected', `{"a":"${'x'.repeat(16385)}"}`, 'json_string_too_long')

// ---- UTF-8 字节级 ----
const utf8Cases = [
  { id: 'utf8-ascii', hex: '7b7d', valid: true },
  { id: 'utf8-cjk', hex: 'e4b8ade69687', valid: true },
  { id: 'utf8-emoji', hex: 'f09f9880', valid: true },
  { id: 'utf8-2byte-max', hex: 'dfbf', valid: true },
  { id: 'utf8-3byte-boundary', hex: 'e0a080', valid: true },
  { id: 'utf8-4byte-boundary', hex: 'f0908080', valid: true },
  { id: 'utf8-invalid-ff', hex: 'ff', valid: false },
  { id: 'utf8-invalid-fe', hex: 'fe', valid: false },
  { id: 'utf8-overlong-2byte', hex: 'c080', valid: false },
  { id: 'utf8-overlong-3byte', hex: 'e08080', valid: false },
  { id: 'utf8-surrogate', hex: 'eda080', valid: false },
  { id: 'utf8-above-max', hex: 'f4908080', valid: false },
  { id: 'utf8-truncated-3byte', hex: 'e4b8', valid: false },
  { id: 'utf8-lone-continuation', hex: '80', valid: false },
  { id: 'utf8-5byte', hex: 'f5808080', valid: false }
]

const output = {
  version: 1,
  note: '由 scripts/build-strict-json-cases.mjs 生成；Node 与 Godot 共用。不要手工编辑。',
  json_cases: jsonCases,
  utf8_cases: utf8Cases
}

const target = join(process.cwd(), 'tests', 'fixtures', 'strict-json-cases.json')
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`写入 ${target}：json_cases=${jsonCases.length} utf8_cases=${utf8Cases.length}`)
