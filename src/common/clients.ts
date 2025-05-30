import { isDefined, isFunction } from "@3fv/guard"
import { isMessagePort, isUtilityProcess } from "./guards.js"
import Tracer from "tracer"
import {
  Defaults,
  IPCChannel,
  Message, MessageKind, MessageRequestFn,
  MessageRequestMap,
  MessageRequestNames,
  MessageRequestParams,
  MessageRequestReturnType, NodeEnvelope, NodeMessage,
  PendingRequestMessage, Port
} from "./types.js"
import { Deferred } from "@3fv/deferred"

const log = Tracer.colorConsole()

/**
 * Service client interface maps a `MessageRequestMap`
 * to its functional methods
 */
export type IServiceClient<
  ReqMap extends MessageRequestMap,
  MType extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>
> = { [Type in MType]: MessageRequestFn<ReqMap, Type> }

/**
 * Messaging client interface
 */
export interface IMessageClient<
  ReqMap extends MessageRequestMap,
  MType extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>
>
{

  /**
   * Get the clientId for the underlying port
   */
  get clientId(): string

  /**
   * A very low level function for sending `any` data
   * to the `utilityProcess`
   *
   * @param data
   */
  sendEvent(data: any): void

  /**
   * Execute a request, with a response expected
   *
   * @param type
   * @param args determined by the typed `MessageRequestMap` & `Type` parameters
   */
  executeRequest<
    Type extends MType,
    R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
  >(
    type: Type,
    ...args: MessageRequestParams<ReqMap, Type>
  ): Promise<R>

  /**
   * Close the message client
   */
  close(): void

  /**
   * Resolve when client is ready to use
   */
  whenReady(): Promise<IMessageClient<ReqMap, MType>>

  /**
   * Get service client from message client
   */
  getServiceClient(): IServiceClient<ReqMap, MType>
}

/**
 * Generic `MessagePort` client implementation, which
 * is functional in any process.
 *
 * > NOTE: Aside from the main & renderer processes,
 * >   an `utilityProcess` could potentially also
 * >   use this client to communicate with a separate
 * >   `utilityProcess`
 */
export class MessagePortClient<
  ReqMap extends MessageRequestMap,
  MType extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>
> implements IMessageClient<ReqMap, MType> {

  /**
   * Used to generate IDS
   *
   * @private
   */
  private idSequence_: number = 0

  /**
   * A `Map` responsible for mapping `messageId`
   * values to a `PendingRequestMessage`
   *
   * @private
   */
  private readonly pendingMessages_ = new Map<number, PendingRequestMessage>()

  /**
   * Get the next `messageId`
   *
   * @returns {number}
   * @private
   */
  private generateMessageId(): number {
    return this.idSequence_++
  }

  /**
   * Remove a pending message mapping based on supplied ID
   *
   * @param {number} messageId
   * @private
   */
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

  /**
   * Handle messages posted by the `utilityProcess` via
   * either `process.parentPort` or a specific `MessagePort`
   *
   * @param payloadOrEnvelopeOrData
   * @private
   */
  private onMessage<Type extends MType = any>(payloadOrEnvelopeOrData: any): void {
    const
      // FIND THE `Message | NodeMessage` DEPENDING
      // ON THE PROCESS AND TRANSPORT
      payloadOrEnvelope = (
        isDefined(payloadOrEnvelopeOrData?.["data"]) ?
          payloadOrEnvelopeOrData["data"] :
          payloadOrEnvelopeOrData
      ) as Message<ReqMap, Type> | NodeMessage<ReqMap, Type>,

      // FIND THE CHANNEL & PAYLOAD DEPENDING ON THE PROCESS & TRANSPORT
      [channel, payload] =
        (
          isDefined(payloadOrEnvelope?.["payload"]) ?
            [payloadOrEnvelope["channel"] ?? IPCChannel.UPMServiceMessage, payloadOrEnvelope["payload"]] :
            [IPCChannel.UPMServiceMessage, payloadOrEnvelope]
        ) as [string, Message<ReqMap, Type>],
      { messageId, result, error } = payload

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

      if (!!error) {
        log.error(error)
        pending.deferred.reject(new Error(error))
        return
      }
      pending.deferred.resolve(result)
      this.removePendingMessage(messageId)
    } catch (err) {
      log.error(`Failed to handle message`, err)
    }
  }


  sendEvent(data: any): void {
    const messageId = this.generateMessageId()
    const payload: NodeEnvelope = {
      channel: IPCChannel.UPMServiceMessage,
      payload: { messageId, eventData: data, kind: MessageKind.Event }
    }

    this.port.postMessage(payload)
  }

  async executeRequest<
    Type extends MType,
    R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
  >(
    type: Type,
    ...args: MessageRequestParams<ReqMap, Type>
  ): Promise<R> {
    const messageId = this.generateMessageId(),
      pending: PendingRequestMessage<ReqMap, Type, R> = {
        deferred: new Deferred<R>(),
        messageId,
        timeoutId: setTimeout(() => this.removePendingMessage(messageId), Defaults.RequestTimeout)
      }

    this.pendingMessages_.set(messageId, pending)
    const payload: NodeMessage<ReqMap, Type> = {
      channel: IPCChannel.UPMServiceMessage,
      payload: { type, messageId, args, kind: MessageKind.Request }
    }

    this.port.postMessage(payload)

    try {
      const result = await pending.deferred.promise
      log.debug(`Completed utility request (messageId=${messageId})`)
      return result
    } catch (err) {
      log.error(`Failed utility request (messageId=${messageId})`, err)
      throw err
    }
  }

  close(): void {
  }

  whenReady(): Promise<this> {
    return Promise.resolve(this)
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
   * Create a new `MessagePortClient`
   *
   * @param clientId
   * @param port
   */
  constructor(readonly clientId: string, readonly port: Port) {
    if (!isMessagePort(port) &&  !isUtilityProcess(port)) {
      log.error("Invalid port", port)
      throw new Error("Invalid port")
    }
    // check if we're in the renderer, in which case we use addEventListener. We could probably use
    // an isEventTarget guard that would work better here. Alternatively, we would implement a base class
    // and implement node, main, and browser versions of this class.
    if (isFunction(port?.["addEventListener"])) {
      ;(
        port as any
      ).addEventListener("message", this.onMessage.bind(this))
    } else {
      port.on("message", this.onMessage.bind(this))
    }
    if (isMessagePort(port))
      port.start()

  }
}