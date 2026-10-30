import { safeStorage } from 'electron'

export interface SecretCodec {
  encode(value: string): string
  decode(value: string): string
}

export const identitySecretCodec: SecretCodec = {
  encode: (value) => value,
  decode: (value) => value
}

export class ElectronSecretCodec implements SecretCodec {
  encode(value: string): string {
    if (!value) return ''
    return `fallback:v1:${Buffer.from(value, 'utf8').toString('base64')}`
  }

  decode(value: string): string {
    if (!value) return ''
    if (value.startsWith('fallback:v1:')) {
      return Buffer.from(value.slice('fallback:v1:'.length), 'base64').toString('utf8')
    }
    if (value.startsWith('encrypted:v1:')) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(value.slice('encrypted:v1:'.length), 'base64'))
        }
      } catch {
        // Fallback to empty string if keychain is refused or unavailable
      }
      return ''
    }
    return value
  }
}
