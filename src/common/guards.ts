import type { UtilityProcess } from "electron"
import { isFunction } from "@3fv/guard"
import { Port } from "./types"

export function isMessagePort(port: Port): port is Electron.MessagePortMain {
  return isFunction(port?.["close"])
}

export function isUtilityProcess(port: Port): port is UtilityProcess {
  return !!port && !isMessagePort(port)
}
