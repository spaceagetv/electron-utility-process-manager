import type { UtilityProcess } from "electron"
import { isDefined, isFunction, isString } from "@3fv/guard"
import { Deferred } from "@3fv/deferred"
import Tracer from "tracer"

const log = Tracer.colorConsole()

export namespace UPM {
  
  export const Defaults = { RequestTimeout: 120000 }
  
  export enum MessageKind {
    Event = "Event",
    Request = "Request",
    Response = "Response"
  }
  
  export enum IPCChannel {
    UPMServiceMessage = "UPMServiceMessage",
    UPMServiceNewClient = "UPMServiceNewClient"
  }
  
  export enum NodeMessageType {
    UPMNodeEventMessage = "UPMNodeEventMessage",
    UPMNodeRequestResponse = "UPMNodeRequestResponseMessage",
  }
  
  export type MessageRequestFnBase = (...args:any[]) => Promise<any>
  export type MessageRequestMap = {}
  export type MessageRequestNames<ReqMap extends MessageRequestMap> = keyof ReqMap
  export type MessageRequestFn<ReqMap extends MessageRequestMap, Name extends MessageRequestNames<ReqMap>> = ReqMap[Name] extends MessageRequestFnBase ? ReqMap[Name] : never
  export type MessageRequestParams<ReqMap extends MessageRequestMap, Name extends MessageRequestNames<ReqMap>> = ReqMap[Name] extends MessageRequestFnBase ? Parameters<ReqMap[Name]> : never
  export type MessageRequestReturnType<ReqMap extends MessageRequestMap, Name extends MessageRequestNames<ReqMap>> = ReqMap[Name] extends MessageRequestFnBase ? ReturnType<ReqMap[Name]> : never
  
  export interface Message<
    ReqMap extends MessageRequestMap = any,
    Type extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>,
    Args extends MessageRequestParams<ReqMap, Type> = MessageRequestParams<ReqMap, Type>,
    R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
  >
  {
    type: Type;
    kind: MessageKind;
    messageId: number;
    //data?: any
    eventData?: any
    args?: Args
    result?: R
    error?: string
  }
  
  export interface NodeEnvelope<Payload extends {} = any> {
    channel: IPCChannel
    payload: Payload
  }
  
  export type RequestHandler<
    ReqMap extends MessageRequestMap = any,
    Type extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>,
    Args extends MessageRequestParams<ReqMap, Type> = MessageRequestParams<ReqMap, Type>,
    R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
  > = (type: Type, messageId: number, ...args: Args) => Promise<R>
  
  
  export type NodeMessage<
    ReqMap extends MessageRequestMap = any,
    Type extends MessageRequestNames<ReqMap> = MessageRequestNames<ReqMap>> = NodeEnvelope<Message<ReqMap, Type>>
  
  export interface PendingRequestMessage<
    ReqMap extends UPM.MessageRequestMap = any,
    Type extends UPM.MessageRequestNames<ReqMap> = UPM.MessageRequestNames<ReqMap>,
    R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
  >
  {
    deferred: Deferred<R>
    
    timeoutId: ReturnType<typeof setTimeout>
    
    messageId: number
  }
  
  /**
   * @returns true if payload was handled, false if not
   */
  export type EventHandler = (clientId: string, port: UPM.Port, payload: any) => boolean
  
  export function isMessagePort(port: UPM.Port): port is Electron.MessagePortMain {
    return isFunction(port?.["close"])
  }
  
  export function isUtilityProcess(port: UPM.Port): port is UtilityProcess {
    return !!port && !isMessagePort(port)
  }
  
  export type Port = MessagePort | Electron.MessagePortMain | Electron.ParentPort | UtilityProcess
  
  export interface IServiceClient<
    ReqMap extends MessageRequestMap,
    MType extends MessageRequestNames<ReqMap> = UPM.MessageRequestNames<ReqMap>
  >
  {
    sendEvent(data: any): void
    
    executeRequest<
      Type extends MType,
      R extends MessageRequestReturnType<ReqMap, Type> = MessageRequestReturnType<ReqMap, Type>
    >(
      type: Type,
      ...args: MessageRequestParams<ReqMap, Type>
    ): Promise<R>
    
    close(): void
    
    whenReady(): Promise<IServiceClient<ReqMap, MType>>
  }
  
  //
  export class PortServiceClient<
    ReqMap extends MessageRequestMap,
    MType extends MessageRequestNames<ReqMap> = UPM.MessageRequestNames<ReqMap>
  > implements IServiceClient<ReqMap, MType> {
    
    private lastMessageId_: number = 0
    
    private pendingMessages_ = new Map<number, PendingRequestMessage>()
    
    private generateMessageId(): number {
      return this.lastMessageId_++
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
    
    private onMessage<Type extends MType = any>(payloadOrEnvelopeOrData: any): void {
      const
        payloadOrEnvelope = (isDefined(payloadOrEnvelopeOrData?.["data"]) ?
          payloadOrEnvelopeOrData["data"] :
          payloadOrEnvelopeOrData) as UPM.Message<ReqMap, Type> | UPM.NodeMessage<ReqMap, Type>,
        [channel, payload] =
          (isDefined(payloadOrEnvelope?.["payload"]) ?
          [payloadOrEnvelope["channel"] ?? IPCChannel.UPMServiceMessage, payloadOrEnvelope["payload"]] :
          [IPCChannel.UPMServiceMessage, payloadOrEnvelope]) as [string, UPM.Message<ReqMap, Type>],
        { type, kind, messageId, result, error } = payload
      
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
      const payload: UPM.NodeEnvelope = {
        channel: UPM.IPCChannel.UPMServiceMessage,
        payload: { messageId, data, kind: UPM.MessageKind.Event }
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
        pending: UPM.PendingRequestMessage<ReqMap, Type, R> = {
          deferred: new Deferred<R>(),
          messageId,
          timeoutId: setTimeout(() => this.removePendingMessage(messageId), Defaults.RequestTimeout)
        }
      
      this.pendingMessages_.set(messageId, pending)
      const payload: UPM.NodeMessage<ReqMap, Type> = {
        channel: UPM.IPCChannel.UPMServiceMessage,
        payload: { type, messageId, args, kind: UPM.MessageKind.Request }
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
    
    constructor(readonly clientId: string, readonly port: UPM.Port) {
      if (isMessagePort(port) || isUtilityProcess(port)) {
        if (isFunction(port?.["addEventListener"])) {
          ;(port as any).addEventListener("message", this.onMessage.bind(this))
        } else {
          port.on("message", this.onMessage.bind(this))
        }
        if (isMessagePort(port))
          port.start()
      } else {
        log.error("Invalid port", port)
        throw new Error("Invalid port")
      }
      
    }
  }
}