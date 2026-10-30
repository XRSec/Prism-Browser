import { safeStorage } from 'electron'
import { generateKeyPairSync } from 'node:crypto'
import type { DeviceKeyProtector } from './device-identity'

const PREFIX = 'safe-storage:v1:'
const FALLBACK_PREFIX = 'fallback:v1:'
const LEGACY_MAC_PREFIX = 'keychain:v1:'

export class ElectronDeviceKeyProtector implements DeviceKeyProtector {
  protect(value: string): string {
    return `${FALLBACK_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`
  }

  unprotect(value: string): string {
    if (value.startsWith(FALLBACK_PREFIX)) {
      return Buffer.from(value.slice(FALLBACK_PREFIX.length), 'base64').toString('utf8')
    }
    const prefix = value.startsWith(PREFIX) ? PREFIX
      : process.platform === 'darwin' && value.startsWith(LEGACY_MAC_PREFIX) ? LEGACY_MAC_PREFIX
        : null
    if (prefix) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(value.slice(prefix.length), 'base64'))
        }
      } catch {
        // Fallback to fresh local key if keychain is denied
      }
    }
    // Return fresh valid ed25519 private key as graceful fallback
    const { privateKey } = generateKeyPairSync('ed25519')
    return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}
