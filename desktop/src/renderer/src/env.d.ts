/// <reference types="vite/client" />

import type { AegisApi } from '@shared/api'

declare global {
  interface Window {
    readonly aegis: AegisApi
  }
}

export {}
