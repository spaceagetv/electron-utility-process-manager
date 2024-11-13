// Modules to control application life and create native browser window
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from "electron"


import path from "node:path"
import Tracer from "tracer"

const log = Tracer.console()

function createWindow () {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      // preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      devTools: true
    }
  })
  
  // and load the index.html of the app.
  mainWindow.loadFile('index.html')
  
  // Open the DevTools.
  // mainWindow.webContents.openDevTools()
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  const { port1, port2 } = new MessageChannelMain()
  
  const child = utilityProcess.fork(path.join(__dirname, 'utility-process.js'))
  child.postMessage({ message: 'here-is-your-port' }, [port1])
  port2.start()
  child.on("message", ev => {
    log.info("Main child message received", ev)
    
  } )
  port2.on("message", ev => {
    log.info("Main received message ON PORT", ev)
    port2.postMessage({name: "test123"})
  })
  
  createWindow()
  
  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
