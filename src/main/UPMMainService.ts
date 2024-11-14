import { app, MessageChannelMain, MessagePortMain, utilityProcess, UtilityProcess } from "electron"
import { assert, getValue, isString } from "@3fv/guard"
import Fsx from "fs-extra"
import { Deferred } from "@3fv/deferred"
import * as UPM from "../common"
import { isEmpty, negate } from "lodash"

import Tracer from "tracer"
import { IServiceClient } from "../common"

const log = Tracer.colorConsole()
const isNotEmpty = negate(isEmpty)

export interface UPMMainServiceConfig {}

export type UPMMainServiceOptions = Partial<UPMMainServiceConfig>

export class UPMMainService<
  ReqMap extends UPM.MessageRequestMap = any,
  MType extends UPM.MessageRequestNames<ReqMap> = UPM.MessageRequestNames<ReqMap>
> implements UPM.IMessageClient<
  ReqMap, MType
> {
  private readonly config_: UPMMainServiceConfig

  private readyDeferred_: Deferred<this> = null

  private killDeferred_: Deferred<number> = null

  private lastMessageId_ = 0

  private childProcess_: UtilityProcess = null

  private pendingMessages_ = new Map<number, UPM.PendingRequestMessage>()

  private messageChannels_ = new Map<string, MessageChannelMain>()

  private async init(): Promise<this> {
    let deferred = this.readyDeferred_
    if (deferred) {
      return deferred.promise
    }
    deferred = this.readyDeferred_ = new Deferred()

    try {
      const exitListener = (code: number) => {
        if (code !== 0) {
          deferred.reject(new Error(`process exited with code ${code} upon starting`))
        }
      }
      const spawnListener = async () => {
        this.childProcess_.off("exit", exitListener)
        this.childProcess_.on("message", this.onMessage.bind(this))
        deferred.resolve(this)
      }

      this.childProcess_ = utilityProcess
        .fork(this.entryFile, [], {
          serviceName: this.serviceName,
          env: {
            ...process.env,
            IN_CHILD_PROCESS: "true",
            APP_NAME: app.name
          }
        })
        .on("spawn", spawnListener)
        .on("exit", exitListener)

      await deferred.promise
    } catch (err) {
      deferred.reject(err)
    }
    
    return deferred.promise
  }

  private onMessage<Type extends MType = any>(payload: UPM.Message<ReqMap, Type>) {
    const { type, kind, messageId, result, error } = payload

    try {
      const pending = this.pendingMessages_.get(messageId)
      if (!pending) {
        log.info(`Unable to find pending record ${messageId}`)
        return
      }

      if (pending.deferred.isSettled()) {
        log.error(`Already settled record ${messageId}`)
        return
      }

      this.removePendingMessage(messageId)
      if (!!error) {
        log.error(error)
        pending.deferred.reject(new Error(error))
        return
      }
      pending.deferred.resolve(result)
    } catch (err) {
      log.error(`Failed to handle message`, err)
    }
  }
  
  
  /**
   * Resolves when ready
   *
   * @returns {any}
   */
  whenReady(): Promise<UPM.IMessageClient<ReqMap, MType>> {
    return this.init()
  }
  
  /**
   * Return a simple proxy facade wrapping
   * `executeRequest` into individual methods
   */
  getServiceClient(): IServiceClient<ReqMap, MType> {
    return new Proxy<IServiceClient<ReqMap, MType>>({} as any, {
      get: (_target, prop) => {
        if (prop === "then") {
          return undefined
        }
        return (...args: any[]) => this.whenReady()
          .then(client => client.executeRequest(prop as MType, ...args as any))
        
      }
    })
  }

  /**
   * Returned client side port (for Renderer)
   * @param clientId
   */
  createMessageChannel(clientId: string): MessagePortMain {
    assert(
      this.readyDeferred_?.isFulfilled() ?? false,
      `Service (${this.serviceName}) is not fulfilled or has an error (${this.readyDeferred_.status()})`
    )
    const channel = new MessageChannelMain(),
      { port1, port2 } = channel

    this.messageChannels_.set(clientId, channel)
    try {
      this.childProcess_.postMessage(
        {
          message: {
            channel: UPM.IPCChannel.UPMServiceNewClient,
            payload: { clientId }
          }
        },
        [port1]
      )
    } catch (err) {
      log.error(`Unable to create channel id=${clientId}`, err)
      this.closeMessageChannel(clientId, channel)
      throw err
    }
    return port2
  }
  
  /**
   * Create a port client for the main process
   * (useful to avoid congestion on default child_process channel)
   *
   * @param {string} clientId
   * @returns {UPM.MessagePortClient<MessageRequestMap, MessageType>}
   */
  createMainClient(clientId: string): UPM.MessagePortClient<ReqMap, MType> {
    return new UPM.MessagePortClient(clientId, this.createMessageChannel(clientId))
  }

  private onPortClose(id: string, channel: MessageChannelMain) {
    log.info(`main side of message channel(id=${id}) closed`)
    this.closeMessageChannel(id, channel)
  }

  private closeMessageChannel(id: string, channel: MessageChannelMain) {
    if (this.messageChannels_.has(id)) {
      this.messageChannels_.delete(id)
    }

    ;[channel.port1,channel.port2].forEach(p => getValue(() => p.close()))
  }

  close(): void {
    log.warn("Close has no effect when called via the main process")
  }

  /**
   * Send an event as `fire-and-forget`
   *
   * @param data
   * @param port
   */
  sendEvent(data: any, port: UPM.Port = this.childProcess_): void {
    const messageId = this.generateMessageId()
    const payload: UPM.NodeEnvelope = {
      channel: UPM.IPCChannel.UPMServiceMessage,
      payload: { messageId, data, kind: UPM.MessageKind.Event }
    }

    port.postMessage(payload)
  }

  /**
   * Send request
   *
   * @param type
   * @param args
   */
  async executeRequest<
    Type extends MType,
    R extends UPM.MessageRequestReturnType<ReqMap,Type> = UPM.MessageRequestReturnType<ReqMap,Type>
  >(
    type: Type,
    ...args: UPM.MessageRequestParams<ReqMap, Type>
  ): Promise<R> {
    assert(!!this.childProcess_, "The process is not running")
    const messageId = this.generateMessageId(),
      pending: UPM.PendingRequestMessage<ReqMap, Type, R> = {
        deferred: new Deferred<R>(),
        messageId,
        timeoutId: setTimeout(() => this.removePendingMessage(messageId), UPM.Defaults.RequestTimeout)
      }

    this.pendingMessages_.set(messageId, pending)
    const payload: UPM.NodeMessage<ReqMap, Type> = {
      channel: UPM.IPCChannel.UPMServiceMessage,
      payload: { type, messageId, args, kind: UPM.MessageKind.Request }
    }

    this.childProcess_.postMessage(payload)

    try {
      const result = await pending.deferred.promise
      log.debug(`Completed utility request (messageId=${messageId})`)
      return result
    } catch (err) {
      log.error(`Failed utility request (messageId=${messageId})`, err)
      throw err
    }
  }

  async stop(): Promise<void> {
    await this.kill()
  }

  private async kill(): Promise<number> {
    if (!this.readyDeferred_) {
      return
    }

    let killDeferred = this.killDeferred_
    if (killDeferred) {
      return killDeferred.promise
    }

    if (!this.readyDeferred_.isSettled()) {
      await this.readyDeferred_.promise.catch(err => log.error(`ignoring error`, err))
    }

    const process = this.childProcess_
    if (!process) {
      log.error("The process is not running")
      return 0
    }

    this.cancelAllPendingMessages()
    this.removeAllMessageChannels()
    killDeferred = this.killDeferred_ = new Deferred<number>()
    try {
      process.once("exit", (code: number) => {
        if (code !== 0) {
          log.error(`Process exited with code ${code} upon stopping`)
        }
        killDeferred.resolve(code)
      })
      process.kill()
    } catch (err) {
      log.error("Unable to kill utility process", err)
      killDeferred.reject(err)
    }

    return await killDeferred.promise
  }

  private removeAllMessageChannels() {
    for (const [id, channel] of [...this.messageChannels_.entries()]) {
      this.closeMessageChannel(id, channel)
    }
  }

  private cancelAllPendingMessages(): void {
    for (const key of [...this.pendingMessages_.keys()]) {
      this.removePendingMessage(key)
    }
  }

  constructor(
    readonly serviceName: string,
    readonly entryFile: string,
    options: UPMMainServiceOptions = {}
  ) {
    //super()
    assert(
      isString(entryFile) && isNotEmpty(entryFile) && Fsx.existsSync(entryFile),
      `entry file must be provided (${entryFile})`
    )

    this.config_ = {
      ...options
    }

    this.init().catch(err => {
      log.error(`Failed to init utility process`, err)
    })
  }

  private removePendingMessage(messageId: number): void {
    const pending = this.pendingMessages_.get(messageId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeoutId)
    if (!pending.deferred.isSettled()) {
      pending.deferred.reject("The pending message is being removed before promise is settled")
    }
    this.pendingMessages_.delete(messageId)
  }

  private generateMessageId(): number {
    return this.lastMessageId_++
  }

  async [Symbol.asyncDispose]() {
    await this.stop()
  }
}

export default UPMMainService