/**
 * 授权错误码：对外只暴露稳定 code，调用方不解析 message。
 */
export type LicenseErrorCode =
  | 'invalid_input'
  | 'envelope_too_large'
  | 'payload_too_large'
  | 'envelope_malformed'
  | 'payload_malformed'
  | 'payload_invalid'
  | 'container_malformed'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'type_mismatch'
  | 'base64url_invalid'
  | 'signature_length'
  | 'signature_out_of_range'
  | 'signature_invalid'
  | 'key_invalid'
  | 'expired'
  | 'not_yet_valid'
  | 'project_not_allowed'
  | 'device_mismatch'
  | 'control_license_mismatch'
  | 'status_inactive'

export class LicenseError extends Error {
  readonly code: LicenseErrorCode

  constructor(code: LicenseErrorCode, message: string) {
    super(message)
    this.name = 'LicenseError'
    this.code = code
  }
}

export function isLicenseError(value: unknown): value is LicenseError {
  return value instanceof LicenseError
}
