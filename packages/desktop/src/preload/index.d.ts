import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api, FluidBridge } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
    fluid: FluidBridge
  }
}
