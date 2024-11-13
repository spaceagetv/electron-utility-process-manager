// Modules to control application life and create native browser window
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from "electron"
import { UPM } from "@3fv/electron-utility-process-manager"
import type {UPMMainService} from "@3fv/electron-utility-process-manager/main"

import Tracer from "tracer"
import Path from "path"

const log = Tracer.colorConsole()
let upmService: UPMMainService = null

/**
 * Boilerplate
 *
 * > Note: this can be done via a preload script,
 *     but for the sake of simplicity, we are just
 *     disabling all security here
 *
 * @returns {Promise<void>}
 */
async function createWindow (): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      devTools: true
    }
  })
  
  // Load the sample page
  const htmlFile = Path.resolve(__dirname, "..", "..", "..", "examples", "simple", "simple-renderer.html")
  mainWindow.webContents.openDevTools({mode: "right"})
  
  await mainWindow.loadFile(htmlFile)
  
  
}

async function start() {
  const upm = await import("@3fv/electron-utility-process-manager/main")
  const upmManager = upm.upmMainServiceManager
  Object.assign(global, {
    upm,
    upmManager,
  })
  
  console.info("UPM manager ready, now creating service", upmManager)
  upmService = await upmManager.createService("simple",Path.join(__dirname, "simple-node.js"))
  console.info("UPM service ready")
  
  upmService.sendEvent("test123")
  
  const clientPort = upmManager.createMainClient("simple", "client1")
  clientPort.start()
  clientPort.postMessage({channel: UPM.IPCChannel.UPMServiceMessage, payload: {kind: UPM.MessageKind.Event, messageId: -1, data: {test: "test456"}}})
  // const { port1, port2 } = new MessageChannelMain()
  //
  // const child = utilityProcess.fork(path.join(__dirname, 'utility-process.js'))
  // child.postMessage({ message: 'here-is-your-port' }, [port1])
  // port2.start()
  // child.on("message", ev => {
  //   log.info("Main child message received", ev)
  //
  // } )
  // port2.on("message", ev => {
  //   log.info("Main received message ON PORT", ev)
  //   port2.postMessage({name: "test123"})
  // })
  
  await createWindow()
  
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

// When App is READY
app.whenReady().then(start)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
