/**
 * 授权协议常量与共享类型（协议见 docs/license-protocol.md）。
 * 约束：此文件不依赖 Node.js，渲染进程与主进程都可引用。
 */

export const LICENSE_PROTOCOL_ID = 'aegis-license/v3'
export const LICENSE_ENVELOPE_MARKER = 'license-envelope'
export const LICENSE_SCHEMA_VERSION = 3
export const LICENSE_SIGNATURE_ALGORITHM = 'RS256'

export const MAX_ENVELOPE_BYTES = 16 * 1024
export const MAX_PAYLOAD_BYTES = 8 * 1024
export const RSA_MODULUS_BYTES = 256
export const RSA_SIGNATURE_BYTES = RSA_MODULUS_BYTES
export const RSA_MIN_EXPONENT = 65537
export const RSA_MAX_EXPONENT_UPPER_BOUND = 2 ** 32
export const CLOCK_SKEW_MS = 5 * 60 * 1000

/** 子机提前多久开始尝试续期（秒）。编译期常量，不来自授权文件。 */
export const RENEW_WINDOW_SECONDS = 30 * 24 * 60 * 60
/** 临期窗口内后台拉取间隔（秒） */
export const RENEW_RETRY_SECONDS = 6 * 60 * 60
/** 已过期后的重试间隔（秒） */
export const EXPIRED_RETRY_SECONDS = 5 * 60
/** 局域网发现端口 */
export const LAN_DISCOVERY_PORT = 47820

export type LicenseType = 'vendor-control' | 'machine-license'

export const LICENSE_TYPES: readonly LicenseType[] = ['vendor-control', 'machine-license']

export type MachineLicenseStatus = 'active' | 'revoked'

/** 协议内唯一的公钥表示：modulus / exponent，禁止 PEM/DER */
export interface RsaPublicKeyParams {
  readonly kty: 'RSA'
  /** base64url（无填充）大端无符号 256 字节 */
  readonly n: string
  /** base64url（无填充）大端无符号，如 AQAB */
  readonly e: string
}

export interface LicenseEnvelope {
  readonly aegis: typeof LICENSE_ENVELOPE_MARKER
  readonly schema_version: number
  readonly license_type: LicenseType
  readonly alg: typeof LICENSE_SIGNATURE_ALGORITHM
  readonly kid: string
  readonly payload: string
  readonly signature: string
}

/**
 * 中控授权证书（厂商签发）。
 * `expires_at` 是厂商放行的授权上限，任何子机授权的 `expires_at` 都不得晚于它。
 * 不区分试用/正式：试用 = 15 天，买断 = 100 年。
 */
export interface VendorControlPayload {
  readonly schema_version: number
  readonly license_type: 'vendor-control'
  readonly license_id: string
  readonly issued_at: string
  readonly expires_at: string
  /** 单元素 ["*"] 表示不限项目 */
  readonly project_ids: readonly string[]
  readonly max_devices: number
  readonly delegated_public_key: RsaPublicKeyParams
}

/**
 * 子机授权（委托私钥签发）。
 * `control_cert` 内嵌完整的中控证书信封（base64url，无填充），使整条信任链自包含：
 * 子机只读 license.dat 即可完成验签，不再依赖单独分发的 control.cert。
 */
export interface MachineLicensePayload {
  readonly schema_version: number
  readonly license_type: 'machine-license'
  readonly license_id: string
  readonly control_license_id: string
  readonly project_id: string
  readonly device_id: string
  readonly issued_at: string
  readonly expires_at: string
  readonly status: MachineLicenseStatus
  /** base64url(control.cert 信封文本的 UTF-8 字节)，无填充 */
  readonly control_cert: string
}

export const VENDOR_PAYLOAD_KEYS: readonly string[] = [
  'schema_version',
  'license_type',
  'license_id',
  'issued_at',
  'expires_at',
  'project_ids',
  'max_devices',
  'delegated_public_key'
]

export const MACHINE_PAYLOAD_KEYS: readonly string[] = [
  'schema_version',
  'license_type',
  'license_id',
  'control_license_id',
  'project_id',
  'device_id',
  'issued_at',
  'expires_at',
  'status',
  'control_cert'
]

export const ENVELOPE_KEYS: readonly string[] = [
  'aegis',
  'schema_version',
  'license_type',
  'alg',
  'kid',
  'payload',
  'signature'
]

export const PUBLIC_KEY_KEYS: readonly string[] = ['kty', 'n', 'e']
