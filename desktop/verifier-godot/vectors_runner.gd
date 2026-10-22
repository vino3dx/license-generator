extends RefCounted
##
## 向量运行逻辑，被 headless 脚本与导出后的主场景共用。
## 只做编排：调 Verifier 验签、比对期望、测耗时。

const Verifier = preload("res://aegis_rsa_verify.gd")

const TIMING_ITERATIONS := 20

var lines: PackedStringArray = []
var failures := 0


func run(vectors_text: String) -> void:
	var data = JSON.parse_string(vectors_text)
	if typeof(data) != TYPE_DICTIONARY:
		_emit("FATAL vectors.json 解析失败")
		failures += 1
		return
	_check_key_diagnostics(data["keys"])
	_run_cases(data["cases"], data["keys"])
	_run_invalid_keys(data["keys"], data["vendor_certificate"])
	_run_chain(data["keys"], data["vendor_certificate"], data["machine_license"])
	_measure_timing(data["keys"], data["machine_license"])
	_emit("SUMMARY fail=%d" % failures)


func _check_key_diagnostics(keys: Dictionary) -> void:
	for name in keys.keys():
		var entry: Dictionary = keys[name]
		var diagnostics: Dictionary = Verifier.public_key_diagnostics(entry["public"])
		if not diagnostics["ok"]:
			_emit("DIAG %s FAIL 公钥无法解析" % name)
			failures += 1
			continue
		var expected: Dictionary = entry["montgomery"]
		var n0inv_ok: bool = int(diagnostics["n0inv"]) == int(expected["n0inv"])
		var r2_ok: bool = String(diagnostics["r2_hex"]) == String(expected["r2_hex"])
		_emit("DIAG %s n0inv=%s r2=%s" % [name, "PASS" if n0inv_ok else "FAIL", "PASS" if r2_ok else "FAIL"])
		if not n0inv_ok or not r2_ok:
			failures += 1


func _run_cases(cases: Array, keys: Dictionary) -> void:
	for entry in cases:
		var case_id := String(entry["id"])
		var public_key: Dictionary = keys[String(entry["key"])]["public"]
		var result := Verifier.verify_envelope_text(String(entry["envelope"]), public_key, String(entry["license_type"]))
		var actual: String = "ok" if result["ok"] else String(result["error"])
		var expected := String(entry["expect"])
		var passed := actual == expected
		if not passed:
			failures += 1
		_emit("CASE %s %s expected=%s actual=%s" % [case_id, "PASS" if passed else "FAIL", expected, actual])


## 公钥本身非法时必须返回 key_invalid，而不是崩溃或误判为通过
func _run_invalid_keys(keys: Dictionary, vendor_entry: Dictionary) -> void:
	var envelope_text := String(vendor_entry["envelope"])
	var base_key: Dictionary = keys["vendor"]["public"]

	_expect_key_error("invalid-key-exponent", envelope_text, {"kty": "RSA", "n": base_key["n"], "e": "Aw"})

	var truncated := _decode_b64url(String(base_key["n"])).slice(0, 255)
	_expect_key_error(
		"invalid-key-modulus", envelope_text, {"kty": "RSA", "n": _encode_b64url(truncated), "e": base_key["e"]}
	)

	_expect_key_error("invalid-key-kind", envelope_text, {"kty": "EC", "n": base_key["n"], "e": base_key["e"]})


func _expect_key_error(case_id: String, envelope_text: String, public_key: Dictionary) -> void:
	var result := Verifier.verify_envelope_text(envelope_text, public_key, "vendor-control")
	var actual: String = "ok" if result["ok"] else String(result["error"])
	var passed := actual == "key_invalid"
	if not passed:
		failures += 1
	_emit("CASE %s %s expected=key_invalid actual=%s" % [case_id, "PASS" if passed else "FAIL", actual])


func _run_chain(keys: Dictionary, vendor_entry: Dictionary, machine_entry: Dictionary) -> void:
	var vendor_result := Verifier.verify_envelope_text(
		String(vendor_entry["envelope"]), keys["vendor"]["public"], "vendor-control"
	)
	if not vendor_result["ok"]:
		_emit("CHAIN vendor-envelope FAIL actual=%s" % String(vendor_result["error"]))
		failures += 1
		return
	_emit("CHAIN vendor-envelope PASS")

	var delegated_public: Dictionary = vendor_result["payload"]["delegated_public_key"]
	var machine_result := Verifier.verify_envelope_text(String(machine_entry["envelope"]), delegated_public, "machine-license")
	if not machine_result["ok"]:
		_emit("CHAIN machine-envelope FAIL actual=%s" % String(machine_result["error"]))
		failures += 1
		return
	_emit("CHAIN machine-envelope PASS license_id=%s" % String(machine_result["payload"]["license_id"]))

	var tampered := _flip_envelope_payload(String(machine_entry["envelope"]))
	var tampered_result := Verifier.verify_envelope_text(tampered, delegated_public, "machine-license")
	var tampered_actual: String = "ok" if tampered_result["ok"] else String(tampered_result["error"])
	var tampered_passed := tampered_actual == "signature_invalid"
	if not tampered_passed:
		failures += 1
	_emit("CHAIN machine-tampered %s actual=%s" % ["PASS" if tampered_passed else "FAIL", tampered_actual])

	var scope_ok := Verifier.is_project_allowed(vendor_result["payload"], "proj-alpha")
	if not scope_ok:
		failures += 1
	_emit("CHAIN project-scope %s" % ("PASS" if scope_ok else "FAIL"))


func _measure_timing(keys: Dictionary, machine_entry: Dictionary) -> void:
	var envelope_text := String(machine_entry["envelope"])
	var public_key: Dictionary = keys["delegate"]["public"]
	Verifier.reset_cache()
	var cold_start := Time.get_ticks_usec()
	var cold_result := Verifier.verify_envelope_text(envelope_text, public_key, "machine-license")
	var cold_ms := (Time.get_ticks_usec() - cold_start) / 1000.0
	if not cold_result["ok"]:
		_emit("TIMING FAIL 无法完成首次验签")
		failures += 1
		return

	var warm_start := Time.get_ticks_usec()
	for _index in range(TIMING_ITERATIONS):
		Verifier.verify_envelope_text(envelope_text, public_key, "machine-license")
	var warm_ms := (Time.get_ticks_usec() - warm_start) / 1000.0 / float(TIMING_ITERATIONS)
	_emit("TIMING cold_ms=%.2f warm_avg_ms=%.2f iterations=%d" % [cold_ms, warm_ms, TIMING_ITERATIONS])


## 只替换 payload 字段的原文，不重建信封。
## 用 JSON.stringify 重建会把整数 1 输出成 1.0，严格解析器会（正确地）拒绝这种数字。
func _flip_envelope_payload(envelope_text: String) -> String:
	var envelope: Dictionary = JSON.parse_string(envelope_text)
	var old_payload := String(envelope["payload"])
	var payload := _decode_b64url(old_payload)
	payload[10] = payload[10] ^ 0x01
	var new_payload := _encode_b64url(payload)
	return envelope_text.replace('"payload":"%s"' % old_payload, '"payload":"%s"' % new_payload)


func _decode_b64url(text: String) -> PackedByteArray:
	var standard := text.replace("-", "+").replace("_", "/")
	while standard.length() % 4 != 0:
		standard += "="
	return Marshalls.base64_to_raw(standard)


func _encode_b64url(bytes: PackedByteArray) -> String:
	return Marshalls.raw_to_base64(bytes).replace("+", "-").replace("/", "_").replace("=", "")


func _emit(line: String) -> void:
	lines.append(line)
	print(line)
