# @3fv/electron-utility-process-manager
---

## Overview

`@3fv/electron-utility-process-manager` manages `1..n` `Electron.utilityProcess` instances/services/processes via a 
single library & provides fully typed client facades automatically 

## Install

```shell
yarn add @3fv/electron-utility-process-manager
```

## Usage

This library integrates into the `node`, `main` and `renderer` processes to provide 
transparent access from any process to a `node` (`Electron.utilityProcess`).

### Possible Use-cases 

- main -> node
- renderer -> node
- node -> node

### Examples

#### Simple Example

> NOTE: The simple example uses the bare-bones approach
> and basically avoids typing wherever possible.  For a 
> fully typed example, checkout the [complex example](#complex-example)

##### Node/Utility Process ([simple-node.ts](examples/simple/simple-node.ts))

```typescript
import upmNodeProcess from "@3fv/electron-utility-process-manager/node"

upmNodeProcess.addEventHandler((clientId, port, payload) => {
  console.info(`Received event from (${clientId})`, payload)
  return true
})

upmNodeProcess.addRequestHandler("ping", async (type, messageId, what: string) => {
  console.info(`Ping request received (${messageId})`, what)
  return `pong: ${what}`
})
```

##### Main Process ([simple-main.ts](examples/simple/simple-main.ts)) 

```typescript
import { app, BrowserWindow } from "electron"
import { UPM } from "@3fv/electron-utility-process-manager"
import type { UPMMainService } from "@3fv/electron-utility-process-manager/main"
import Path from "path"

let upmService: UPMMainService = null

async function start() {
  const upm = await import("@3fv/electron-utility-process-manager/main")
  const upmManager = upm.upmMainServiceManager
  
  Object.assign(global, {
    upm,
    upmManager
  })
  
  console.info("UPM manager ready, now creating service", upmManager)
  upmService = await upmManager.createService("simple", Path.join(__dirname, "simple-node.js"))
  console.info("UPM service ready")
  
  upmService.sendEvent("test123")
  
  const clientPort = upmManager.createMainChannel("simple", "main-channel-01")
  console.info("Start the client port")
  if (UPM.isMessagePort(clientPort))
    clientPort.start()
  
  console.info("Post a message directly")
  clientPort.postMessage({
    channel: UPM.IPCChannel.UPMServiceMessage,
    payload: { kind: UPM.MessageKind.Event, messageId: -1, data: { test: "test456" } }
  })
  
  console.info("Send event via the UPMMainService wrapper")
  upmService.sendEvent({ test: "test789" }, clientPort)
  
  console.info(`Creating port client`)
  const client = upmManager.createMainClient("simple", "main-client-01")
  console.info(`Send request/response: ping`)
  
  const pongResult = await client.executeRequest("ping", ["main"])
  console.info(`Received pong response`, pongResult)
  
  await createWindow()
  
  app.on("activate", function() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}


/**
 * Boilerplate
 *
 * > Note: this can be done via a preload script,
 *     but for the sake of simplicity, we are just
 *     disabling all security here
 *
 * @returns {Promise<void>}
 */
async function createWindow(): Promise<void> {
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
  
  const htmlFile = Path.resolve(__dirname, "..", "..", "..", "examples", "simple", "simple-renderer.html")
  mainWindow.webContents.openDevTools({ mode: "right" })
  
  await mainWindow.loadFile(htmlFile)
}

app.whenReady().then(start)

app.on("window-all-closed", function() {
  if (process.platform !== "darwin") app.quit()
})

```

##### Renderer Process ([simple-renderer.ts](examples/simple/simple-renderer.ts))

```typescript
import UPMRendererClientFactory from "@3fv/electron-utility-process-manager/renderer"

document.querySelector("#root").innerHTML = `simple-renderer-example`

async function simpleExampleUPM() {
  const client = await UPMRendererClientFactory.createClient("simple",`${process.type}-01`)
  const result = await client.executeRequest("ping", [process.type])
  console.info(`Result: ${result}`)
}

simpleExampleUPM()
  .catch(err => console.error(`renderer error: ${err.message}`, err))

export {}
```

#### Complex Example

Checkout the [source here](examples/complex), it's basically the simple example,
but fully typed

## TODO

- [ ] CI/CD
- [ ] Tests