/**
 * 授权核心模块公开入口。
 *
 * 边界约定：
 * - 只依赖 TypeScript / Node.js 内置能力（node:crypto、Buffer），不依赖 electron、DOM 或界面代码。
 * - 不读写文件、不读数据库：密钥与文本由调用方提供，便于复用与测试。
 * - 协议定义见 docs/license-protocol.md。
 */
export { LicenseError, isLicenseError, type LicenseErrorCode } from './errors'
export {
  createEnvelope,
  openEnvelope,
  parseEnvelope,
  verifyEnvelopeSignature,
  type ParsedEnvelope
} from './envelope'
export {
  assertLicenseId,
  computeKeyId,
  derivePublicKey,
  exportPublicKeyParams,
  importPublicKeyParams,
  isKeyId,
  loadPrivateKeyFromPem,
  validatePublicKeyParams
} from './rsa-keys'
export {
  assertTimeWindow,
  buildMachinePayload,
  buildVendorPayload,
  parseMachinePayload,
  parseVendorPayload,
  type MachineLicenseInput,
  type VendorCertificateInput
} from './payloads'
export {
  assertProjectAllowed,
  exportVendorPublicKeyParams,
  isProjectAllowed,
  issueVendorCertificate,
  verifyVendorCertificate,
  type IssuedVendorCertificate,
  type VerifiedVendorCertificate
} from './vendor-license'
export {
  issueMachineLicense,
  verifyMachineLicense,
  type IssuedMachineLicense,
  type MachineLicenseExpectation,
  type VerifiedMachineLicense
} from './machine-license'
